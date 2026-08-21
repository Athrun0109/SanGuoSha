/**
 * 时机(Timing)与事件对象。
 *
 * 这是整个引擎的骨架:所有武将技能都只是"在某个时机上挂一个回调"。
 * 想 DIY 新技能时,先在这里找一个合适的时机;如果没有,就加一个新的字符串时机,
 * 然后在 game.ts 里对应的位置调用 `await this.trigger('新时机', ev)`。
 */

import type { Card, VirtualCard, Phase, Suit } from './types.js';
import type { Player } from './player.js';

export type Timing =
  // —— 流程 ——
  | 'GameStart'          // 游戏开始
  | 'TurnStart'          // 回合开始
  | 'TurnEnd'            // 回合结束
  | 'PhaseStart'         // 某阶段开始(ev.phase)
  | 'PhaseEnd'           // 某阶段结束(ev.phase)
  | 'DrawNumber'         // 摸牌阶段确定摸牌数(可改 ev.num)
  // —— 用牌 ——
  | 'CardUsing'          // 牌即将使用(可 ev.cancel = true 取消)
  | 'CardUsed'           // 牌已使用(实体牌已离开手牌)
  | 'CardResponded'      // 牌被打出以响应
  | 'TargetConfirming'   // 目标确认中(流离:可改 ev.to)
  | 'TargetConfirmed'    // 目标已确认(铁骑等)
  | 'CardEffecting'      // 对某目标即将生效(可 ev.cancel)
  | 'CardEffected'       // 对某目标生效完毕
  | 'SlashMissed'        // 杀被闪避(青龙偃月刀/贯石斧)
  | 'AskingForCard'      // 引擎向某人求牌(护驾/激将:可直接写 ev.result)
  // —— 体力 ——
  | 'DamageInflicting'   // 伤害即将造成(可改 ev.amount / ev.cancel)
  // 下面这两个**跨在濒死结算的两侧**,不是同义词。改动前先看 game.damage() 里的注释:
  | 'DamageDealt'        // 造成伤害时,**濒死之前**(伤害来源视角:麒麟弓)
  | 'DamageDone'         // 受到伤害后,**濒死之后、且活下来才触发**
                         //   (受伤者视角:奸雄/反馈/刚烈/遗计)
  | 'HpLost'             // 失去体力
  | 'HpRecovered'        // 回复体力
  | 'Dying'              // 濒死
  | 'Died'               // 死亡
  // —— 判定 ——
  | 'JudgeResulting'     // 判定牌生效前(鬼才:可改 ev.card)
  | 'JudgeResulted'      // 判定牌生效后(天妒)
  // —— 移牌 ——
  | 'CardsMoved';        // 牌在区域间移动(枭姬/连营)

/** 所有事件的公共部分 */
export interface BaseEvent {
  timing?: Timing;
  /** 已经响应过本事件的 (角色, 技能) 组合,防止重复触发 */
  _fired?: Set<string>;
}

export interface PhaseEvent extends BaseEvent {
  player: Player;
  phase: Phase;
  /** 置 true 可跳过该阶段的默认流程(如乐不思蜀跳过出牌阶段) */
  skipped?: boolean;
}

export interface DrawNumberEvent extends BaseEvent {
  player: Player;
  num: number;
  /** 置 true 表示摸牌阶段被技能完全替代(如张辽突袭) */
  cancel?: boolean;
}

/** 一次"使用牌"的完整上下文 */
export interface CardUseEvent extends BaseEvent {
  card: VirtualCard;
  from: Player;
  targets: Player[];
  cancel?: boolean;
  /** 对这些目标不可被闪避(铁骑/贯石斧) */
  unavoidable?: Set<Player>;
  /** 本次使用需要的额外闪数量(无双) */
  extraDodge?: number;
  /**
   * 这一次使用能不能被【无懈可击】拦。默认能(锦囊);写 false 就跳过那个窗口。
   *
   * 和 `spec.nullifiable` 的区别:那个是**牌的属性**(这张牌永远不可无懈),
   * 这个是**这一次使用的属性** —— 同样一张【决斗】,自己出的可以被无懈,
   * 由【离间】视为使用的那张不行。
   */
  nullifiable?: boolean;
  /** 响应链上的附加数据,技能之间可自由约定 */
  tags: Record<string, any>;
}

export interface TargetEvent extends BaseEvent {
  use: CardUseEvent;
  from: Player;
  to: Player;
  cancel?: boolean;
}

export interface CardRespondEvent extends BaseEvent {
  card: VirtualCard;
  player: Player;
  /** 求牌的用途标签,如 'dodge' | 'slash' | 'peach' | 'nullify' */
  purpose: string;
}

export interface AskForCardEvent extends BaseEvent {
  player: Player;
  purpose: string;
  prompt: string;
  /** 技能可直接写入结果代替本人出牌(护驾/激将) */
  result?: VirtualCard | null;
}

export interface DamageEvent extends BaseEvent {
  from: Player | null;
  to: Player;
  amount: number;
  /** 造成伤害的牌(可能为空,如刚烈) */
  card?: VirtualCard | null;
  reason?: string;
  cancel?: boolean;
}

export interface HpEvent extends BaseEvent {
  player: Player;
  amount: number;
  source?: Player | null;
  reason?: string;
}

export interface DyingEvent extends BaseEvent {
  player: Player;
  source: Player | null;
  /** 已被救回则为 true */
  saved?: boolean;
}

export interface DeathEvent extends BaseEvent {
  player: Player;
  killer: Player | null;
}

export interface JudgeEvent extends BaseEvent {
  player: Player;
  /** 判定原因,如 '闪电' '乐不思蜀' '刚烈' '洛神' */
  reason: string;
  card: Card;
  /** 判定成功与否的裁定函数 */
  check: (c: Card) => boolean;
  /** 判定结果(check 的返回值),在 JudgeResulted 时可读 */
  success?: boolean;
  /** 若被技能拿走(天妒),置 true 让引擎不再弃置 */
  taken?: boolean;
}

export type Zone = 'hand' | 'equip' | 'judge' | 'deck' | 'discard' | 'processing';

export interface MovedCard {
  card: Card;
  from: Player | null;
  fromZone: Zone;
  to: Player | null;
  toZone: Zone;
}

export interface CardsMovedEvent extends BaseEvent {
  moves: MovedCard[];
  reason: string;
}

export type AnyEvent =
  | PhaseEvent | DrawNumberEvent | CardUseEvent | TargetEvent | CardRespondEvent
  | AskForCardEvent | DamageEvent | HpEvent | DyingEvent | DeathEvent
  | JudgeEvent | CardsMovedEvent | BaseEvent;

/** 判定常用裁定函数 */
export const judgeIsRed = (c: Card) => c.suit === '♥' || c.suit === '♦';
export const judgeIsBlack = (c: Card) => c.suit === '♠' || c.suit === '♣';
export const judgeSuit = (s: Suit) => (c: Card) => c.suit === s;
export const judgeNotSuit = (s: Suit) => (c: Card) => c.suit !== s;
