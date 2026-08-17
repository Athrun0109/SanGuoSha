/**
 * 决策接口:人类玩家(CLI)和 AI 都实现它。
 * 引擎从不直接读输入,所有分支都经过这里 —— 所以同一份引擎既能人机对战,也能纯 AI 跑批。
 */

import type { Card, VirtualCard } from './types.js';
import type { Player } from './player.js';
import type { Game } from './game.js';
import type { ActiveSkill, ViewAsContext, ViewAsSkill } from './skill.js';

export type PlayAction =
  | { kind: 'card'; card: VirtualCard; label: string; pick?: PickMaterials }
  | { kind: 'skill'; skill: ActiveSkill; label: string }
  | { kind: 'end'; label: string };

/**
 * 多素材转化的"待定素材"。
 *
 * 丈八蛇矛把任意两张手牌当【杀】,6 张手牌就是 C(6,2)=15 个选项 —— 铺开之后
 * 选项列表从 7 条涨到 22 条,而模型要逐条读、逐条评。实测有一次因此烧了
 * 11,215 个推理 token、等了 109 秒,最后选的还是一张普通装备牌。
 *
 * 所以这类转化**只出一条选项**,选中了再问"用哪两张"。常见情况少十几个选项,
 * 罕见情况(真要用)多一次询问。
 */
export interface PickMaterials {
  skill: ViewAsSkill;
  /** 要选几张素材 */
  count: number;
  /** 可选的素材范围 */
  pool: Card[];
  ctx: ViewAsContext;
}

export interface CardOption {
  /** 多素材待定时,这里是**其中一种组合**的代表 —— 只用来过合法性检查,不代表最终用哪几张 */
  card: VirtualCard;
  label: string;
  pick?: PickMaterials;
}

/** 响应求牌时的上下文,让 AI 能做出有依据的判断 */
export interface ResponseCtx {
  purpose?: string;
  /** 触发本次求牌的用牌事件(如对你使用的那张【杀】) */
  use?: import('./events.js').CardUseEvent;
  /** 无懈可击场景:即将被抵消/恢复的目标 */
  target?: Player | null;
  /** 无懈可击场景:当前是否已被抵消(true 表示你再出无懈会"恢复效果") */
  negated?: boolean;
  /** 濒死场景:濒死的角色 */
  dying?: Player;
}

/** 选项类决策的上下文 */
export interface OptionCtx {
  /** 询问是否发动技能时,这里是技能名与事件 */
  skill?: string;
  event?: any;
  timing?: string;
  /** 其它场景的自定义标签 */
  tag?: string;
}

export interface Agent {
  readonly id: string;
  /** 是否为人类(引擎据此决定要不要打印提示) */
  readonly human?: boolean;

  /** 出牌阶段:从可选动作里挑一个 */
  choosePlayAction(game: Game, self: Player, actions: PlayAction[]): Promise<number>;

  /** 需要打出/使用一张牌来响应(闪、桃、无懈、杀…);返回 -1 表示放弃 */
  chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean,
    ctx?: ResponseCtx,
  ): Promise<number>;

  /** 从一堆牌里选 min..max 张(弃牌、拆牌、素材…) */
  chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
  ): Promise<Card[]>;

  /** 选 min..max 名角色 */
  choosePlayers(
    game: Game, self: Player, candidates: Player[], min: number, max: number, prompt: string,
  ): Promise<Player[]>;

  /** 二选一 / 多选一(文字选项);返回下标,允许返回 -1 表示放弃(当 cancelable) */
  chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean,
    ctx?: OptionCtx,
  ): Promise<number>;

  /** 观星:把牌分配到牌堆顶和牌堆底 */
  arrangeCards(
    game: Game, self: Player, cards: Card[], prompt: string,
  ): Promise<{ top: Card[]; bottom: Card[] }>;

  /** 选一个花色(反间) */
  chooseSuit(game: Game, self: Player, prompt: string): Promise<import('./types.js').Suit>;

  /** 引擎向外播报信息(AI 可忽略) */
  notify?(game: Game, self: Player, message: string): void;
}
