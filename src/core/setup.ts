import { Game, GameOptions, RNG } from './game.js';
import { Player } from './player.js';
import type { Role } from './types.js';
import { generals } from './registry.js';
import { buildDeck } from '../content/cards.js';
import { LORD_GENERALS, STANDARD_GENERALS } from '../content/generals.js';
import type { Agent } from './agent.js';

/** 各人数下的身份配置 */
export const ROLE_TABLE: Record<number, Role[]> = {
  2: ['lord', 'rebel'],
  3: ['lord', 'rebel', 'renegade'],
  4: ['lord', 'loyalist', 'rebel', 'renegade'],
  5: ['lord', 'loyalist', 'rebel', 'rebel', 'renegade'],
  6: ['lord', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'],
  7: ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'renegade'],
  8: ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'renegade'],
};

export interface SetupOptions extends GameOptions {
  playerCount?: number;
  /** 座位 -> agent 工厂 */
  makeAgent: (p: Player, index: number) => Agent;
  /** 手动点将:座位 -> 武将名,如 { 0: '刘备', 3: '吕布' }。没指定的座位随机 */
  fixedGenerals?: Record<number, string>;
  /** 主公额外体力上限加成(身份局默认 +1) */
  lordBonusHp?: boolean;
  /**
   * 起始手牌数。数字 = 所有人相同;数组 = 按座位指定。
   * 默认多人局每人 4 张;**1v1 默认 [4, 5],即后手补 1 张**。
   *
   * 后手补牌是先手优势的补偿。规则 AI 互打 3000 局实测:
   *   不补        先手 61.0%
   *   后手 +1     先手 53.1% ± 1.8   ← 默认值
   *   后手 +2     先手 45.4% ± 1.8
   * 每张牌大约值 6~8 个百分点。这个标定是基于当前这个规则 AI 的,
   * 换更强的对手(或者手动点将改变了双方强弱)之后应该重新扫一遍。
   */
  startingHand?: number | number[];
}

/** 1v1 默认后手补 1 张 —— 详见 SetupOptions.startingHand 的实测数据 */
export const DUEL_HANDICAP = 1;

/** 起始手牌数,默认每人 4 张 */
export function resolveStartingHands(n: number, spec?: number | number[]): number[] {
  const out = new Array(n).fill(4);
  if (typeof spec === 'number') return out.fill(Math.max(0, Math.round(spec)));
  if (Array.isArray(spec)) {
    for (let i = 0; i < n; i++) {
      if (typeof spec[i] === 'number') out[i] = Math.max(0, Math.round(spec[i]));
    }
  }
  return out;
}

/**
 * 解析命令行/工具参数里的点将串,如 "关羽,,吕布" —— 空位表示随机。
 * 支持用武将名,不认识的名字会抛出带候选列表的错误。
 */
export function parseGeneralSpec(spec: string | string[] | undefined, n: number): Record<number, string> | undefined {
  if (!spec) return undefined;
  const items = (Array.isArray(spec) ? spec : spec.split(',')).map(x => x.trim());
  const out: Record<number, string> = {};
  const bad: string[] = [];
  for (let i = 0; i < Math.min(items.length, n); i++) {
    if (!items[i]) continue;
    if (!generals.has(items[i])) { bad.push(items[i]); continue; }
    out[i] = items[i];
  }
  if (bad.length) {
    throw new Error(`没有这些武将:${bad.join('、')}
可选:${[...generals.keys()].join(' ')}`);
  }
  return Object.keys(out).length ? out : undefined;
}

export function createGame(opts: SetupOptions): Game {
  const n = opts.playerCount ?? 8;
  const roles = ROLE_TABLE[n];
  if (!roles) throw new Error(`不支持 ${n} 人局`);

  const game = new Game(opts);
  const rng = game.rng;

  // 身份:0 号位固定为主公,其余打乱
  const rest = rng.shuffle(roles.slice(1));
  const finalRoles: Role[] = ['lord', ...rest];

  // 武将
  const pool = rng.shuffle([...STANDARD_GENERALS]);
  const usedNames = new Set<string>();

  for (let i = 0; i < n; i++) {
    const p = new Player(i, `${i}号位`);
    p.role = finalRoles[i];

    let gname = opts.fixedGenerals?.[i]?.trim();
    if (!gname) {
      if (p.role === 'lord') {
        const lordPool = rng.shuffle([...LORD_GENERALS]);
        gname = lordPool.find(g => !usedNames.has(g))!;
      } else {
        gname = pool.find(g => !usedNames.has(g))!;
      }
    }
    usedNames.add(gname);

    const def = generals.get(gname);
    if (!def) {
      throw new Error(`没有这个武将:${gname}
可选:${[...generals.keys()].join(' ')}`);
    }
    p.general = def;
    p.kingdom = def.kingdom;
    p.gender = def.gender;
    p.skills = [...def.skills];
    p.maxHp = def.hp + (p.role === 'lord' && (opts.lordBonusHp ?? true) && n > 2 ? 1 : 0);
    p.hp = p.maxHp;
    p.name = `${i}号位·${def.name}`;
    if (p.role === 'lord') p.revealed = true;

    game.players.push(p);
    game.agents.set(p, opts.makeAgent(p, i));
  }

  // 牌堆
  game.deck = rng.shuffle(buildDeck());
  game.current = game.players[0];

  // 起始手牌(1v1 的后手补牌就在这里生效)
  const defaultHand = n === 2 ? [4, 4 + DUEL_HANDICAP] : undefined;
  const hands = resolveStartingHands(n, opts.startingHand ?? defaultHand);
  for (let i = 0; i < n; i++) {
    game.players[i].hand.push(...game.drawFromDeck(hands[i]));
  }

  return game;
}
