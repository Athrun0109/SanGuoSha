/**
 * 启动向导 —— `npm start`
 *
 * 一路问下来:玩什么模式 → 要不要用大模型 → (要的话)API key 和模型 → 人数/座位/点将,然后开局。
 * 用大模型时默认走 OpenRouter,key 可以存进 .env 下次不用再输。
 */

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec, DUEL_HANDICAP } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo } from '../ai/llmAgent.js';
import { HumanAgent, closeCli, askLine, askSecret } from './humanAgent.js';
import { pickGenerals } from './generals.js';
import { loadEnv, saveEnv, ENV_FILE } from './env.js';
import { ROLE_NAME } from '../core/types.js';
import type { Agent } from '../core/agent.js';

loadEnv();

// —————————————————— 小工具 ——————————————————

async function menu(title: string, items: string[], def = 0): Promise<number> {
  console.log(`\n${title}`);
  items.forEach((s, i) => console.log(`   ${i + 1}. ${s}`));
  for (;;) {
    const a = await askLine(`> (回车=${def + 1}) `);
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    console.log(`   请输入 1~${items.length}`);
  }
}

async function askNumber(q: string, def: number, lo: number, hi: number): Promise<number> {
  for (;;) {
    const a = await askLine(`${q} (回车=${def}) `);
    if (!a) return def;
    const n = Number(a);
    if (Number.isInteger(n) && n >= lo && n <= hi) return n;
    console.log(`   请输入 ${lo}~${hi} 之间的整数`);
  }
}

async function confirm(q: string, def = true): Promise<boolean> {
  const a = (await askLine(`${q} (${def ? 'Y/n' : 'y/N'}) `)).toLowerCase();
  if (!a) return def;
  return a === 'y' || a === 'yes';
}

const mask = (k: string) => (k.length <= 12 ? '*'.repeat(k.length) : `${k.slice(0, 6)}…${k.slice(-4)}`);

// —————————————————— 模型选择 ——————————————————

interface ModelInfo { id: string; ctx: number; inPrice: number; outPrice: number; structured: boolean }

/** 兜底清单:拉不到模型列表时用(比如断网) */
const FALLBACK_MODELS: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4-flash', ctx: 1048576, inPrice: 0.14, outPrice: 0.28, structured: true },
  { id: 'deepseek/deepseek-v4-pro', ctx: 1048576, inPrice: 0.435, outPrice: 0.87, structured: true },
];

export function pickRecommended(all: ModelInfo[], n = 8): ModelInfo[] {
  // 只推荐支持 structured_outputs 的 —— 本项目靠它保证模型返回合法 JSON
  const ok = all.filter(m => m.structured);
  const deepseek = ok.filter(m => m.id.startsWith('deepseek/')).sort((a, b) => a.inPrice - b.inPrice);
  const rest = ok.filter(m => !m.id.startsWith('deepseek/')).sort((a, b) => a.inPrice - b.inPrice);
  const out: ModelInfo[] = [];
  for (const m of [...deepseek, ...rest]) {
    if (out.length >= n) break;
    out.push(m);
  }
  return out;
}

async function fetchModels(): Promise<ModelInfo[]> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) return FALLBACK_MODELS;
    const data = (await res.json() as any).data ?? [];
    return data.map((m: any): ModelInfo => ({
      id: m.id,
      ctx: m.context_length ?? 0,
      inPrice: Number(m.pricing?.prompt ?? 0) * 1e6,
      outPrice: Number(m.pricing?.completion ?? 0) * 1e6,
      structured: (m.supported_parameters ?? []).includes('structured_outputs'),
    }));
  } catch {
    return FALLBACK_MODELS;
  }
}

async function setupLLM(): Promise<{ client: any; model: string } | null> {
  console.log('\n—— 大模型设置(OpenRouter)——');

  let key = process.env.OPENROUTER_API_KEY ?? '';
  if (key) {
    console.log(`已找到 API key:${mask(key)}`);
    if (!await confirm('用这个 key?', true)) key = '';
  }
  if (!key) {
    console.log('去 https://openrouter.ai/keys 申请,粘贴进来(输入时不回显):');
    key = await askSecret('OpenRouter API key > ');
    if (!key) { console.log('没有 key,改用规则 AI。'); return null; }
    process.env.OPENROUTER_API_KEY = key;
    if (await confirm(`存到 ${ENV_FILE} 以后不用再输?`, true)) {
      saveEnv('OPENROUTER_API_KEY', key);
      console.log('已保存(记得别把 .env 提交到 git,已在 .gitignore 里)。');
    }
  }

  console.log('\n正在拉取可用模型…');
  const all = await fetchModels();
  const rec = pickRecommended(all);
  const labels = rec.map(m =>
    `${m.id.padEnd(38)} 入$${m.inPrice.toFixed(3)}/M 出$${m.outPrice.toFixed(3)}/M ctx${Math.round(m.ctx / 1000)}k`);
  const idx = await menu('选一个模型(都支持结构化输出):', [...labels, '手动输入模型 id'], 0);

  let model: string;
  if (idx < rec.length) {
    model = rec[idx].id;
  } else {
    model = await askLine('模型 id(如 deepseek/deepseek-v4-flash)> ');
    if (!model) model = FALLBACK_MODELS[0].id;
    const hit = all.find(m => m.id === model);
    if (hit && !hit.structured) {
      console.log('⚠ 这个模型不支持 structured_outputs,可能返回非法 JSON,会更频繁地走兜底 AI。');
    } else if (!hit && all !== FALLBACK_MODELS) {
      console.log('⚠ 模型列表里没找到这个 id,开局前的探路请求会告诉你对不对。');
    }
  }

  const { createOpenRouterClient } = await import('../ai/openrouterClient.js');
  const client = createOpenRouterClient({
    apiKey: key, appTitle: 'sanguosha-engine',
    onProgress: (sec) => console.log(`  \x1b[90m⏳ 等待模型响应 ${sec}s…\x1b[0m`),
  });

  process.stdout.write('验证 key 和模型…');
  try {
    await client.messages.create({ model, max_tokens: 16, messages: [{ role: 'user', content: '回复 OK' }] });
    console.log(' ✓');
  } catch (e) {
    console.log(' ✗');
    console.log(`调用失败:${e instanceof Error ? e.message : e}`);
    if (!await confirm('还是要继续吗?(失败的决策会自动交给规则 AI)', false)) return null;
  }
  return { client, model };
}

