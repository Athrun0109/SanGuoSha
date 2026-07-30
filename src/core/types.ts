/** 基础类型定义:花色、牌、势力、身份、阶段 */

export type Suit = '♠' | '♥' | '♣' | '♦' | 'none';
export type Color = 'red' | 'black' | 'none';

export const SUITS: Suit[] = ['♠', '♥', '♣', '♦'];

export function suitColor(s: Suit): Color {
  if (s === '♥' || s === '♦') return 'red';
  if (s === '♠' || s === '♣') return 'black';
  return 'none';
}

export type Kingdom = 'wei' | 'shu' | 'wu' | 'qun';
export const KINGDOM_NAME: Record<Kingdom, string> = {
  wei: '魏', shu: '蜀', wu: '吴', qun: '群',
};

export type Gender = 'male' | 'female';

/** 身份:主公 / 忠臣 / 反贼 / 内奸 */
export type Role = 'lord' | 'loyalist' | 'rebel' | 'renegade';
export const ROLE_NAME: Record<Role, string> = {
  lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸',
};

export type CardType = 'basic' | 'trick' | 'equip';
export type EquipSlot = 'weapon' | 'armor' | 'horse+1' | 'horse-1';

export type Phase = 'start' | 'judge' | 'draw' | 'play' | 'discard' | 'end';
export const PHASE_ORDER: Phase[] = ['start', 'judge', 'draw', 'play', 'discard', 'end'];
export const PHASE_NAME: Record<Phase, string> = {
  start: '准备阶段', judge: '判定阶段', draw: '摸牌阶段',
  play: '出牌阶段', discard: '弃牌阶段', end: '结束阶段',
};

/** 实体牌:牌堆里唯一存在的一张 */
export interface Card {
  readonly id: number;
  readonly name: string;
  readonly suit: Suit;
  /** 1..13,其中 1=A 11=J 12=Q 13=K */
  readonly rank: number;
}

export function rankName(r: number): string {
  return ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' } as Record<number, string>)[r] ?? String(r);
}

export function cardLabel(c: Card): string {
  return `${c.name}[${c.suit}${rankName(c.rank)}]`;
}

/**
 * 虚拟牌:引擎中一切"被使用/被打出"的东西都是虚拟牌。
 * - 直接用一张实体【杀】 -> { name:'杀', cards:[实体杀] }
 * - 关羽武圣把红桃K当杀   -> { name:'杀', cards:[红桃K], skill:'武圣' }
 * - 丈八蛇矛两张牌当杀     -> { name:'杀', cards:[牌A,牌B], skill:'丈八蛇矛' }
 */
export interface VirtualCard {
  name: string;
  suit: Suit;
  rank: number;
  /** 组成这张虚拟牌的实体牌(可能为空,表示无实体来源) */
  cards: Card[];
  /** 转化来源的技能名,null 表示就是原牌 */
  skill?: string;
}

/** 由实体牌直接构造虚拟牌 */
export function realCard(c: Card): VirtualCard {
  return { name: c.name, suit: c.suit, rank: c.rank, cards: [c] };
}

/** 由若干实体牌转化出一张虚拟牌;单张时继承花色点数,多张时视为无花色 */
export function viewAsCard(name: string, cards: Card[], skill: string): VirtualCard {
  const single = cards.length === 1 ? cards[0] : null;
  return {
    name,
    suit: single ? single.suit : 'none',
    rank: single ? single.rank : 0,
    cards: [...cards],
    skill,
  };
}

export function vcColor(v: VirtualCard): Color {
  return suitColor(v.suit);
}

export function vcLabel(v: VirtualCard): string {
  const base = v.suit === 'none' ? v.name : `${v.name}[${v.suit}${rankName(v.rank)}]`;
  return v.skill ? `${base}(${v.skill})` : base;
}

/** 响应/求牌时用的匹配条件 */
export interface CardPattern {
  /** 允许的牌名,如 ['闪'] */
  names?: string[];
  /** 允许的类型 */
  types?: CardType[];
  suits?: Suit[];
  colors?: Color[];
  /** 自定义额外条件 */
  extra?: (v: VirtualCard) => boolean;
}

export function patternText(p: CardPattern): string {
  if (p.names?.length) return `【${p.names.join('/')}】`;
  if (p.colors?.length) return `${p.colors.map(c => (c === 'red' ? '红色' : '黑色')).join('/')}牌`;
  if (p.types?.length) return p.types.join('/');
  return '一张牌';
}
