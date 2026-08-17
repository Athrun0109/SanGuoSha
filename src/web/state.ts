/**
 * 把 Game 序列化成浏览器要的视图状态。
 *
 * **这个文件是隐藏信息的唯一关口。** 推给前端的是一份完整快照,漏写一个字段就等于开图,
 * 所以规则集中在这里一处,并且由 web.test.ts 断言:除了视角座位自己,payload 里
 * 不出现任何人的手牌牌名。之前 MCP 那次泄露 LLM 手牌就是因为呈现逻辑散在多处。
 *
 * 三条可见性规则:
 *   手牌明细  只有视角座位自己看得到(以及被【反间】之类公开过的单张)
 *   身份      p.revealed 为准 —— 主公开局明示,阵亡时翻开
 *   势力      始终可见(武将一亮就知道)。国战的暗将留了 hidden 位,现在恒为 false
 */

import type { Game } from '../core/game.js';
import type { WebPending } from './webAgent.js';
import type { Player } from '../core/player.js';
import {
  cardLabel, KINGDOM_NAME, PHASE_NAME, ROLE_NAME, rankName, suitColor,
  type Card, type EquipSlot, type Kingdom, type Role,
} from '../core/types.js';

export const SLOT_NAME: Record<EquipSlot, string> = {
  weapon: '武器', armor: '防具', 'horse+1': '防御马', 'horse-1': '进攻马',
};
const SLOT_ORDER: EquipSlot[] = ['weapon', 'armor', 'horse+1', 'horse-1'];

/** 一张牌拆成前端好渲染的形状 */
export interface CardView {
  id: number;
  name: string;
  suit: string;
  rank: string;
  red: boolean;
}

export interface EquipView {
  slot: EquipSlot;
  slotName: string;
  card: CardView;
}

export interface SeatView {
  seat: number;
  general: string;
  kingdom: Kingdom;
  kingdomName: string;
  /** 国战暗将预留;标准版恒为 false */
  kingdomHidden: boolean;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 身份未明示时为 null —— 不要在前端做这个判断 */
  role: Role | null;
  roleName: string | null;
  handCount: number;
  /** 只有视角座位自己(或 reveal 模式)才有明细 */
  hand: CardView[] | null;
  /** 已被公开过的手牌(如反间展示的那张),所有人可见 */
  knownHand: CardView[];
  equips: EquipView[];
  judge: string[];
  skills: string[];
  isCurrent: boolean;
  isViewer: boolean;
  /** 视角座位到该座位的距离 / 是否在其攻击范围内 */
  distance: number | null;
  inRange: boolean;
}

export interface ViewState {
  seats: SeatView[];
  viewer: number | null;
  reveal: boolean;
  round: number;
  turn: number;
  phase: string;
  phaseName: string;
  current: number | null;
  deck: number;
  discard: number;
  log: string[];
  /**
   * 战报的**真实总行数**(log 只带最近 logTail 行)。
   * 前端拿它判断有没有新内容 —— 用 log.length 是不行的:到了 200 就封顶不动,
   * 于是"长度变了"这个判据永远为假,战报会直接冻住。
   */
  logTotal: number;
  over: boolean;
  winners: number[];
  reason: string;
  /** 视角座位的攻击范围 */
  attackRange: number | null;
  /**
   * 轮到视角座位做决策时的题面。**只有 viewer 自己的题才会出现在这里** ——
   * 由调用方判断归属后传进来(见 SnapshotOptions.pending),这个文件不认识 agent。
   */
  pending: WebPending | null;
}

function cardView(c: Card): CardView {
  return {
    id: c.id, name: c.name, suit: c.suit,
    rank: rankName(c.rank), red: suitColor(c.suit) === 'red',
  };
}

export interface SnapshotOptions {
  /** 视角座位;null = 纯观战(没有"自己") */
  viewer?: number | null;
  /** 开图模式。**必须显式打开**,不能靠默认值 */
  reveal?: boolean;
  logTail?: number;
  /** 结束原因,Game 自己不存,由调用方传进来 */
  reason?: string;
  /**
   * 待视角座位回答的题。**调用方必须先确认这题是 viewer 的**才能传进来 ——
   * 传错了就等于把别人的选项(以及从中能反推的手牌)给了这个视角。
   */
  pending?: WebPending | null;
}

