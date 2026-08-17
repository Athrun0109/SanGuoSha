/**
 * 网页座位 —— 把引擎的 `await 决策` 翻转成"浏览器按需提交"。
 *
 * 和 `mcp/session.ts` 里的 McpAgent 是同一套做法:轮到你时**挂起一个 Promise**,
 * 把题面存进 `pending` 就返回;等 `submit()` 被调用才兑现,引擎随之继续跑。
 * 两者都继承 `ChoiceAgent`,所以 8 个决策方法、题面措辞、编号语义完全一致 ——
 * 换传输层不会改变题目本身。
 *
 * 唯一多出来的东西是 `items`:每个选项对应的**实体**(哪张牌、哪个座位、哪个技能)。
 * 光有文字标签的话,前端只能拿一串按钮给你点;有了它,才能做到"点角色框选目标、
 * 点手牌选牌",也就是三国杀该有的操作方式。
 */

import type { Agent, CardOption, OptionCtx, PlayAction, ResponseCtx } from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import type { Card } from '../core/types.js';
import { BasicAI } from '../ai/basicAI.js';
import { ChoiceAgent, validateChoice } from '../ai/choiceAgent.js';
import type { CodecMode } from '../ai/codec.js';

/** 一个选项背后指向什么实体。前端据此把选项映射到界面上点得到的东西 */
export type OptionItem =
  /** via:这张虚拟牌是靠哪件装备/技能转化出来的(武圣、倾国…),给界面加个提示用 */
  | { kind: 'card'; ids: number[]; via?: string }
  | { kind: 'player'; seat: number }
  | { kind: 'skill'; name: string }
  | { kind: 'end' }
  | { kind: 'plain' };

export interface WebPending {
  question: string;
  options: string[];
  items: OptionItem[];
  min: number;
  max: number;
  /** 选中的顺序是否有意义(观星要按顺序放牌堆顶) */
  ordered: boolean;
}

/** 中止当前对局时抛的错。调用方靠它区分"用户点了重开"和"真的崩了" */
export class GameAborted extends Error {
  constructor(msg = '对局已中止') { super(msg); this.name = 'GameAborted'; }
}

export class WebAgent extends ChoiceAgent {
  readonly id: string;
  readonly human = true;
  protected codecMode: CodecMode = 'verbose';
  protected fallback: Agent;

  pending: WebPending | null = null;
  private resolver: ((choice: number[]) => void) | null = null;
  private rejecter: ((e: Error) => void) | null = null;
  private aborted = false;
  /** 由各 chooseXxx 在调 super 之前填好,decide() 取用 */
  private nextItems: OptionItem[] | null = null;
  private nextOrdered = false;

  constructor(id = 'you', onPending: () => void = () => {}) {
    super();
    this.id = id;
    this.onPending = onPending;
    this.fallback = new BasicAI(`${id}-fallback`);
  }
  private onPending: () => void;

  protected decide(
    _game: Game, _self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null> {
    /*
     * items 必须和 options **一一对应**,对不上就整份丢掉换成 plain。
     *
     * 为什么要防:父类的 ask() 在"只有一个合法解"时会直接替你选掉,decide() 根本
     * 不会被调用 —— 于是那次设好的 nextItems 留在实例上,串到下一道题去。
     * 真实事故:被【反间】问花色时拿到了上一次响应留下的空数组,前端按 items 枚举,
     * 一个按钮都没渲染出来,牌局就卡死在那里。
     */
    const items = this.nextItems?.length === options.length
      ? this.nextItems
      : options.map((): OptionItem => ({ kind: 'plain' }));
    const ordered = this.nextOrdered;
    this.nextItems = null;
    this.nextOrdered = false;
    if (this.aborted) return Promise.reject(new GameAborted());
    return new Promise<number[]>((resolve, reject) => {
      this.pending = { question, options, items, min, max, ordered };
      this.resolver = resolve;
      this.rejecter = reject;
      this.onPending();
    });
  }

  /**
   * 放弃这一局。**必须把挂起的 Promise 兑现掉** —— 否则引擎那条 async 链就永远
   * 停在这里,连同整局状态一起泄漏,而用户以为已经重开了。
   */
  abort(reason?: string): void {
    this.aborted = true;
    const rej = this.rejecter;
    this.pending = null;
    this.resolver = null;
    this.rejecter = null;
    rej?.(new GameAborted(reason));
  }

  /** 浏览器交上来的答案。返回错误说明,或 null 表示收下了 */
  submit(choice: number[]): string | null {
    if (this.aborted) return '这一局已经中止了';
    const p = this.pending;
    if (!p || !this.resolver) return '现在没有轮到你的决策';
    const err = validateChoice(choice, p.options.length, p.min, p.max);
    if (err) return err;
    const done = this.resolver;
    this.pending = null;
    this.resolver = null;
    this.rejecter = null;
    done(choice.map(Number));
    return null;
  }

  // ————————— 下面这些只做一件事:记下选项对应的实体,再交给父类 —————————

  private cardItem(c: { cards: Card[]; skill?: string }): OptionItem {
    return { kind: 'card', ids: c.cards.map(x => x.id), via: c.skill };
  }

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]): Promise<number> {
    this.nextItems = actions.map((a): OptionItem =>
      // 素材待定的选项在界面上点不到具体的牌 —— 它就是一个按钮,
      // 点了之后引擎会另外问"用哪几张",那一问才对应到手牌
      a.kind === 'card' ? (a.pick ? { kind: 'plain' } : this.cardItem(a.card))
        : a.kind === 'skill' ? { kind: 'skill', name: a.skill.name }
          : { kind: 'end' });
    return super.choosePlayAction(game, self, actions);
  }

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean,
    ctx: ResponseCtx = {},
  ): Promise<number> {
    this.nextItems = options.map((o): OptionItem => o.pick ? { kind: 'plain' } : this.cardItem(o.card));
    return super.chooseResponse(game, self, options, prompt, forced, ctx);
  }

  async chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
  ): Promise<Card[]> {
    this.nextItems = cards.map((c): OptionItem => ({ kind: 'card', ids: [c.id] }));
    return super.chooseCards(game, self, cards, min, max, prompt);
  }

  async choosePlayers(
    game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string,
  ): Promise<Player[]> {
    this.nextItems = cands.map((p): OptionItem => ({ kind: 'player', seat: p.seat }));
    return super.choosePlayers(game, self, cands, min, max, prompt);
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean,
    ctx: OptionCtx = {},
  ): Promise<number> {
    this.nextItems = options.map((): OptionItem => ({ kind: 'plain' }));
    return super.chooseOption(game, self, options, prompt, cancelable, ctx);
  }

  async arrangeCards(
    game: Game, self: Player, cards: Card[], prompt: string,
  ): Promise<{ top: Card[]; bottom: Card[] }> {
    this.nextItems = cards.map((c): OptionItem => ({ kind: 'card', ids: [c.id] }));
    this.nextOrdered = true;   // 观星:选中的顺序就是放回牌堆顶的顺序
    return super.arrangeCards(game, self, cards, prompt);
  }
}
