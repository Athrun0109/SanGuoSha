/**
 * 对局记录器 —— 把一局游戏完整落盘,用来排查 bug 和改进 AI。
 *
 * 产出两个文件:
 *   logs/<时间戳>-<seed>.jsonl   机器读:每行一个事件,可被 replay 重放
 *   logs/<时间戳>-<seed>.log     人读:战报 + 每次决策的推理
 *
 * 设计上的三个要点:
 *
 * 1. **包裹每一个 agent,不只是 LLM。** 只记 LLM 的决策是不够的 —— 重放一局需要
 *    *所有*座位的每一次选择,少了规则 AI 的那部分,牌局在第一个分叉点就跑偏了。
 *    所以 wrap() 对 BasicAI / HumanAgent / LLMAgent 一视同仁。
 *
 * 2. **选择一律归一成下标数组。** 各个 Agent 方法返回的类型五花八门(number、Card[]、
 *    Player[]、Suit、{top,bottom}),但它们本质上都是"从入参列表里挑几个"。
 *    统一记下标之后,重放只要把下标映射回当时的列表即可,不需要序列化牌对象。
 *
 * 3. **同步写盘。** 这个工具存在的意义就是排查卡死和崩溃,所以每个事件都
 *    appendFileSync 落盘 —— 进程被 Ctrl+C 掐掉或者卡在网络请求上时,
 *    磁盘上的日志必须是完整到最后一刻的。一局几百个事件,这点开销无所谓。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Agent, CardOption, OptionCtx, PlayAction, ResponseCtx } from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { cardLabel, ROLE_NAME, SUITS, type Card } from '../core/types.js';
import type { DecisionInfo } from '../ai/llmAgent.js';

/** 决策的种类,对应 Agent 上的 7 个方法 */
export type AskKind =
  | 'playAction' | 'response' | 'cards' | 'players' | 'option' | 'arrange' | 'suit';

export interface RecorderOptions {
  /** 输出目录,默认 <cwd>/logs */
  dir?: string;
  /** 文件名(不含扩展名),默认 <时间戳>-seed<seed> */
  name?: string;
  /** 一并写一份人读的 .log,默认 true */
  text?: boolean;
  /** 记 LLM 的完整提示词全文。体积会涨到十几倍,默认 false */
  fullPrompt?: boolean;
}

/** 事件的公共字段 */
interface EventBase {
  i: number;
  t: number;
  type: string;
  round?: number;
  turn?: number;
  phase?: string;
  cur?: number;
}

export class Recorder {
  readonly file: string;
  readonly textFile: string;

  private seq = 0;
  private t0 = Date.now();
  private game: Game | null = null;
  private lastSnapTurn = -1;
  private closed = false;
  private textOn: boolean;
  private fullPrompt: boolean;
  /** ask 事件的序号,answer 用它回指 */
  private askSeq = 0;
  private askAt = 0;