// —————————————————— 主流程 ——————————————————

async function main() {
  console.log('═'.repeat(60));
  console.log('  三国杀 · 标准版');
  console.log('═'.repeat(60));

  const MODES = [
    '我 vs 规则 AI（不需要 API key）',
    '我 vs 大模型',
    '大模型 vs 规则 AI（我观战）',
    '大模型 vs 大模型（我观战）',
    '全规则 AI 观战（看引擎跑一局）',
  ];
  const mode = await menu('玩什么?', MODES, 0);
  const needLLM = mode === 1 || mode === 2 || mode === 3;
  const iPlay = mode === 0 || mode === 1;

  let llm: { client: any; model: string } | null = null;
  if (needLLM) {
    llm = await setupLLM();
    if (!llm) console.log('→ 降级为规则 AI。');
  }

  const players = mode === 1 || mode === 2 || mode === 3
    ? 2                                            // 涉及大模型的都按 1v1 来,省钱也好观察
    : await askNumber('几人局?', 5, 2, 8);
  const seat = iPlay ? await askNumber('你坐几号位?', 0, 0, players - 1) : -1;

  let fixedGenerals: Record<number, string> | undefined;
  if (await confirm('要手动点将吗?', false)) {
    const seats = Array.from({ length: players }, (_, i) => ({
      seat: i, label: i === seat ? `${i}号位(你)` : `${i}号位`,
    }));
    fixedGenerals = await pickGenerals(seats, askLine);
  }

  const seed = await askNumber('随机种子(同一种子牌局一致,便于复盘)', Math.floor(Math.random() * 1e9), 0, 2 ** 31);

  let effort = 'low';
  let quiet = false;
  if (llm) {
    effort = ['low', 'medium', 'high'][await menu('模型思考深度?(越高越强也越慢越贵)', ['low(快)', 'medium', 'high(慢)'], 0)];
    quiet = !(await confirm('打印模型的思考过程?', true));
  }

  // —— 组局 ——
  const llmAgents: LLMAgent[] = [];
  const makeLLM = (id: string): Agent => {
    if (!llm) return new BasicAI(id);
    const a = new LLMAgent(id, {
      client: llm.client, model: llm.model, effort: effort as any,
      onDecision: (info: DecisionInfo) => {
        if (quiet) return;
        const tag = info.usedFallback
          ? `\x1b[31m兜底 ← ${info.error ?? '未知原因'}\x1b[0m`
          : `\x1b[36m${info.thinking}\x1b[0m`;
        console.log(`  [${info.agentId}] ${tag}`);
      },
    });
    llmAgents.push(a);
    return a;
  };

  const game = createGame({
    playerCount: players,
    seed,
    fixedGenerals,
    log: (m) => console.log(m),
    makeAgent: (_p, i): Agent => {
      if (i === seat) return new HumanAgent('you');
      if (mode === 1) return makeLLM('llm');                       // 我 vs 大模型
      if (mode === 2) return i === 0 ? makeLLM('llm') : new BasicAI(`rule${i}`);
      if (mode === 3) return makeLLM(`llm-${i}`);
      return new BasicAI(`rule${i}`);
    },
  });

  console.log('\n' + '═'.repeat(60));
  console.log(`${players} 人局  seed=${seed}` +
    (llm ? `  模型=${llm.model} effort=${effort}` : '  纯规则 AI') +
    (players === 2 ? `  后手补牌+${DUEL_HANDICAP}` : ''));
  for (const p of game.players) {
    const tag = p.seat === seat ? '(你)' : '';
    console.log(`  [${p.seat}] ${p.general.name}${tag} ${p.maxHp}血 起手${p.handCount}张` +
      (p.seat === seat || p.role === 'lord' ? ` 身份:${ROLE_NAME[p.role]}` : ''));
  }
  console.log('═'.repeat(60));
  if (seat >= 0) console.log('提示:任何时候输入 0 都可以查看局势,不消耗你的行动。\n');

  const res = await game.setupAndRun();

  console.log('\n最终局面:');
  console.log(game.board(true));
  if (seat >= 0) {
    const me = game.players[seat];
    console.log(`\n你(${ROLE_NAME[me.role]})${res.winners.includes(me) ? '赢了 🎉' : '输了'}`);
  }
  for (const a of llmAgents) {
    const s = a.stats;
    console.log(`  ${a.id}:${s.calls} 次调用,兜底 ${s.fallbacks} 次,` +
      `输入 ${s.inputTokens} / 输出 ${s.outputTokens} tokens`);
  }
  closeCli();
}

// 只有直接运行才启动向导 —— 测试会 import 本模块里的纯函数
if (process.argv[1]?.endsWith('start.ts')) {
  main().catch(e => { console.error(e); closeCli(); process.exit(1); });
}
