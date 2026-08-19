/**
 * 启动向导 —— `npm start`
 *
 * 一路问下来:玩什么模式 → 要不要用大模型 → (要的话)API key 和模型 → 人数/座位/点将,然后开局。
 * 用大模型时默认走 OpenRouter,key 可以存进 .env 下次不用再输。
 */

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec, DUEL_HANDICAP } from '../core/setup.js';
import { identityMode, team2v2Mode } from '../core/mode.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo } from '../ai/llmAgent.js';
import { HumanAgent, closeCli, askLine, askSecret } from './humanAgent.js';
import { pickGenerals } from './generals.js';
import { loadEnv, saveEnv, ENV_FILE } from './env.js';
import { fetchModels, pickRecommended, FALLBACK_MODELS, type ModelInfo } from '../ai/modelList.js';
import { preflight } from '../ai/preflight.js';
import { ROLE_NAME } from '../core/types.js';
import type { Agent } from '../core/agent.js';
import type { Player } from '../core/player.js';
import { Recorder } from '../log/recorder.js';

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

// 模型列表和网页设置页共用一份 —— 两边各拉一次迟早会对不上
export { pickRecommended } from '../ai/modelList.js';

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
    model = await askLine('模型 id(如 deepseek/deepseek-v4-flash-0731)> ');
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
  const probe = await preflight(client, model);
  if (probe.ok) {
    console.log(` ✓ (${probe.ms}ms)`);
  } else {
    console.log(' ✗');
    console.log(`调用失败:${probe.error}`);
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

  // 对局模式:身份局还是 2v2。2v2 固定 4 人、没有主公、队伍公开
  const rules = await menu('对局模式?', [
    '身份局(主公/忠臣/反贼/内奸,身份要靠猜)',
    '2v2 组队对抗(4 人,两队各 2 人,队伍公开、没有主公)',
  ], 0) === 1 ? team2v2Mode : identityMode;

  const players = rules.name === 'team2v2'
    ? 4
    : mode === 1 || mode === 2 || mode === 3
      ? 2                                          // 涉及大模型的都按 1v1 来,省钱也好观察
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

  // 接了模型就默认记录 —— 出问题时最需要日志的恰恰是这类局,事后补记不上
  const rec = (await confirm('记录这一局?(存到 logs/,可用 npm run log 查、npm run replay 重放)', !!llm))
    ? new Recorder()
    : null;

  // —— 组局 ——
  const llmAgents: LLMAgent[] = [];
  const recHook = rec?.llmHook();
  const makeLLM = (id: string): Agent => {
    if (!llm) return new BasicAI(id);
    const a = new LLMAgent(id, {
      client: llm.client, model: llm.model, effort: effort as any,
      onDecision: (info: DecisionInfo) => {
        recHook?.(info);
        if (quiet) return;
        const tag = info.usedFallback
          ? `\x1b[31m兜底 ← ${info.error ?? '未知原因'}\x1b[0m`
          : `\x1b[36m${info.thinking}\x1b[0m`;
        console.log(`  [${info.agentId}] ${tag}`);
        // 身份判断有变动就报一句 —— 这是多人局里最值得盯的信号
        if (info.reads?.length) {
          console.log(`  \x1b[35m[${info.agentId}] 身份判断 ` +
            info.reads.map(r => `${r.seat}号=${r.role}`).join(' ') + '\x1b[0m');
        }
      },
    });
    llmAgents.push(a);
    return a;
  };

  const game = createGame({
    mode: rules,
    playerCount: players,
    seed,
    fixedGenerals,
    log: rec ? rec.logFn(m => console.log(m)) : (m) => console.log(m),
    makeAgent: (_p, i): Agent => {
      const a: Agent = i === seat ? new HumanAgent('you')
        : mode === 1 ? makeLLM('llm')                              // 我 vs 大模型
          : mode === 2 ? (i === 0 ? makeLLM('llm') : new BasicAI(`rule${i}`))
            : mode === 3 ? makeLLM(`llm-${i}`)
              : new BasicAI(`rule${i}`);
      // 重放需要所有座位的选择,规则 AI 和你自己的那部分也要记
      return rec ? rec.wrap(a) : a;
    },
  });

  if (rec) {
    rec.bind(game);
    rec.start({
      seed, mode: rules.name, playerCount: players, seat, uiMode: mode,
      model: llm?.model ?? null, effort: llm ? effort : null,
      fixedGenerals: fixedGenerals ?? null,
    });
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`${players} 人 ${rules.label}  seed=${seed}` +
    (llm ? `  模型=${llm.model} effort=${effort}` : '  纯规则 AI') +
    (players === 2 ? `  后手补牌+${DUEL_HANDICAP}` : ''));
  for (const p of game.players) {
    const tag = p.seat === seat ? '(你)' : '';
    // 你自己的身份、以及规则规定公开的身份(主公 / 2v2 的队伍)才打出来
    const show = p.seat === seat || rules.revealed(p.role);
    console.log(`  [${p.seat}] ${p.general.name}${tag} ${p.maxHp}血 起手${p.handCount}张` +
      (show ? ` 身份:${ROLE_NAME[p.role]}` : ''));
  }
  if (rules.name === 'team2v2') {
    console.log(`  出牌顺序 ${game.players.map(p => `${p.seat}号(${ROLE_NAME[p.role]})`).join(' -> ')} -> 回到 0 号`);
  }
  console.log('═'.repeat(60));
  if (rec) console.log(`\x1b[90m记录中 → ${rec.file}\x1b[0m`);
  if (seat >= 0) console.log('提示:任何时候输入 0 都可以查看局势,不消耗你的行动。\n');

  let res: { winners: Player[]; reason: string };
  try {
    res = await game.setupAndRun();
  } catch (e) {
    // 崩了也要落个结局,不然最值得查的那一局反而没线索
    rec?.finish({ crashed: true, error: e instanceof Error ? e.stack ?? e.message : String(e) });
    rec?.close();
    throw e;
  }
  rec?.finish({
    reason: res.reason, winners: res.winners.map(p => p.seat),
    turns: game.turnCount, rounds: game.round,
    stats: llmAgents.map(a => ({ id: a.id, ...a.stats })),
  });
  rec?.close();

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
  if (rec) {
    console.log(`\n记录已存到 ${rec.file}`);
    console.log('  npm run log        看概览、兜底、模型延迟');
    console.log('  npm run replay     重放这一局并和原战报比对');
  }
  closeCli();
}

// 只有直接运行才启动向导 —— 测试会 import 本模块里的纯函数
if (process.argv[1]?.endsWith('start.ts')) {
  main().catch(e => { console.error(e); closeCli(); process.exit(1); });
}
