/**
 * 批量跑 LLM 对局,产出一组可比对的行为指标。
 *
 *   npm run bench -- --games=8 --effort=low  --out=logs/bench-low
 *   npm run bench -- --games=8 --effort=medium --out=logs/bench-medium
 *   npm run metrics logs/bench-low -- --vs logs/bench-medium
 *
 * ## 怎么才算一次公平的 A/B
 *
 * **两组必须用同一批 seed。**seed 决定牌堆、身份和武将 —— 开局之前的一切。
 * 两组从完全相同的局面出发,之后的分歧才能归因到被测变量上。这也是为什么
 * `--seed0` 默认是个定值而不是随机数:换个变量再跑时,和上一组还能对得上。
 *
 * **别在一组里混模型。**LLMAgent 支持"主用卡住就切备用",那在实战里是对的,
 * 在跑基准时是污染 —— 一半对局是另一个模型打的。所以这里默认只给一个模型,
 * 并且把每局的兜底次数报出来;兜底率差太多的两组不能直接比(见 metrics.ts)。
 *
 * **只让一部分席位用模型。**默认 `--llm=0,1`(2v2 里每队一个),其余是规则 AI。
 * 同样的预算下,"少席位 × 多局"比"多席位 × 少局"更值:局数越多,武将种类越杂,
 * 独立样本也越多。而规则 AI 对手在两组里行为一致,还顺带压低了方差。
 *
 * ## 并发
 *
 * 一局里的决策是严格串行的(得等模型回话),但**局与局之间完全独立**,
 * 所以用 --jobs 同时跑几局。这活儿是纯 I/O 等待,几局并行不抢 CPU。
 * 注意 OpenRouter 那边有速率限制,jobs 开太大会开始吃 429。
 */

import { loadEnv } from './env.js';
loadEnv();

import * as path from 'node:path';
import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { getMode } from '../core/mode.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent } from '../ai/llmAgent.js';
import { preflight } from '../ai/preflight.js';
import { Recorder } from '../log/recorder.js';
import type { Agent } from '../core/agent.js';

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

/**
 * 这一局里哪一队接受治疗 —— **按 seed 奇偶交替**。
 *
 * 固定治疗蓝队的话,ABBA 座次残留的先手偏差会整个算到治疗效果头上
 * (纯规则 AI 跑 2000 局是蓝 50.7% / 红 49.3%,不大但不是零)。交替之后完全抵消。
 * 用 role 而不是座位号,免得把 mode.ts 里的座次表在这儿抄第二份。
 */
function treated(seed: number, role: string): boolean {
  return seed % 2 === 0 ? role === 'blue' : role === 'red';
}

interface Outcome {
  seed: number; ok: boolean; turns: number; ms: number;
  calls: number; fallbacks: number; error?: string;
}

