/**
 * 把 Agent 的 8 个方法统一压成一道题:**从编号列表里挑 k 个**。
 *
 * LLMAgent(调 API)和 McpAgent(把决策挂起等 Claude Code 提交)都继承它,
 * 所以两者看到的题面、选项措辞、编号语义完全一致 —— 换驱动方式不会改变模型看到的东西。
 *
 * 子类只需要实现 decide():返回选中的编号数组,或返回 null 表示"这次交给兜底 AI"。
 */

import type { Agent, CardOption, OptionCtx, PlayAction, ResponseCtx } from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { Card, SUITS, Suit } from '../core/types.js';
import { Codec, type CodecMode } from './codec.js';

export abstract class ChoiceAgent implements Agent {
  abstract readonly id: string;
  /** 人类座位会覆写成 true(引擎据此决定要不要打印提示) */
  readonly human: boolean = false;

  protected abstract codecMode: CodecMode;
  protected abstract fallback: Agent;
  /** 返回 null = 本次交给兜底 AI */
  protected abstract decide(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null>;

  protected codec: Codec | null = null;
  protected c(game: Game): Codec {
    if (!this.codec) this.codec = new Codec(game, this.codecMode);
    return this.codec;
  }

  /**
   * 决策的统一入口。**只有一种合法解时直接替它选掉,不浪费一次交互。**
   * 典型场景:1v1 里"为杀选择目标"只有一个候选、顺手牵羊只有手牌一个区域可拿。
   * 这类问题问了也是白问,却要占一次工具调用 / 一次 API 请求。
   */
  protected async ask(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null> {
    if (options.length === min && min === max) return options.map((_, i) => i);
    return this.decide(game, self, question, options, min, max);
  }

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]): Promise<number> {
    const c = this.c(game);
    const opts = actions.map(a =>
      a.kind === 'card' ? `出 ${c.text(a.label)}`
        : a.kind === 'skill' ? `技能 ${c.skill(a.skill.name)}`
          : '结束出牌阶段');
    const r = await this.ask(game, self, '出牌阶段,选一个动作', opts, 1, 1);
    if (r === null) return this.fallback.choosePlayAction(game, self, actions);
    return r[0] ?? actions.length - 1;
  }

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean,
    ctx: ResponseCtx = {},
  ): Promise<number> {
    // 引擎为了不泄露手牌,没牌的人也会被问一次。这里直接答"不出"就行 ——
    // 一道只有一个答案的题没必要花一次 API 调用。
    if (!options.length) return -1;
    const c = this.c(game);
    let q = prompt;
    if (ctx.use) q += `(来源 ${c.player(ctx.use.from)} 的 ${c.cardName(ctx.use.card.name)})`;
    if (ctx.dying) q += `(濒死者 ${c.player(ctx.dying)} hp${ctx.dying.hp})`;
    if (ctx.negated) q += '(该效果目前已被抵消,你再出会让它重新生效)';
    const r = await this.ask(game, self, q, options.map(o => c.text(o.label)), forced ? 1 : 0, 1);
    if (r === null) return this.fallback.chooseResponse(game, self, options, prompt, forced, ctx);
    return r.length ? r[0] : -1;
  }

  async chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
  ): Promise<Card[]> {
    const c = this.c(game);
    const r = await this.ask(game, self, prompt, cards.map(x => c.card(x)), min, max);
    if (r === null) return this.fallback.chooseCards(game, self, cards, min, max, prompt);
    return r.map(i => cards[i]);
  }

  async choosePlayers(
    game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string,
  ): Promise<Player[]> {
    const c = this.c(game);
    const opts = cands.map(p => `${c.player(p, self)} hp${p.hp}/${p.maxHp} 手牌${p.handCount}`);
    const r = await this.ask(game, self, prompt, opts, min, max);
    if (r === null) return this.fallback.choosePlayers(game, self, cands, min, max, prompt);
    return r.map(i => cands[i]);
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean,
    ctx: OptionCtx = {},
  ): Promise<number> {
    const c = this.c(game);
    let q = prompt;
    if (ctx.skill) {
      const sk = self.allSkills.find(s => s.name === ctx.skill);
      if (sk?.desc) q += `(${c.skill(sk.name)}:${c.text(sk.desc)})`;
    }
    const r = await this.ask(game, self, q, options.map(o => c.text(o)), cancelable ? 0 : 1, 1);
    if (r === null) return this.fallback.chooseOption(game, self, options, prompt, cancelable, ctx);
    return r.length ? r[0] : (cancelable ? -1 : 0);
  }

  async chooseSuit(game: Game, self: Player, prompt: string): Promise<Suit> {
    const r = await this.ask(game, self, prompt, [...SUITS], 1, 1);
    if (r === null) return this.fallback.chooseSuit(game, self, prompt);
    return SUITS[r[0] ?? 0];
  }

  async arrangeCards(
    game: Game, self: Player, cards: Card[], prompt: string,
  ): Promise<{ top: Card[]; bottom: Card[] }> {
    const c = this.c(game);
    const q = `${prompt}。选中的按你给的顺序放牌堆顶(排前面的先摸到),没选的沉底`;
    const r = await this.ask(game, self, q, cards.map(x => c.card(x)), 0, cards.length);
    if (r === null) return this.fallback.arrangeCards(game, self, cards, prompt);
    const top = r.map(i => cards[i]);
    return { top, bottom: cards.filter(x => !top.includes(x)) };
  }
}

/** 校验模型/玩家给的编号是否合法,返回错误说明或 null */
export function validateChoice(
  raw: unknown[], n: number, min: number, max: number,
): string | null {
  if (raw.some(v => !Number.isInteger(v))) return '编号必须是整数';
  const nums = raw as number[];
  if (new Set(nums).size !== nums.length) return '编号不能重复';
  if (nums.some(v => v < 0 || v >= n)) return `编号必须在 0~${n - 1} 之间`;
  if (nums.length < min || nums.length > max) return `需要选 ${min}~${max} 个,你给了 ${nums.length} 个`;
  return null;
}
