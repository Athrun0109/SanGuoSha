/**
 * 记牌器 —— 人和 LLM 共用。
 *
 * 核心:**每次从当前状态推导,不做累加**。
 * 因为牌堆用尽时弃牌堆会整个洗回牌堆,任何"已出现牌"的累计计数都会在那一刻失效;
 * 而从区域内容推导的结果会自动跟着变。
 *
 *   未知牌池 = 牌堆 + 其他人的暗置手牌
 *   某牌未现身数 = 牌堆配比总数 − 弃牌堆 − 结算区 − 所有装备区 − 所有判定区
 *                              − 你的手牌 − 已公开的他人手牌
 */

import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { DECK_TABLE } from '../content/cards.js';
import { getSpec } from '../core/registry.js';

/** 坐骑按"防御马 / 进攻马"归组统计 —— 玩家关心的是类型不是马名 */
export function countGroup(name: string): string {
  const spec = getSpec(name);
  if (spec.slot === 'horse+1') return '防御马';
  if (spec.slot === 'horse-1') return '进攻马';
  return name;
}

let TOTALS: Map<string, number> | null = null;
function totals(): Map<string, number> {
  if (TOTALS) return TOTALS;
  TOTALS = new Map();
  for (const [name] of DECK_TABLE) {
    const g = countGroup(name);
    TOTALS.set(g, (TOTALS.get(g) ?? 0) + 1);
  }
  return TOTALS;
}

export interface CountRow {
  /** 归组后的牌名 */
  group: string;
  /** 牌堆配比里一共几张 */
  total: number;
  /** 已经确定位置的(弃牌堆/装备/判定区/你的手牌/已公开的他人手牌) */
  known: number;
  /** 还沉在未知牌池里的 */
  unknown: number;
}

export interface CardCount {
  rows: CountRow[];
  /** 未知牌池总量 = 牌堆 + 其他人暗置手牌 */
  poolSize: number;
  deckSize: number;
  /** 其他人的暗置手牌总数 */
  hiddenHands: number;
  /** 下一张摸到该牌的概率(0~1) */
  drawChance(group: string): number;
  /** 某人手上至少有一张该牌的概率(超几何分布) */
  holdChance(target: Player, group: string): number;
  get(group: string): CountRow | undefined;
}

export function countCards(game: Game, observer: Player): CardCount {
  const known = new Map<string, number>();
  const bump = (name: string) => {
    const g = countGroup(name);
    known.set(g, (known.get(g) ?? 0) + 1);
  };

  for (const c of game.discardPile) bump(c.name);
  for (const c of game.processing) bump(c.name);
  for (const p of game.players) {
    for (const c of p.equipCards) bump(c.name);
    for (const c of p.judgeZone) bump(c.name);
  }
  for (const c of observer.hand) bump(c.name);
  // 公开进入他人手牌的牌(五谷取走的、反间展示的…)
  let publicOthers = 0;
  for (const [id, owner] of game.publicHandCards) {
    if (owner === observer) continue;
    const card = owner.hand.find(c => c.id === id);
    if (!card) continue;
    bump(card.name);
    publicOthers++;
  }

  const hiddenHands = game.players
    .filter(p => p !== observer)
    .reduce((s, p) => s + p.handCount, 0) - publicOthers;
  const poolSize = game.deck.length + Math.max(0, hiddenHands);

  const rows: CountRow[] = [];
  for (const [group, total] of totals()) {
    const k = known.get(group) ?? 0;
    rows.push({ group, total, known: k, unknown: Math.max(0, total - k) });
  }
  rows.sort((a, b) => b.unknown - a.unknown || a.group.localeCompare(b.group));

  const byGroup = new Map(rows.map(r => [r.group, r]));
  const unknownOf = (g: string) => byGroup.get(g)?.unknown ?? 0;

  return {
    rows,
    poolSize,
    deckSize: game.deck.length,
    hiddenHands: Math.max(0, hiddenHands),
    get: (g) => byGroup.get(g),
    drawChance(g) {
      return poolSize > 0 ? unknownOf(g) / poolSize : 0;
    },
    /**
     * P(target 手上至少一张 g)= 1 − C(pool−k, h)/C(pool, h)
     * 用连乘算,避免组合数溢出。
     */
    holdChance(target, g) {
      if (target === observer) {
        return observer.hand.some(c => countGroup(c.name) === g) ? 1 : 0;
      }
      const k = unknownOf(g);
      let h = target.handCount;
      for (const [id, owner] of game.publicHandCards) {
        if (owner !== target) continue;
        const card = target.hand.find(c => c.id === id);
        if (!card) continue;
        h--;
        if (countGroup(card.name) === g) return 1; // 已知他手上就有
      }
      if (h <= 0 || k <= 0 || poolSize <= 0) return 0;
      let none = 1;
      for (let i = 0; i < h; i++) {
        const remain = poolSize - i;
        if (remain <= 0) return 1;
        none *= Math.max(0, remain - k) / remain;
      }
      return 1 - none;
    },
  };
}

/** 给人看的记牌器面板 */
export function formatCounter(count: CardCount, game: Game, observer: Player): string {
  const head = `牌堆${count.deckSize} + 他人暗牌${count.hiddenHands} = 未知牌池${count.poolSize}`;
  const rows = count.rows
    .filter(r => r.unknown > 0)
    .map(r => `${r.group}×${r.unknown}`)
    .join('  ');
  const threats = game.others(observer)
    .map(p => {
      const d = Math.round(count.holdChance(p, '闪') * 100);
      const s = Math.round(count.holdChance(p, '杀') * 100);
      const t = Math.round(count.holdChance(p, '桃') * 100);
      return `  ${p.name}(${p.handCount}张) 有闪${d}% 有杀${s}% 有桃${t}%`;
    })
    .join('\n');
  return `【记牌器】${head}\n未现身:${rows || '(无)'}\n${threats}`;
}
