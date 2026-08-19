/**
 * 重放:拿一份 .jsonl 记录,把同一局再跑一遍。
 *
 * 为什么值得做:
 *  - **复现**。LLM 打出来的怪招是不可复现的(下次它未必这么选)。但只要把它当时的
 *    每个选择都记下来,就能在本地无成本地把那一局重演任意多次 —— 不用再花钱调模型。
 *  - **回归**。改完引擎代码重放同一份记录,日志从哪一行开始不一样,就是这次改动的影响面。
 *    符合预期就是修好了 bug,不符合预期就是引入了新 bug。
 *
 * 重放靠的是 seed + 每个座位的每次选择下标。牌堆由 seed 决定,选择由记录决定,
 * 两者合起来足以把牌局逐步还原 —— 不需要序列化任何牌对象。
 *
 * 脚本对不上时(改动导致选项列表变了、或者决策数量变了)不会硬崩:
 * 记一条 divergence,该次决策交给规则 AI,牌局继续跑完。
 * 因为"第一处分叉在哪"才是要看的信息,后面跑成什么样反而次要。
 */

import * as fs from 'node:fs';
import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import type {
  Agent, CardOption, ChooseCardsOpts, ChoosePlayersOpts, OptionCtx, PlayAction, ResponseCtx,
} from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { SUITS, type Card, type Suit } from '../core/types.js';
import { strip, type AskKind } from './recorder.js';

export interface RecordedDecision {
  kind: AskKind;
  seat: number;
  agent: string;
  prompt: string;
  options: string[];
  choice: number[];
  /** arrange 专用:前 split 个下标是牌堆顶 */
  split?: number;
}

export interface LoadedLog {
  meta: Record<string, any>;
  setup: Record<string, any> | null;
  decisions: RecordedDecision[];
  logLines: string[];
  end: Record<string, any> | null;
  events: Record<string, any>[];
}

/** 读一份记录。坏行直接跳过 —— 进程被掐掉时最后一行可能是残缺的 */
export function loadLog(file: string): LoadedLog {
  const out: LoadedLog = { meta: {}, setup: null, decisions: [], logLines: [], end: null, events: [] };
  const pending = new Map<number, RecordedDecision>();

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    out.events.push(ev);

    switch (ev.type) {
      case 'meta': out.meta = ev; break;
      case 'setup': out.setup = ev; break;
      case 'log': out.logLines.push(ev.line); break;
      case 'end': out.end = ev; break;
      case 'ask':
        pending.set(ev.i, {
          kind: ev.kind, seat: ev.seat, agent: ev.agent, prompt: ev.prompt,
          options: ev.options ?? [], choice: [],
        });
        break;
      case 'answer': {
        const d = pending.get(ev.of);
        // 只有配上了 answer 的 ask 才算一次完整决策;卡死在半路的那次自然被丢掉
        if (!d) break;
        pending.delete(ev.of);
        d.choice = ev.choice ?? [];
        if (typeof ev.split === 'number') d.split = ev.split;
        out.decisions.push(d);
        break;
      }
    }
  }
  return out;
}

/** 按记录顺序发牌的脚本。对不上就记一笔,让调用方退回规则 AI */
export class ReplayScript {
  private cursor = 0;
  readonly divergences: string[] = [];

  constructor(private decisions: RecordedDecision[]) {}

  get consumed() { return this.cursor; }
  get total() { return this.decisions.length; }
  get exhausted() { return this.cursor >= this.decisions.length; }

  /** 返回下标数组;null 表示这次对不上,请走兜底 */
  next(kind: AskKind, seat: number, optionCount: number): RecordedDecision | null {
    if (this.exhausted) {
      this.note(`第 ${this.cursor} 次决策:记录已用完(座位 ${seat} / ${kind})`);
      return null;
    }
    const d = this.decisions[this.cursor];
    if (d.kind !== kind || d.seat !== seat) {
      this.note(`第 ${this.cursor} 次决策不匹配:记录是 [${d.seat}]${d.kind},现在问的是 [${seat}]${kind}`);
      return null;
    }
    // 选项条数变了说明可选动作集合被改动影响了,下标已经不能直接用
    if (d.options.length !== optionCount) {
      this.note(`第 ${this.cursor} 次决策([${seat}]${kind} ${d.prompt})选项数 ${d.options.length} → ${optionCount}`);
      this.cursor++;
      return null;
    }
    if (d.choice.some(i => i >= optionCount)) {
      this.note(`第 ${this.cursor} 次决策下标越界:${d.choice} 超出 ${optionCount}`);
      this.cursor++;
      return null;
    }
    this.cursor++;
    return d;
  }

  private note(msg: string) {
    // 一旦分叉,后面基本会连锁地全对不上。只留前几条,不然刷屏
    if (this.divergences.length < 20) this.divergences.push(msg);
  }
}

/** 照着脚本选。脚本对不上时透明地退回内部的规则 AI */
export class ReplayAgent implements Agent {
  private fb: Agent;