  constructor(opts: RecorderOptions = {}) {
    const dir = opts.dir ?? path.join(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const base = opts.name ?? `${stamp()}`;
    this.file = path.join(dir, `${base}.jsonl`);
    this.textFile = path.join(dir, `${base}.log`);
    this.textOn = opts.text ?? true;
    this.fullPrompt = opts.fullPrompt ?? false;
    fs.writeFileSync(this.file, '');
    if (this.textOn) fs.writeFileSync(this.textFile, '');
  }

  /** 绑定 game 之后,每个事件都会自动带上回合/阶段上下文 */
  bind(game: Game) {
    this.game = game;
    return this;
  }

  // ————————————————— 写事件 —————————————————

  event(type: string, data: Record<string, unknown> = {}): number {
    if (this.closed) return -1;
    // 换回合了就先补一张全场快照 —— 排查时最想知道的永远是"当时手里有什么"
    if (this.game && type !== 'state' && this.game.turnCount !== this.lastSnapTurn) {
      this.lastSnapTurn = this.game.turnCount;
      this.event('state', this.snapshot());
    }
    const g = this.game;
    const ev: EventBase & Record<string, unknown> = {
      i: this.seq++,
      t: Date.now() - this.t0,
      type,
      ...(g ? { round: g.round, turn: g.turnCount, phase: g.phase, cur: g.current?.seat } : {}),
      ...data,
    };
    fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
    return ev.i;
  }

  private text(line: string) {
    if (this.textOn && !this.closed) fs.appendFileSync(this.textFile, line + '\n');
  }

  /**
   * 交给 createGame 的 log 回调。传入原来的输出函数(通常是 console.log)会继续转发,
   * 这样开着记录也不影响正常看战报。
   */
  logFn(passthrough?: (msg: string) => void) {
    return (msg: string) => {
      this.event('log', { line: strip(msg) });
      this.text(strip(msg));
      passthrough?.(msg);
    };
  }

  /** 开局信息:所有座位的身份、武将、起手牌 */
  start(meta: Record<string, unknown>) {
    this.event('meta', {
      startedAt: new Date().toISOString(),
      argv: process.argv.slice(2),
      ...meta,
    });
    if (this.game) {
      this.event('setup', {
        players: this.game.players.map(p => ({
          seat: p.seat,
          general: p.general?.name,
          role: p.role,
          hp: p.hp,
          maxHp: p.maxHp,
          skills: p.skills.map(s => s.name),
          hand: p.hand.map(cardLabel),
        })),
        deck: this.game.deck.length,
      });
    }
    this.text(`# 对局记录 ${new Date().toISOString()}`);
    for (const [k, v] of Object.entries(meta)) this.text(`# ${k}: ${JSON.stringify(v)}`);
    if (this.game) {
      for (const p of this.game.players) {
        this.text(`# [${p.seat}] ${p.general?.name} ${p.hp}/${p.maxHp} ` +
          `${ROLE_NAME[p.role]} 起手:${p.hand.map(cardLabel).join(' ')}`);
      }
    }
    this.text('');
  }

  /** 全场快照:血量、手牌、装备、判定区、牌堆 */
  snapshot(): Record<string, unknown> {
    const g = this.game;
    if (!g) return {};
    return {
      players: g.players.map(p => ({
        seat: p.seat,
        hp: p.hp,
        maxHp: p.maxHp,
        alive: p.alive,
        hand: p.hand.map(cardLabel),
        equips: Object.fromEntries(
          Object.entries(p.equips).filter(([, c]) => c).map(([s, c]) => [s, cardLabel(c as Card)]),
        ),
        judge: p.judgeZone.map(c => g.judgeName(p, c)),
      })),
      deck: g.deck.length,
      discard: g.discardPile.length,
    };
  }

  /** LLMAgent 的 onDecision 钩子。和 duel 里那个只负责打印的 show() 可以并存 */
  llmHook(): (info: DecisionInfo) => void {
    return (info) => {
      const { payload, raw, attempts, ...rest } = info;
      this.event('llm', {
        ...rest,
        raw: raw || undefined,
        attempts,
        // 提示词全文默认不记:它每次都几千字且大部分是重复的局面描述
        payload: this.fullPrompt ? payload : undefined,
      });
      if (info.usedFallback) this.text(`    !! ${info.agentId} 兜底 ← ${info.error ?? '未知'}`);
      else if (info.thinking) this.text(`    ~~ ${info.agentId}: ${info.thinking}`);
    };
  }

  /** 结束:胜负、耗时、各 LLM 的统计 */
  finish(data: Record<string, unknown>) {
    this.event('end', data);
    this.text('');
    this.text(`# 结束: ${JSON.stringify(data)}`);
  }

  close() {
    this.closed = true;
  }

  // ————————————————— 包裹 agent —————————————————

  wrap(agent: Agent): Agent {
    return new RecordingAgent(agent, this);
  }

  /** 由 RecordingAgent 调用 */
  ask(kind: AskKind, seat: number, agentId: string, prompt: string, options: string[],
      min: number, max: number, extra?: Record<string, unknown>) {
    this.askSeq = this.event('ask', { kind, seat, agent: agentId, prompt, options, min, max, ...extra });
    this.askAt = Date.now();
    this.text(`  ?? [${seat}] ${prompt} (${min}~${max} / ${options.length})`);
    options.forEach((o, i) => this.text(`       ${i}. ${o}`));
  }

  answer(choice: number[], labels: string[], extra?: Record<string, unknown>) {
    this.event('answer', { of: this.askSeq, choice, ms: Date.now() - this.askAt, ...extra });
    this.text(`  => ${choice.join(',')}  ${labels.join(' + ') || '(放弃)'}`);
  }
}

/**
 * 记录一个 agent 的每次决策,再原样把结果交回引擎。
 * 它自己不做任何判断 —— 加不加记录器,牌局走向必须完全一致。
 */
class RecordingAgent implements Agent {
  constructor(private inner: Agent, private rec: Recorder) {}

