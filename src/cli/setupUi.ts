/**
 * 网页版开局设置 —— `npm start`(终端向导用 `npm start -- --cli`)。
 *
 * 流程:起本地服务 → 浏览器打开设置页 → 你配好点「开始对局」→ 服务端建局开跑,
 * 页面跳到 /board 继续观战。设置页和棋盘是同一个服务、同一个进程。
 *
 * 现在人类席位还落不到网页上(棋盘那边还没做输入),所以选了「你」的席位会
 * 回落到**终端出牌**,网页当观战板用。观战类模式(模型 vs 规则AI、模型互搏)
 * 是完整可用的 —— 那本来就是这个平台的主线。
 */

import { loadEnv } from './env.js';
loadEnv();

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent } from '../ai/llmAgent.js';
import { closeCli } from './humanAgent.js';
import { GameAborted, WebAgent } from '../web/webAgent.js';
import { snapshot } from '../web/state.js';
import { paced } from '../web/paced.js';
import { openBrowser, startViewer } from '../web/server.js';
import { setupApi } from '../web/setup.js';
import { splitFixed, startingHandOf, type GameConfig } from '../web/config.js';
import { Recorder } from '../log/recorder.js';
import { ROLE_NAME } from '../core/types.js';
import type { Agent } from '../core/agent.js';
import type { Game } from '../core/game.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SETUP_PAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'setup.html');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

async function run(
  cfg: GameConfig,
  view: Awaited<ReturnType<typeof startViewer>>,
  setSeat: (a: WebAgent | null) => void,
) {
  const { fixedGenerals, fixedRoles } = splitFixed(cfg);
  const rec = cfg.record ? new Recorder() : null;
  // 每次调用的耗时、重试、token 用量都要落盘 —— 排查延迟和兜底全靠它。
  // duel.ts / start.ts 一直接着,这里以前漏了:勾了"记录"却拿不到最该看的那部分数据。
  const recHook = rec?.llmHook();
  const llms: LLMAgent[] = [];

  // 模型客户端按需建一次就够 —— 所有模型席位共用同一个 HTTP 客户端,
  // 模型 id 是每次调用传的,所以不同席位可以用不同模型
  let client: any = null;
  if (cfg.seats.some(s => s.control === 'llm')) {
    const { createOpenRouterClient } = await import('../ai/openrouterClient.js');
    client = createOpenRouterClient({
      appTitle: 'sanguosha-engine',
      // 没有这行的话,模型想久了终端里一片安静,看着就像卡死
      onProgress: (sec) => console.log(`  \x1b[90m⏳ 等待模型响应 ${sec}s…\x1b[0m`),
    });
  }

  let game: Game;
  let seat: WebAgent | null = null;
  const push = (reason = '') => {
    if (!game) return;
    // pending 只在**这题确实属于视角座位**时才带上 —— 传错了等于把别人的
    // 选项(以及从中能反推的手牌)送给这个视角。webAgent 一个座位一个实例,
    // 所以"是不是 viewer 的"就是"这个实例是不是坐在 viewer 上"。
    view.push(snapshot(game, {
      viewer: cfg.viewer, reveal: cfg.reveal, reason,
      pending: seat?.pending ?? null,
    }));
  };
  const recLog = rec?.logFn(m => console.log(m));

  game = createGame({
    playerCount: cfg.playerCount,
    seed: cfg.seed,
    fixedGenerals,
    fixedRoles,
    startingHand: startingHandOf(cfg),
    log: (m) => { (recLog ?? console.log)(m); push(); },
    makeAgent: (_p, i): Agent => {
      const s = cfg.seats[i];
      let base: Agent;
      if (s.control === 'llm') {
        const a = new LLMAgent(`llm-${i}`, {
          client, model: s.model!, effort: s.effort as any, codec: s.codec,
          onDecision: (info) => {
            if (info.usedFallback) console.log(`  [${info.agentId}] 兜底 ← ${info.error ?? '未知'}`);
            recHook?.(info);
          },
        });
        llms.push(a);
        base = a;
      } else if (s.control === 'human') {
        const w = new WebAgent(`you-${i}`, () => push());
        if (i === cfg.viewer) { seat = w; setSeat(w); }
        base = w;
      } else {
        base = new BasicAI(`ai${i}`);
      }
      const withRec = rec ? rec.wrap(base) : base;
      // 模型本身就慢,不用再 sleep;规则 AI 快到看不清,才需要放慢
      const delay = s.control === 'rule' ? cfg.speed : 0;
      return paced(withRec, {
        async before() { if (delay > 0) await sleep(delay); push(); },
      });
    },
  });

  if (rec) { rec.bind(game); rec.start({ ...cfg, source: 'setup-ui' }); }

  console.log(`\n${cfg.playerCount} 人局  seed=${cfg.seed}`);
  for (const p of game.players) {
    const s = cfg.seats[p.seat];
    const who = s.control === 'llm' ? s.model : s.control === 'human' ? '你' : '规则AI';
    console.log(`  [${p.seat}] ${p.general.name} ${p.maxHp}血 ${ROLE_NAME[p.role]}  ← ${who}`);
  }
  if (rec) console.log(`记录中 → ${rec.file}`);
  push();

  const res = await game.setupAndRun();
  setSeat(null);
  rec?.finish({
    reason: res.reason, winners: res.winners.map(p => p.seat), turns: game.turnCount,
    stats: llms.map(a => ({ id: a.id, ...a.stats })),
  });
  rec?.close();
  push(res.reason);

  console.log(`\n${res.reason}(${game.turnCount} 回合)`);
  for (const a of llms) {
    console.log(`  ${a.id}:${a.stats.calls} 次调用,兜底 ${a.stats.fallbacks} 次`);
  }
  if (rec) console.log(`记录 → ${rec.file}`);
  console.log('页面还开着。右上角「退出」或结束浮层里可以「再来一局」/「结束游戏」。');
}

async function main() {
  let view: Awaited<ReturnType<typeof startViewer>>;
  let seat: WebAgent | null = null;
  let generation = 0;      // 重开一次 +1;旧的那局认出自己过期了就安静收场
  const api = setupApi({
    onStart: async (cfg) => {
      const mine = ++generation;
      // 不 await:这个请求要立刻回,让页面跳到 /board 去看棋盘,
      // 否则整局跑完才响应,浏览器早超时了
      run(cfg, view, (a) => { seat = a; }).catch(e => {
        // 点了重开导致的中止是正常收场,别当崩溃处理
        if (e instanceof GameAborted || mine !== generation) return;
        console.error(e);
        process.exit(1);
      });
    },
    onDecide: (choice) => seat ? seat.submit(choice) : '这一局没有网页座位',
    onReset: () => {
      generation++;
      // 必须把挂起的决策兑现掉,否则引擎那条 async 链会永远停在原地
      seat?.abort();
      seat = null;
      console.log('\n已放弃当前对局,回到设置页。');
      return { go: '/' };
    },
    onQuit: async () => {
      console.log('\n收到网页的结束指令,退出。');
      // 同 ui.ts:先收干净再退,别在 HTTP 回调里直接 exit
      seat?.abort();
      closeCli();
      await view.close().catch(() => {});
      setTimeout(() => process.exit(0), 0);
    },
  });

  view = await startViewer({ port: Number(flag('port') ?? 5173), api, page: SETUP_PAGE });
  console.log(`\n开局设置  ${view.url}`);
  console.log('（终端向导:npm start -- --cli）');
  if (flag('no-open') === undefined) openBrowser(view.url);
}

main().catch(e => { console.error(e); closeCli(); process.exit(1); });