export function snapshot(game: Game, opts: SnapshotOptions = {}): ViewState {
  const { viewer = null, reveal = false, logTail = 200, reason = '', pending = null } = opts;
  const me = viewer === null ? null : game.players[viewer] ?? null;

  const seats = game.players.map((p): SeatView => {
    const own = me !== null && p === me;
    const showHand = own || reveal;
    const showRole = p.revealed || own || reveal;

    return {
      seat: p.seat,
      general: p.general?.name ?? '?',
      kingdom: p.kingdom,
      kingdomName: KINGDOM_NAME[p.kingdom],
      kingdomHidden: false,
      hp: p.hp,
      maxHp: p.maxHp,
      alive: p.alive,
      role: showRole ? p.role : null,
      roleName: showRole ? ROLE_NAME[p.role] : null,
      handCount: p.hand.length,
      hand: showHand ? p.hand.map(cardView) : null,
      // 已公开的单张是公开信息,谁都能看
      knownHand: showHand ? []
        : p.hand.filter(c => game.publicHandCards.get(c.id) === p).map(cardView),
      equips: SLOT_ORDER.flatMap(slot => {
        const c = p.equips[slot];
        return c ? [{ slot, slotName: SLOT_NAME[slot], card: cardView(c) }] : [];
      }),
      // 判定区明置,连实体牌一起给 —— 顺手牵羊拿走的是那张实体牌
      judge: p.judgeZone.map(c => game.judgeLabel(p, c)),
      // 同名技能可能拆成多个对象实现(裸衣 = 少摸一张 + 伤害+1),显示时合并
      skills: [...new Set(p.skills.map(s => s.name))],
      isCurrent: game.current === p && p.alive,
      isViewer: own,
      distance: me && p !== me && me.alive && p.alive ? game.distance(me, p) : null,
      inRange: !!me && p !== me && me.alive && p.alive && game.inAttackRange(me, p),
    };
  });

  return {
    seats,
    viewer,
    // 纯观战没有"自己",也就不可能有属于自己的决策
    pending: viewer === null ? null : pending,
    reveal,
    round: game.round,
    turn: game.turnCount,
    phase: game.phase,
    phaseName: PHASE_NAME[game.phase] ?? game.phase,
    current: game.current?.seat ?? null,
    deck: game.deck.length,
    discard: game.discardPile.length,
    log: game.logLines.slice(-logTail),
    logTotal: game.logLines.length,
    over: game.finished,
    winners: game.winners.map(p => p.seat),
    reason,
    attackRange: me && me.alive ? game.attackRange(me) : null,
  };
}

/**
 * 环形座位的屏幕位置。
 *
 * 逆时针:下家在右,回合沿右侧向上、经顶部、从左侧下来,上家落在左下。
 * 数组第 k 项对应"视角座位 +1+k"号玩家。
 */
const RING_ORDER = ['br', 'r', 'tr', 't', 'tl', 'l', 'bl'] as const;
export type RingSlot = typeof RING_ORDER[number];

const RING_BY_COUNT: Record<number, RingSlot[]> = {
  1: ['t'],
  2: ['tr', 'tl'],
  3: ['r', 't', 'l'],
  4: ['r', 'tr', 'tl', 'l'],
  5: ['r', 'tr', 't', 'tl', 'l'],
  6: ['br', 'r', 'tr', 'tl', 'l', 'bl'],
  7: [...RING_ORDER],
};

/** others = 除视角座位外的人数(1..7) */
export function ringSlots(others: number): RingSlot[] {
  return RING_BY_COUNT[others] ?? [...RING_ORDER].slice(0, others);
}

/** 座位号 -> 屏幕位置。viewer 自己固定在底部('me') */
export function seatSlots(playerCount: number, viewer: number): Record<number, RingSlot | 'me'> {
  const out: Record<number, RingSlot | 'me'> = { [viewer]: 'me' };
  const slots = ringSlots(playerCount - 1);
  for (let k = 0; k < playerCount - 1; k++) {
    out[(viewer + 1 + k) % playerCount] = slots[k];
  }
  return out;
}

export { cardLabel };