  constructor(readonly id: string, private seat: number, private script: ReplayScript) {
    this.fb = new BasicAI(`${id}-fb`);
  }

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]) {
    const d = this.script.next('playAction', this.seat, actions.length);
    if (!d) return this.fb.choosePlayAction(game, self, actions);
    return d.choice[0] ?? actions.length - 1;
  }

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean, ctx?: ResponseCtx,
  ) {
    const d = this.script.next('response', this.seat, options.length);
    if (!d) return this.fb.chooseResponse(game, self, options, prompt, forced, ctx);
    return d.choice.length ? d.choice[0] : -1;
  }

  async chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
    opts?: ChooseCardsOpts,
  ) {
    const d = this.script.next('cards', this.seat, cards.length);
    if (!d) return this.fb.chooseCards(game, self, cards, min, max, prompt, opts);
    return d.choice.map(i => cards[i]);
  }

  async choosePlayers(
    game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string,
    opts?: ChoosePlayersOpts,
  ) {
    const d = this.script.next('players', this.seat, cands.length);
    if (!d) return this.fb.choosePlayers(game, self, cands, min, max, prompt, opts);
    return d.choice.map(i => cands[i]);
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean, ctx?: OptionCtx,
  ) {
    const d = this.script.next('option', this.seat, options.length);
    if (!d) return this.fb.chooseOption(game, self, options, prompt, cancelable, ctx);
    return d.choice.length ? d.choice[0] : -1;
  }

  async arrangeCards(game: Game, self: Player, cards: Card[], prompt: string) {
    const d = this.script.next('arrange', this.seat, cards.length);
    if (!d) return this.fb.arrangeCards(game, self, cards, prompt);
    const split = d.split ?? d.choice.length;
    return {
      top: d.choice.slice(0, split).map(i => cards[i]),
      bottom: d.choice.slice(split).map(i => cards[i]),
    };
  }

  async chooseSuit(game: Game, self: Player, prompt: string): Promise<Suit> {
    const d = this.script.next('suit', this.seat, SUITS.length);
    if (!d) return this.fb.chooseSuit(game, self, prompt);
    return SUITS[d.choice[0]] ?? '♠';
  }
}

export interface ReplayResult {
  game: Game;
  log: LoadedLog;
  script: ReplayScript;
  /** 新旧战报一致的行数 */
  matched: number;
  /** 第一处不同 */
  firstDiff: { line: number; was: string; now: string } | null;
  newLines: string[];
  error: string | null;
}

/** 重放一份记录,并把新战报和旧战报逐行比对 */
export async function replay(file: string, opts: { log?: (m: string) => void } = {}): Promise<ReplayResult> {
  const log = loadLog(file);
  const m = log.meta;
  if (typeof m.seed !== 'number') {
    throw new Error(`这份记录里没有 seed,无法重放:${file}`);
  }

  const script = new ReplayScript(log.decisions);
  const newLines: string[] = [];

  const game = createGame({
    // 模式决定身份怎么分、谁先手 —— 不带上的话 2v2 的记录会按身份局重放,第一步就对不上
    mode: typeof m.mode === 'string' ? m.mode : undefined,
    playerCount: m.playerCount ?? log.setup?.players?.length ?? 2,
    seed: m.seed,
    fixedGenerals: m.fixedGenerals ?? undefined,
    startingHand: m.startingHand ?? undefined,
    lordBonusHp: m.lordBonusHp,
    // 记录里存的是去色版本,比对前必须一致地脱色
    log: (msg) => { newLines.push(strip(msg)); opts.log?.(msg); },
    makeAgent: (p, i) => new ReplayAgent(`replay-${i}`, i, script),
  });

  // 开局就对不上的话,后面每一行都会不同,先说清楚是哪里变了
  for (const rec of log.setup?.players ?? []) {
    const p = game.players[rec.seat];
    if (!p) continue;
    if (p.general?.name !== rec.general) {
      script.divergences.unshift(
        `开局就不同:座位 ${rec.seat} 记录里是 ${rec.general},现在是 ${p.general?.name}` +
        `(武将池或身份分配的随机顺序被改动了)`);
    } else if (p.handCount !== (rec.hand?.length ?? p.handCount)) {
      script.divergences.unshift(
        `开局就不同:座位 ${rec.seat} 起手 ${rec.hand.length} 张,现在 ${p.handCount} 张`);
    }
  }

  let error: string | null = null;
  try {
    await game.setupAndRun();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  let matched = 0;
  let firstDiff: ReplayResult['firstDiff'] = null;
  const n = Math.max(log.logLines.length, newLines.length);
  for (let i = 0; i < n; i++) {
    const was = log.logLines[i], now = newLines[i];
    if (was === now) { matched++; continue; }
    firstDiff = { line: i, was: was ?? '(旧记录到此为止)', now: now ?? '(新战报到此为止)' };
    break;
  }

  return { game, log, script, matched, firstDiff, newLines, error };
}
