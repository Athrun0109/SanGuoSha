import { Game, GameOptions, RNG } from './game.js';
import { Player } from './player.js';
import { ROLE_NAME, type Role } from './types.js';
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
  /**
   * 手动指定身份:座位 -> 身份,如 { 1: 'renegade' }。没指定的座位从剩余身份里随机。
   *
   * 这是**测试用**的口子 —— "我想看内奸在 1 号位怎么打"这类实验,靠碰运气开局
   * 要跑很多次才轮得到。主公也可以不坐 0 号位(先手会跟着主公走)。
   *
   * 注意:身份是隐藏信息。这个选项只影响开局分配,**不会**让任何一方多知道什么;
   * 提示词里仍然只有 self.role,和随机开局完全一样。
   */
  fixedRoles?: Record<number, Role>;
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

/** 身份的中英文写法都认,方便命令行和界面直接传 */
const ROLE_ALIAS: Record<string, Role> = {
  lord: 'lord', 主: 'lord', 主公: 'lord',
  loyalist: 'loyalist', 忠: 'loyalist', 忠臣: 'loyalist',
  rebel: 'rebel', 反: 'rebel', 反贼: 'rebel',
  renegade: 'renegade', 内: 'renegade', 内奸: 'renegade',
};

/** 解析身份串,如 "主公,内奸,,反贼" —— 空位表示随机。写法见 ROLE_ALIAS */
export function parseRoleSpec(
  spec: string | string[] | undefined, n: number,
): Record<number, Role> | undefined {
  if (!spec) return undefined;
  const items = (Array.isArray(spec) ? spec : spec.split(',')).map(x => x.trim());
  const out: Record<number, Role> = {};
  const bad: string[] = [];
  for (let i = 0; i < Math.min(items.length, n); i++) {
    if (!items[i]) continue;
    const r = ROLE_ALIAS[items[i].toLowerCase()];
    if (!r) { bad.push(items[i]); continue; }
    out[i] = r;
  }
  if (bad.length) {
    throw new Error(`不认识的身份:${bad.join('、')}
可用:主公/忠臣/反贼/内奸,或 lord/loyalist/rebel/renegade`);
  }
  if (!Object.keys(out).length) return undefined;
  // 名额对不对在这里就查 —— 留到 createGame 里才炸的话,横幅都打出去了,
  // 而且那是个未捕获的堆栈,看着像 bug 而不是"你参数写错了"
  checkRoles(out, n);
  return out;
}

/** 校验一份身份指定在 n 人局里是否成立。不合法就抛出带本局配置的错误 */
export function checkRoles(fixed: Record<number, Role>, n: number): void {
  const table = ROLE_TABLE[n];
  if (!table) throw new Error(`不支持 ${n} 人局`);
  const pool = [...table];
  for (const [k, role] of Object.entries(fixed)) {
    const seat = Number(k);
    if (!Number.isInteger(seat) || seat < 0 || seat >= n) {
      throw new Error(`没有 ${k} 号位(${n} 人局的座位是 0~${n - 1})`);
    }
    const at = pool.indexOf(role);
    if (at < 0) {
      throw new Error(
        `${ROLE_NAME[role]} 指定多了 —— 本局只有 ${table.filter(r => r === role).length} 个。\n` +
        `${n} 人局的身份配置:${table.map(r => ROLE_NAME[r]).join(' ')}`);
    }
    pool.splice(at, 1);
  }
}

/**
 * 定下每个座位的身份。没有指定时保持原有行为(0 号位主公,其余打乱)。
 *
 * 指定过的座位占掉对应名额,剩下的名额洗牌后填进空座位 —— 所以**剩余部分仍然
 * 由 seed 决定**,同一个 seed + 同一份指定,开出来的局是一样的。
 */
export function resolveRoles(n: number, rng: RNG, fixed?: Record<number, Role>): Role[] {
  const table = ROLE_TABLE[n];
  if (!table) throw new Error(`不支持 ${n} 人局`);
  if (!fixed || !Object.keys(fixed).length) {
    return ['lord', ...rng.shuffle(table.slice(1))];
  }

  // 命令行那条路已经在 parseRoleSpec 里查过了;这里再查一遍是为了挡住
  // 直接构造对象传进来的调用方(界面、脚本、测试)
  checkRoles(fixed, n);

  const pool = [...table];
  const out: Array<Role | undefined> = new Array(n).fill(undefined);
  for (const [k, role] of Object.entries(fixed)) {
    pool.splice(pool.indexOf(role), 1);
    out[Number(k)] = role;
  }

  const rest = rng.shuffle(pool);
  for (let i = 0; i < n; i++) out[i] ??= rest.shift();
  return out as Role[];
}

export function createGame(opts: SetupOptions): Game {
  const n = opts.playerCount ?? 8;
  if (!ROLE_TABLE[n]) throw new Error(`不支持 ${n} 人局`);

  const game = new Game(opts);
  const rng = game.rng;

  const finalRoles = resolveRoles(n, rng, opts.fixedRoles);

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
  // 主公先手。允许把主公放在别的座位(fixedRoles),所以这里不能写死 players[0]
  game.current = game.players.find(p => p.role === 'lord') ?? game.players[0];

  // 起始手牌(1v1 的后手补牌就在这里生效)
  const defaultHand = n === 2 ? [4, 4 + DUEL_HANDICAP] : undefined;
  const hands = resolveStartingHands(n, opts.startingHand ?? defaultHand);
  for (let i = 0; i < n; i++) {
    game.players[i].hand.push(...game.drawFromDeck(hands[i]));
  }

  return game;
}
