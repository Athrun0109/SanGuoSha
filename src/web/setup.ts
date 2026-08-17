/**
 * 设置页的接口。
 *
 * —————— 关于 API key,这里是唯一的出入口,规矩写死在这 ——————
 *
 *  1. key **只从 POST body 进来**,绝不走 URL query —— query 会落进浏览器历史。
 *  2. 进来之后直接写 `.env` 和 `process.env`,**任何响应里都只回掩码**
 *     (`sk-or-…a1b2`)。原始 key 一个字节都不出站。
 *  3. 不进 SSE 快照、不进记录器。
 *
 * 第 2 条有测试守着(`setup.test.ts`)。这和 `web/state.ts` 挡手牌是同一个套路:
 * **所有出站数据只经过一个函数**,泄密就只可能发生在那一个地方。
 *
 * 服务器绑在 127.0.0.1(见 server.ts 的 listen),所以这个页面只有本机能访问。
 */

import * as http from 'node:http';
import { readBody, sendJson, type ApiHandler } from './server.js';
import { normalizeConfig, type GameConfig } from './config.js';
import { fetchModels, pickRecommended } from '../ai/modelList.js';
import { preflight } from '../ai/preflight.js';
import { saveEnv, ENV_FILE } from '../cli/env.js';
import { generals } from '../core/registry.js';
import { ROLE_TABLE } from '../core/setup.js';
import { ROLE_NAME } from '../core/types.js';

