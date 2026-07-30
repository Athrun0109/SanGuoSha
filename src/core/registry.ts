/** 卡牌行为注册表:牌名 -> 行为定义。content/cards.ts 负责填充。 */

import type { Card, CardType, EquipSlot, VirtualCard } from './types.js';
import type { Player } from './player.js';
import type { Game } from './game.js';
import type { CardUseEvent } from './events.js';
import type { Skill, GeneralDef } from './skill.js';

export interface EffectCtx {
  game: Game;
  use: CardUseEvent;
  from: Player;
  to: Player;
}

export interface CardSpec {
  name: string;
  type: CardType;
  slot?: EquipSlot;
  /** 最少 / 最多目标数(不含自动目标);可以是函数(方天画戟改变杀的目标上限) */
  targetMin: number | ((game: Game, from: Player, card: VirtualCard) => number);
  targetMax: number | ((game: Game, from: Player, card: VirtualCard) => number);
  /** 自动确定的目标(AOE、指向自己的牌);有此项则不再询问 */
  autoTargets?: (game: Game, from: Player, card: VirtualCard) => Player[];
  /** 目标合法性 */
  targetFilter?: (game: Game, from: Player, to: Player, card: VirtualCard, selected: Player[]) => boolean;
  /** 距离限制:'attack' = 攻击范围内;数字 = 距离不大于该值;省略 = 无限制 */
  range?: 'attack' | number;
  /** 出牌阶段能否使用 */
  canUse?: (game: Game, from: Player, card: VirtualCard) => boolean;
  /** 能否被无懈可击响应(锦囊默认 true) */
  nullifiable?: boolean;
  /** 对每个目标生效 */
  onEffect?: (ctx: EffectCtx) => Promise<void>;
  /** 装备牌装备后获得的技能 */
  equipSkills?: Skill[];
  /** 延时锦囊:在判定阶段处理 */
  delayed?: (game: Game, player: Player, card: Card) => Promise<void>;
  /**
   * 延时锦囊被【无懈可击】抵消后怎么处理这张牌。默认弃置(乐不思蜀就是这样),
   * 但【闪电】不一样 —— 被无懈之后它要**移到下家判定区**,而不是消失。
   */
  onNullified?: (game: Game, player: Player, card: Card) => Promise<void>;
}

export const cardSpecs = new Map<string, CardSpec>();

export function defineCard(spec: CardSpec) {
  cardSpecs.set(spec.name, spec);
  return spec;
}

export function getSpec(name: string): CardSpec {
  const s = cardSpecs.get(name);
  if (!s) throw new Error(`未注册的卡牌:${name}`);
  return s;
}

export const generals = new Map<string, GeneralDef>();

export function defineGeneral(g: GeneralDef) {
  generals.set(g.name, g);
  return g;
}
