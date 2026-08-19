/**
 * 给 agent 套一层节奏控制。
 *
 * 纯 AI 的一局 300ms 就跑完了,直接推给浏览器只会看到最终画面。所以在每次决策**之前**
 * 停一下再推快照 —— 决策点正好是牌局的自然节拍,停在这里看起来就像一步一步在走。
 *
 * 之所以只能停在这里:引擎的 log() 是同步的,没法在里面 await。
 */

import type {
  Agent, CardOption, ChooseCardsOpts, ChoosePlayersOpts, OptionCtx, PlayAction, ResponseCtx,
} from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import type { Card, Suit } from '../core/types.js';

export interface PaceHooks {
  /** 每次决策前调用,可以在这里 sleep + 推快照 */
  before(): Promise<void> | void;
}

export function paced(inner: Agent, hooks: PaceHooks): Agent {
  return new PacedAgent(inner, hooks);
}

class PacedAgent implements Agent {
  constructor(private inner: Agent, private h: PaceHooks) {}

  get id() { return this.inner.id; }
  get human() { return this.inner.human; }
  notify(game: Game, self: Player, message: string) { this.inner.notify?.(game, self, message); }

  private async tick() { await this.h.before(); }

  async choosePlayAction(g: Game, s: Player, a: PlayAction[]) {
    await this.tick(); return this.inner.choosePlayAction(g, s, a);
  }
  async chooseResponse(g: Game, s: Player, o: CardOption[], p: string, f: boolean, c?: ResponseCtx) {
    await this.tick(); return this.inner.chooseResponse(g, s, o, p, f, c);
  }
  async chooseCards(
    g: Game, s: Player, cs: Card[], min: number, max: number, p: string, o?: ChooseCardsOpts,
  ) {
    await this.tick(); return this.inner.chooseCards(g, s, cs, min, max, p, o);
  }
  async choosePlayers(
    g: Game, s: Player, cs: Player[], min: number, max: number, p: string, o?: ChoosePlayersOpts,
  ) {
    await this.tick(); return this.inner.choosePlayers(g, s, cs, min, max, p, o);
  }
  async chooseOption(g: Game, s: Player, o: string[], p: string, cancelable?: boolean, c?: OptionCtx) {
    await this.tick(); return this.inner.chooseOption(g, s, o, p, cancelable, c);
  }
  async arrangeCards(g: Game, s: Player, cs: Card[], p: string) {
    await this.tick(); return this.inner.arrangeCards(g, s, cs, p);
  }
  async chooseSuit(g: Game, s: Player, p: string): Promise<Suit> {
    await this.tick(); return this.inner.chooseSuit(g, s, p);
  }
}