  get id() { return this.inner.id; }
  get human() { return this.inner.human; }

  notify(game: Game, self: Player, message: string) {
    this.inner.notify?.(game, self, message);
  }

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]) {
    this.rec.ask('playAction', self.seat, this.id, '出牌阶段', actions.map(a => a.label), 1, 1);
    const n = await this.inner.choosePlayAction(game, self, actions);
    this.rec.answer([n], [actions[n]?.label ?? '?']);
    return n;
  }

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean, ctx?: ResponseCtx,
  ) {
    this.rec.ask('response', self.seat, this.id, prompt, options.map(o => o.label), forced ? 1 : 0, 1,
      { forced, purpose: ctx?.purpose });
    const n = await this.inner.chooseResponse(game, self, options, prompt, forced, ctx);
    this.rec.answer(n < 0 ? [] : [n], n < 0 ? [] : [options[n]?.label ?? '?']);
    return n;
  }

  async chooseCards(game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string) {
    this.rec.ask('cards', self.seat, this.id, prompt, cards.map(cardLabel), min, max);
    const picked = await this.inner.chooseCards(game, self, cards, min, max, prompt);
    const idx = picked.map(c => cards.indexOf(c));
    this.rec.answer(idx, picked.map(cardLabel));
    return picked;
  }

  async choosePlayers(game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string) {
    this.rec.ask('players', self.seat, this.id, prompt, cands.map(p => p.name), min, max);
    const picked = await this.inner.choosePlayers(game, self, cands, min, max, prompt);
    const idx = picked.map(p => cands.indexOf(p));
    this.rec.answer(idx, picked.map(p => p.name));
    return picked;
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean, ctx?: OptionCtx,
  ) {
    this.rec.ask('option', self.seat, this.id, prompt, options, cancelable ? 0 : 1, 1,
      { cancelable, skill: ctx?.skill, timing: ctx?.timing, tag: ctx?.tag });
    const n = await this.inner.chooseOption(game, self, options, prompt, cancelable, ctx);
    this.rec.answer(n < 0 ? [] : [n], n < 0 ? [] : [options[n] ?? '?']);
    return n;
  }

  async arrangeCards(game: Game, self: Player, cards: Card[], prompt: string) {
    this.rec.ask('arrange', self.seat, this.id, prompt, cards.map(cardLabel), 0, cards.length);
    const r = await this.inner.arrangeCards(game, self, cards, prompt);
    // 顶和底都要记顺序,所以拼成一条下标序列,再用 split 标出分界
    const top = r.top.map(c => cards.indexOf(c));
    const bottom = r.bottom.map(c => cards.indexOf(c));
    this.rec.answer([...top, ...bottom],
      [`顶:${r.top.map(cardLabel).join(' ') || '无'}`, `底:${r.bottom.map(cardLabel).join(' ') || '无'}`],
      { split: top.length });
    return r;
  }

  async chooseSuit(game: Game, self: Player, prompt: string) {
    this.rec.ask('suit', self.seat, this.id, prompt, [...SUITS], 1, 1);
    const s = await this.inner.chooseSuit(game, self, prompt);
    this.rec.answer([SUITS.indexOf(s)], [s], { value: s });
    return s;
  }
}

/** 去掉 ANSI 颜色码 —— 日志文件里那些转义序列只会碍事 */
export function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