/** 掩码。短到藏不住的就整条打星,别露出前 6 位 */
export function maskKey(k: string): string {
  if (!k) return '';
  return k.length <= 12 ? '*'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

export interface SetupDeps extends SessionDeps {
  /** 用户点「开始对局」时调用。抛错会原样回给页面 */
  onStart: (cfg: GameConfig) => Promise<void> | void;
}

export interface SessionDeps {
  /** 浏览器提交决策。返回错误说明,或 null 表示收下了 */
  onDecide?: (choice: number[]) => string | null;
  /**
   * 重开一局:放弃当前这局,回到能再开一局的状态。
   * 返回的 go 是让浏览器跳转的地址(设置页那条路要回 `/` 重新配);
   * 不返回就留在原地等新一局的快照推过来。
   */
  onReset?: () => Promise<{ go?: string } | void> | { go?: string } | void;
  /** 结束进程,等同于命令行里的 Ctrl+C */
  onQuit?: () => Promise<void> | void;
}

/**
 * 对局中的控制接口:出牌、重开、结束。
 *
 * `npm run ui` 直接开局,不需要设置页那一堆接口,但这三样都要 —— 所以单独拆出来,
 * 两个入口共用同一份校验和错误措辞。
 */
export function sessionApi(deps: SessionDeps): ApiHandler {
  return async (req, res, url) => {
    if (req.method !== 'POST') return false;

    if (url === '/api/decide') {
      if (!deps.onDecide) { sendJson(res, 400, { error: '这一局没有网页座位' }); return true; }
      const body = JSON.parse(await readBody(req) || '{}');
      if (!Array.isArray(body.choice)) { sendJson(res, 400, { error: 'choice 必须是数组' }); return true; }
      const err = deps.onDecide(body.choice);
      if (err) sendJson(res, 400, { error: err });
      else sendJson(res, 200, { ok: true });
      return true;
    }

    if (url === '/api/reset') {
      if (!deps.onReset) { sendJson(res, 400, { error: '这个入口不支持重开' }); return true; }
      const r = await deps.onReset();
      sendJson(res, 200, { ok: true, ...(r ?? {}) });
      return true;
    }

    if (url === '/api/quit') {
      if (!deps.onQuit) { sendJson(res, 400, { error: '这个入口不支持结束进程' }); return true; }
      // 先把响应发出去再退 —— 不然浏览器只会看到连接被掐断,分不清是退出还是崩了
      sendJson(res, 200, { ok: true });
      res.on('finish', () => { void deps.onQuit!(); });
      return true;
    }

    return false;
  };
}

export function setupApi(deps: SetupDeps) {
  let started = false;
  const session = sessionApi({
    ...deps,
    // 重开之后要能再开一局,所以这道闸门得跟着放开
    onReset: deps.onReset && (async () => {
      const r = await deps.onReset!();
      started = false;
      return r ?? { go: '/' };
    }),
  });

  return async function api(
    req: http.IncomingMessage, res: http.ServerResponse, url: string,
  ): Promise<boolean> {
    if (!url.startsWith('/api/')) return false;

    // ——— 武将清单:直接从注册表读,不用维护第二份 ———
    if (url === '/api/generals' && req.method === 'GET') {
      sendJson(res, 200, {
        roles: Object.fromEntries(
          Object.entries(ROLE_TABLE).map(([n, rs]) => [n, rs.map(r => ({ id: r, name: ROLE_NAME[r] }))]),
        ),
        generals: [...generals.values()].map(g => ({
          name: g.name, kingdom: g.kingdom, gender: g.gender, hp: g.hp,
          skills: g.skills.filter(s => s.desc).map(s => ({ name: s.name, desc: s.desc })),
        })),
      });
      return true;
    }

    // ——— 模型列表:OpenRouter 的公开接口,不需要 key ———
    if (url === '/api/models' && req.method === 'GET') {
      const all = await fetchModels();
      sendJson(res, 200, { recommended: pickRecommended(all, 12), total: all.length });
      return true;
    }

    // ——— key 状态:只回掩码和一个布尔,永远不回原文 ———
    if (url === '/api/key' && req.method === 'GET') {
      const k = process.env.OPENROUTER_API_KEY ?? '';
      sendJson(res, 200, { configured: !!k, masked: maskKey(k), envFile: ENV_FILE });
      return true;
    }

    if (url === '/api/key' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) { sendJson(res, 400, { error: 'key 不能为空' }); return true; }
      process.env.OPENROUTER_API_KEY = key;
      if (body.save !== false) saveEnv('OPENROUTER_API_KEY', key);
      // 注意这里回的是掩码 —— 页面拿不到原文,刷新之后也只看得到掩码
      sendJson(res, 200, { configured: true, masked: maskKey(key), saved: body.save !== false });
      return true;
    }

    // ——— 探路:凭据 + 网络 + 模型名,一次性验完 ———
    if (url === '/api/preflight' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) { sendJson(res, 400, { error: '没有指定模型' }); return true; }
      if (!process.env.OPENROUTER_API_KEY) {
        sendJson(res, 200, { ok: false, error: '还没有配置 API key' });
        return true;
      }
      try {
        const { createOpenRouterClient } = await import('../ai/openrouterClient.js');
        const client = createOpenRouterClient({ appTitle: 'sanguosha-engine' });
        sendJson(res, 200, await preflight(client, model));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return true;
    }

    // ——— 开局 ———
    if (url === '/api/start' && req.method === 'POST') {
      if (started) { sendJson(res, 409, { error: '这一局已经开始了。要换配置请重启 npm start' }); return true; }
      let cfg: GameConfig;
      try {
        cfg = normalizeConfig(JSON.parse(await readBody(req) || '{}'));
      } catch (e) {
        // 校验错误是用户的输入问题,原样告诉他哪里不对
        sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
        return true;
      }
      if (cfg.seats.some(s => s.control === 'llm') && !process.env.OPENROUTER_API_KEY) {
        sendJson(res, 400, { error: '有席位选了大模型,但还没有配置 API key' });
        return true;
      }
      started = true;
      try {
        await deps.onStart(cfg);
      } catch (e) {
        started = false;
        sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        return true;
      }
      sendJson(res, 200, { ok: true, seed: cfg.seed });
      return true;
    }

    // ——— 出牌 / 重开 / 结束 ———
    if (await session(req, res, url)) return true;

    sendJson(res, 404, { error: `没有这个接口:${url}` });
    return true;
  };
}
