/**
 * 技能系统 —— 这是你 DIY 时唯一需要动的地方。
 *
 * 一个技能只可能是下面四种之一:
 *
 *  1. triggered  触发技:在某个时机自动/可选地发动。       例:奸雄、遗计、连营
 *  2. active     主动技:出牌阶段主动点的技能。            例:制衡、苦肉、离间
 *  3. viewAs     转化技:把手里的牌当成另一张牌用/打出。    例:武圣、龙胆、倾国
 *  4. static     状态技:持续修改某个数值或规则(查询表)。 例:马术、咆哮、空城、无双
 *
 * 改强度最常见的三种做法:
 *   - 数值:直接改 effect 里的数字(如遗计发 X 张 -> X+1 张)
 *   - 频率:改 limit('once-per-turn' / 'once-per-round' / undefined 表示无限)
 *   - 条件:改 filter / canUse
 */

import type { Card, CardPattern, Gender, Kingdom, VirtualCard } from './types.js';
import type { Player } from './player.js';
import type { Game } from './game.js';
import type { Timing } from './events.js';

export type SkillLimit = 'once-per-turn' | 'once-per-round' | 'once-per-phase' | 'once-per-game';

interface SkillBase {
  name: string;
  /** 说明文本,CLI 里展示给玩家看 */
  desc?: string;
  /** 锁定技:满足条件必定发动,不询问 */
  compulsory?: boolean;
  /** 发动频率限制 */
  limit?: SkillLimit;
  /** 主公技:只有身份为主公时生效 */
  lordSkill?: boolean;
  /** 同一时机下的发动顺序,数字大的先(默认 0) */
  priority?: number;
}

/** 触发技上下文 */
export interface TriggerCtx<E = any> {
  game: Game;
  /** 技能拥有者 */
  self: Player;
  /** 事件对象,具体类型见 events.ts */
  event: E;
  timing: Timing;
}

export interface TriggeredSkill extends SkillBase {
  kind: 'triggered';
  timing: Timing | Timing[];
  /** 返回 true 表示满足发动条件 */
  filter: (ctx: TriggerCtx) => boolean;
  effect: (ctx: TriggerCtx) => Promise<void> | void;
}

export interface ActiveSkill extends SkillBase {
  kind: 'active';
  /** 出牌阶段能否点这个技能 */
  canUse: (game: Game, self: Player) => boolean;
  /**
   * 技能自己负责询问目标、弃牌等一切交互。
   *
   * **返回 false = 玩家中途反悔了**,这次不算发动:限定次数不扣、战报里说明是取消。
   * 以前一律算发动 —— 点了【离间】之后发现弃不起那张牌,想退回去,
   * 本回合的一次机会已经没了,而且什么都没发生。
   */
  onUse: (game: Game, self: Player) => Promise<void | false>;
}

/** 转化技的使用场景 */
export interface ViewAsContext {
  /** 'play' = 出牌阶段主动使用;'respond' = 被要求打出/使用 */
  mode: 'play' | 'respond';
  /** respond 模式下要求的牌型 */
  pattern?: CardPattern;
  /** 求牌用途标签,如 'dodge' 'peach' 'nullify' 'slash' */
  purpose?: string;
}

export interface ViewAsSkill extends SkillBase {
  kind: 'viewAs';
  /** 该技能能产出的牌名(用于快速判断能否响应),如 ['杀'] */
  produces: string[];
  /**
   * 素材从哪里拿。默认 `'hand'` 只认手牌。
   *
   * 官方裁定:技能写「一张**红色牌**」(武圣)、「一张**黑色牌**」(奇袭)、
   * 「一张**♦牌**」(国色)时,装备区里的牌同样算数 —— 关羽可以把赤兔马当【杀】出。
   * 写明「手**牌**」的(甄姬倾国、丈八蛇矛)才只能用手牌。
   *
   * 默认保守取 'hand':漏开一个只是少一种打法,误开则是凭空多出规则里没有的用法。
   */
  zone?: 'hand' | 'all';
  /** 哪些实体牌可以被选作素材 */
  cardFilter: (game: Game, self: Player, card: Card, selected: Card[], ctx: ViewAsContext) => boolean;
  /** 需要恰好几张素材牌;返回 0 表示不需要实体牌 */
  cardCount: number;
  /** 素材凑齐后产出什么虚拟牌;返回 null 表示不成立 */
  viewAs: (game: Game, self: Player, cards: Card[], ctx: ViewAsContext) => VirtualCard | null;
  /** 该场景下能否使用本转化技 */
  available: (game: Game, self: Player, ctx: ViewAsContext) => boolean;
}

