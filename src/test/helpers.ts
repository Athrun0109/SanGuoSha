import '../content/cards.js';
import '../content/generals.js';
import { Game } from '../core/game.js';
import { Player } from '../core/player.js';
import { createGame } from '../core/setup.js';
import { Card, Suit, VirtualCard } from '../core/types.js';
import type { Agent, CardOption, OptionCtx, PlayAction, ResponseCtx } from '../core/agent.js';
import { buildDeck } from '../content/cards.js';

/**
 * 测试用的可编程 agent:
 *  - respond: 决定响应类求牌时返回哪个选项(默认 0,即总是出牌);设为 -1 表示放弃
 *  - option / players / cards 同理
 */
export class ScriptAgent implements Agent {
  readonly id = 'script';
  respond: (opts: CardOption[], prompt: string, ctx?: ResponseCtx) => number = () => 0;
  option: (opts: string[], prompt: string, ctx?: OptionCtx) => number = () => 0;
  playAction: (acts: PlayAction[]) => number = (a) => a.length - 1; // 默认直接结束出牌阶段

  async choosePlayAction(g: Game, s: Player, acts: PlayAction[]) { return this.playAction(acts); }
  async chooseResponse(g: Game, s: Player, o: CardOption[], p: string, f: boolean, ctx?: ResponseCtx) {
    return this.respond(o, p, ctx);
  }
  async chooseCards(g: Game, s: Player, cards: Card[], min: number, max: number) {
    return cards.slice(0, Math.max(min, 0));
  }
  async choosePlayers(g: Game, s: Player, c: Player[], min: number, max: number) {
    return c.slice(0, Math.max(min, 0));
  }
  async chooseOption(g: Game, s: Player, o: string[], p: string, cancelable?: boolean, ctx?: OptionCtx) {
    return this.option(o, p, ctx);
  }
  async chooseSuit() { return '♥' as Suit; }
  async arrangeCards(g: Game, s: Player, cards: Card[]) { return { top: cards, bottom: [] }; }
}

export function mkGame(fixedGenerals: Record<number, string>, playerCount = 3) {
  const agents: ScriptAgent[] = [];
  const game = createGame({
    playerCount,
    seed: 42,
    verbose: false,
    fixedGenerals,
    lordBonusHp: false,
    makeAgent: () => { const a = new ScriptAgent(); agents.push(a); return a; },
  });
  // 清空起始手牌,测试里手动发牌
  for (const p of game.players) p.hand = [];
  game.current = game.players[0];
  return { game, agents };
}

/** 造一张指定的实体牌并放进某人手里 */
export function give(game: Game, p: Player, name: string, suit: Suit = '♠', rank = 7): Card {
  const c: Card = { id: 9000 + Math.floor(Math.random() * 100000), name, suit, rank };
  p.hand.push(c);
  return c;
}

/** 把牌堆顶换成指定的牌(控制判定结果) */
export function stackDeck(game: Game, cards: Array<[string, Suit, number]>) {
  const made = cards.map(([name, suit, rank], i) => ({ id: 8000 + i, name, suit, rank } as Card));
  game.deck.unshift(...made);
  return made;
}

export { buildDeck };