async function main() {
  const games = Number(flag('games') ?? 8);
  const effort = (flag('effort') ?? 'low') as any;
  const modeName = flag('mode') ?? 'team2v2';
  const mode = getMode(modeName);
  const nArg = Number(flag('players') ?? 4);
  const n = mode.sizes.includes(nArg) ? nArg : mode.sizes[0];
  const seed0 = Number(flag('seed0') ?? 70000);
  const jobs = Math.max(1, Number(flag('jobs') ?? 3));
  const codec = (flag('codec') ?? 'verbose') as 'verbose' | 'anon';
  const historyRounds = Number(flag('rounds') ?? 10);
  const model = flag('model') ?? 'deepseek/deepseek-v4-flash';
  const llmSeats = new Set((flag('llm') ?? '0,1').split(',')
    .map(x => Number(x.trim())).filter(x => Number.isInteger(x) && x >= 0 && x < n));
  const out = path.resolve(flag('out') ?? `logs/bench-${effort}`);
  /**
   * `--open-hand` 开明牌对照实验:**一队看得见彼此手牌,另一队照旧,同一局里对打。**
   *
   * 上一批 A/B 的结构性缺陷是两队完全对称,所以胜率什么都测不出来,只能看行为指标。
   * 这次治疗组和对照组在同一局里,胜率就是直接的效果测量,而且天然配对 ——
   * 同一副牌、同一批武将、同样的运气。
   *
   * 治疗的队伍**按 seed 奇偶交替**:即使 ABBA 座次还残留一点先手偏差,
   * 也会被完全抵消,不必再另跑一组空白对照。
   */
  const openHand = flag('open-hand') !== undefined;

  if (!llmSeats.size) { console.error('--llm 至少要有一个合法席位'); process.exit(1); }

  const { createOpenRouterClient } = await import('../ai/openrouterClient.js');
  const client = createOpenRouterClient({ appTitle: 'sanguosha-bench' });

  // 先探一次路。八局跑到一半才发现模型名写错,那是最贵的失败方式
  const probe = await preflight(client, model);
  if (!probe.ok) {
    console.error(`调用 ${model} 失败:${probe.error}`);
    console.error('检查 OPENROUTER_API_KEY,或用 npm run models deepseek 看看模型名');
    process.exit(1);
  }

  console.log(`\n批量对局  ${model}  effort=${effort}  codec=${codec}`);
  console.log(`${mode.label} ${n} 人  模型席位 ${[...llmSeats].join(',')}  ` +
    `${games} 局(seed ${seed0}…${seed0 + games - 1})  并发 ${jobs}`);
  console.log(`记录 → ${out}\n`);

  const results: Outcome[] = [];
  let next = 0;
  let done = 0;

  const runOne = async (k: number): Promise<Outcome> => {
    const seed = seed0 + k;
    const t0 = Date.now();
    // text:false —— 一局的人读战报几十 KB,批量跑只看 jsonl
    const rec = new Recorder({ dir: out, name: `g${String(k).padStart(3, '0')}-s${seed}`, text: false });
    const recHook = rec.llmHook();
    const llms: LLMAgent[] = [];
    const roleOf = new Map<number, string>();
    try {
      const game = createGame({
        mode: modeName, playerCount: n, seed,
        log: rec.logFn(),
        makeAgent: (p, i): Agent => {
          if (!llmSeats.has(i)) return rec.wrap(new BasicAI(`rule-${i}`));
          roleOf.set(i, p.role);
          const a = new LLMAgent(`llm-${i}`, {
            client, model, effort, codec, historyRounds,
            teamHands: openHand && treated(seed, p.role),
            onDecision: recHook,
          });
          llms.push(a);
          return rec.wrap(a);
        },
      });
      rec.bind(game);
      rec.start({
        seed, model, effort, codec, historyRounds, playerCount: n, mode: modeName,
        openHand,
        /*
         * metrics 靠这个把席位分组。明牌实验里治疗组标成 llm+open ——
         * 于是 pool() 直接给出两行,同一批对局里就能并排比,不需要跑两次。
         */
        seats: Array.from({ length: n }, (_, i) => ({
          control: !llmSeats.has(i) ? 'rule'
            : openHand && treated(seed, roleOf.get(i)!) ? 'llm+open' : 'llm',
        })),
      });
      const res = await game.setupAndRun();
      const ms = Date.now() - t0;
      rec.finish({
        reason: res.reason, winners: res.winners.map(p => p.seat),
        turns: game.turnCount, rounds: game.round, ms,
        stats: llms.map(a => ({ id: a.id, ...a.stats })),
      });
      rec.close();
      return {
        seed, ok: true, turns: game.turnCount, ms,
        calls: llms.reduce((s, a) => s + a.stats.calls, 0),
        fallbacks: llms.reduce((s, a) => s + a.stats.fallbacks, 0),
      };
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      // 崩掉的那一局也要落盘 —— 最值得看的往往就是它
      rec.finish({ crashed: true, error: e instanceof Error ? e.stack ?? err : err });
      rec.close();
      return {
        seed, ok: false, turns: 0, ms: Date.now() - t0, error: err,
        calls: llms.reduce((s, a) => s + a.stats.calls, 0),
        fallbacks: llms.reduce((s, a) => s + a.stats.fallbacks, 0),
      };
    }
  };

  const worker = async () => {
    for (let k = next++; k < games; k = next++) {
      const r = await runOne(k);
      results.push(r);
      done++;
      const tag = r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      console.log(`  ${tag} [${String(done).padStart(2)}/${games}] seed=${r.seed} ` +
        `${String(r.turns).padStart(3)}回合 ${(r.ms / 1000).toFixed(0)}s ` +
        `决策${r.calls} 兜底${r.fallbacks}` + (r.error ? `  ${r.error}` : ''));
    }
  };

  const wall = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobs, games) }, worker));

  const ok = results.filter(r => r.ok);
  const calls = results.reduce((s, r) => s + r.calls, 0);
  const fb = results.reduce((s, r) => s + r.fallbacks, 0);
  console.log(`\n${ok.length}/${games} 局跑完,共 ${((Date.now() - wall) / 60000).toFixed(1)} 分钟`);
  console.log(`模型决策 ${calls} 次,其中兜底 ${fb} 次` +
    (calls ? ` (${(fb * 100 / calls).toFixed(1)}%)` : ''));
  if (fb * 20 > calls) {
    console.log('\x1b[33m⚠ 兜底超过 5%:这些手是规则 AI 打的,和另一组比之前先看这个数\x1b[0m');
  }
  console.log(`\n看指标:  npm run metrics ${path.relative(process.cwd(), out).split('\\').join('/')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