/**
 * 状态技:通过"查询"影响规则。引擎会在关键位置调用 game.sumQuery / game.anyQuery。
 *
 * 目前引擎支持的查询名(owner 表示该查询读谁的技能):
 *   数值类(所有贡献相加):
 *     'attackRange'      owner=自己       攻击范围加成(武器)
 *     'distanceDelta'    owner=起点       你算与别人的距离 -N(马术、进攻马)
 *     'distanceFromDelta'owner=终点       别人算与你的距离 +N(防御马)
 *     'slashExtraTargets'owner=使用者     这张杀可以多指定几个目标(方天画戟)
 *                                         ctx.card 是这张杀,别只看手牌数
 *     'extraDodge'       owner=杀的使用者 目标需要多打出几张闪(无双 = +1)
 *     'extraSlash'       owner=决斗发起者 对方每次需多打出几张杀(无双 = +1)
 *     'maxHand'          owner=自己       手牌上限加成 —— **目前没有技能产出**
 *     'slashLimit'       owner=使用者     杀的次数加成 —— **目前没有技能产出**
 *     'peachRecover'     owner=被救者     一张桃回复的体力 —— **目前没有技能产出**
 *                                         (孙权【救援】是自己再 recover 一次,没走这里)
 *   布尔类(任一为 true 即成立):
 *     'prohibitTarget' owner=目标         该角色不能成为这张牌的目标(空城/谦逊)
 *     'ignoreDistance' owner=使用者       使用该牌无距离限制(奇才)
 *     'ignoreArmor'    owner=使用者       无视目标防具(青釭剑)
 *     'invalidToTarget'owner=目标         该牌对自己无效(仁王盾)
 *     'noSlashLimit'   owner=使用者       杀无次数限制(咆哮/诸葛连弩)
 *     'skipDiscard'    owner=自己         跳过弃牌阶段 —— **目前没有技能产出**
 *                                         (吕蒙【克己】走的是 triggered,不是这里)
 *
 * 注:标了"目前没有技能产出"的四个只有调用点、没有生产者。别拿这份清单当
 * "引擎支持什么"的依据 —— 它只说明**挂钩在哪**,真要用先确认调用点还在。
 *
 * 想加新规则杠杆:在这里加一个查询名,然后在 game.ts 相应位置调用一次即可。
 */
export interface StaticSkill extends SkillBase {
  kind: 'static';
  queries: Record<string, (game: Game, self: Player, ctx: any) => number | boolean | undefined>;
}

export type Skill = TriggeredSkill | ActiveSkill | ViewAsSkill | StaticSkill;

export interface GeneralDef {
  name: string;
  kingdom: Kingdom;
  gender: Gender;
  /** 体力上限(主公为 lord 时通常 +1,由 game 处理) */
  hp: number;
  skills: Skill[];
  /** 是否为主公专属加成(标准包主公额外 +1 体力上限的是 4 血主公) */
  lordBonus?: boolean;
}

// —————————————————————— 便捷构造器 ——————————————————————

export function triggered(s: Omit<TriggeredSkill, 'kind'>): TriggeredSkill {
  return { kind: 'triggered', ...s };
}

export function active(s: Omit<ActiveSkill, 'kind'>): ActiveSkill {
  return { kind: 'active', ...s };
}

export function viewAs(s: Omit<ViewAsSkill, 'kind'>): ViewAsSkill {
  return { kind: 'viewAs', ...s };
}

export function staticSkill(s: Omit<StaticSkill, 'kind'>): StaticSkill {
  return { kind: 'static', ...s };
}

/** 生成技能发动次数的 mark key */
export function limitKey(skill: SkillBase): string | null {
  switch (skill.limit) {
    case 'once-per-turn': return `turn:skill:${skill.name}`;
    case 'once-per-phase': return `phase:skill:${skill.name}`;
    case 'once-per-round': return `round:skill:${skill.name}`;
    case 'once-per-game': return `game:skill:${skill.name}`;
    default: return null;
  }
}
