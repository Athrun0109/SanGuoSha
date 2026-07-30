/**
 * 把"引擎主动 await 决策"翻转成"外部按需拉取决策"。
 *
 * 引擎是一个跑到底的 async 循环,轮到你决策时会 await;MCP 是请求/响应。
 * 所以 McpAgent 在被问到时**挂起一个 Promise**,把题面存下来就返回;
 * 等 submit() 被调用才兑现,引擎随之继续跑,直到下一个属于你的决策点(或者游戏结束)。
 *
 * 对手回合、技能结算、别人濒死求桃这些都在两次工具调用之间跑完,你只会被问到跟你有关的事。
 */

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec } from '../core/setup.js';
import { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import type { Agent } from '../core/agent.js';
import { BasicAI } from '../ai/basicAI.js';
import { ChoiceAgent, validateChoice } from '../ai/choiceAgent.js';
import { Codec, type CodecMode } from '../ai/codec.js';
import {
  buildRules, eventsBlock, filterLog, identityBlock, questionBlock, situationBlock,
} from '../ai/rulesPrompt.js';
import { ROLE_NAME } from '../core/types.js';
import { HumanSeat, SeatHub } from './humanSeat.js';

export interface Pending {
  question: string;
  options: string[];
  min: number;
  max: number;
  resolve: (choice: number[]) => void;
}

class McpAgent extends ChoiceAgent {
  readonly id = 'mcp';
  protected fallback: Agent = new BasicAI('mcp-fallback');
  protected codecMode: CodecMode;
  pending: Pending | null = null;

  constructor(codecMode: CodecMode, private onPending: () => void) {
    super();
    this.codecMode = codecMode;
  }

  protected decide(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null> {
    return new Promise<number[]>(resolve => {
      this.pending = { question, options, min, max, resolve };
      this.onPending();
    });
  }

  submit(choice: number[]): string | null {
    const p = this.pending;
    if (!p) return '当前没有待决策的事项';
    const err = validateChoice(choice, p.options.length, p.min, p.max);
    if (err) return err;
    this.pending = null;
    p.resolve(choice);
    return null;
  }
}

export interface SessionOptions {
  players?: number;
  seat?: number;
  seed?: number;
  codec?: CodecMode;
  /** 手动点将,按座位顺序,如 ['关羽','吕布'];留空串表示该位随机 */
  generals?: string[];
  /** 后手补牌:0 号位以外每人额外起始手牌数。不传则用引擎默认(1v1 为 +1) */
  handicap?: number;
  /** 人类玩家坐哪个座位。设了就开本地 socket 等 `npm run join` 接进来 */
  humanSeat?: number;
}

export class GameSession {
  readonly game: Game;
  readonly me: Player;
  readonly codec: Codec;
  readonly seed: number;
  readonly humanSeat: number | null;
  /** 有人类玩家时才创建 */
  readonly hub: SeatHub | null;
  private agent: McpAgent;
  private waiters: Array<() => void> = [];

  over = false;
  result: { winners: Player[]; reason: string } | null = null;
  error: string | null = null;

  constructor(opts: SessionOptions = {}) {
    const players = clamp(opts.players ?? 2, 2, 8);
    const seat = clamp(opts.seat ?? 0, 0, players - 1);
    this.seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    const codecMode = opts.codec ?? 'verbose';
    const fixedGenerals = parseGeneralSpec(opts.generals, players);
    const startingHand = opts.handicap === undefined
      ? undefined
      : Array.from({ length: players }, (_, i) => (i === 0 ? 4 : 4 + opts.handicap!));

    const hs = opts.humanSeat;
    this.humanSeat = hs !== undefined && hs !== seat && hs >= 0 && hs < players ? hs : null;
    this.hub = this.humanSeat === null ? null : new SeatHub();

    this.agent = new McpAgent(codecMode, () => this.signal());
    const human = this.hub
      ? new HumanSeat(this.hub, (_g, p) => this.viewFor(p))
      : null;

    this.game = createGame({
      playerCount: players,
      seed: this.seed,
      verbose: true,
      fixedGenerals,
      startingHand,
      log: this.hub ? (m) => this.hub!.log(m) : undefined,
      makeAgent: (_p, i) => {
        if (i === seat) return this.agent;
        if (human && i === this.humanSeat) return human;
        return new BasicAI(`rule${i}`);
      },
    });
    this.me = this.game.players[seat];
    this.codec = new Codec(this.game, codecMode);

    // 引擎在后台跑,不 await —— 它会在需要你决策时自己停下来
    this.game.setupAndRun()
      .then(r => { this.result = r; })
      .catch(e => { this.error = e instanceof Error ? e.message : String(e); })
      .finally(() => {
        this.over = true;
        this.hub?.over(this.finalReport(this.game.players[this.humanSeat ?? 0]));
        this.signal();
      });
  }

  private signal() {
    const list = this.waiters;
    this.waiters = [];
    for (const f of list) f();
  }

  /**
   * 等到"轮到 Claude 决策"或"游戏结束"。
   * 返回 false 表示超时还没轮到 —— 有人类玩家时这是正常情况(对方在思考),
   * 不该当异常抛,让调用方提示"稍后再看一次"即可。
   */
  async settle(timeoutMs?: number): Promise<boolean> {
    const budget = timeoutMs ?? (this.hub ? 25000 : 20000);
    const deadline = Date.now() + budget;
    while (!this.agent.pending && !this.over) {
      if (Date.now() > deadline) return false;
      await Promise.race([
        new Promise<void>(r => this.waiters.push(r)),
        new Promise<void>(r => setTimeout(r, 100)),
      ]);
    }
    return true;
  }

  get pending(): Pending | null { return this.agent.pending; }

  submit(choice: number[]): string | null { return this.agent.submit(choice); }

  // ————————————————— 渲染 —————————————————

  rules(): string { return buildRules(this.codec); }

  identity(who: Player = this.me): string {
    return identityBlock(this.game, who, this.codec);
  }

  /** 人类玩家那边看到的完整视图 —— 按他自己的视角渲染,只含他该看到的信息 */
  viewFor(who: Player): string {
    return [this.identity(who), this.situation(who)].join('\n\n');
  }

  /** 当前局面 + 近期战报,按指定角色的视角渲染 */
  situation(who: Player = this.me, historyRounds = 10, maxLines = 30): string {
    const first = Math.max(1, this.game.round - historyRounds + 1);
    const from = this.game.roundStartLine[first] ?? 0;
    const log = filterLog(this.game.logLines.slice(from)).slice(-maxLines);
    const ev = eventsBlock(log, this.codec);
    return [situationBlock(this.game, who, this.codec), ev].filter(Boolean).join('\n\n');
  }

  /** 待决策的题面;没有则返回 null */
  question(): string | null {
    const p = this.agent.pending;
    if (!p) return null;
    return questionBlock(p.question, p.options, p.min, p.max, this.codec);
  }

  /** 一次工具调用要返回给 Claude 的全部内容 */
  render(opts: { withIdentity?: boolean; withRules?: boolean } = {}): string {
    const parts: string[] = [];
    if (opts.withRules) parts.push(this.rules());
    if (opts.withIdentity) parts.push(this.identity());
    if (this.over) {
      parts.push(this.finalReport());
      return parts.join('\n\n');
    }
    parts.push(this.situation());
    const q = this.question();
    if (q) {
      parts.push(q + '\n\n用 decide 工具提交,例如 {"choice":[0]}');
    } else if (this.hub && !this.hub.connected) {
      parts.push(`(在等人类玩家加入 —— 让对方在另一个终端运行:npm run join -- --port=${this.hub.port})`);
    } else if (this.hub?.waiting) {
      parts.push('(对手正在行动中,稍后用 look 再看一次)');
    } else {
      parts.push('(当前没有待你决策的事项,稍后用 look 再看一次)');
    }
    return parts.join('\n\n');
  }

  finalReport(who: Player = this.me): string {
    if (this.error) return `游戏异常终止:${this.error}`;
    const r = this.result;
    const won = r ? r.winners.includes(who) : false;
    const board = this.game.players
      .map(p => `${this.codec.player(p, this.me)} ${p.general.name} ${ROLE_NAME[p.role]} ` +
        (p.alive ? `存活 hp${p.hp}/${p.maxHp}` : '阵亡'))
      .join('\n');
    return `游戏结束:${r?.reason ?? '未知'}\n你(${ROLE_NAME[this.me.role]})${won ? '获胜 🎉' : '失败'}\n\n最终局面\n${board}\n\n共 ${this.game.turnCount} 回合。想再来一局用 new_game。`;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
