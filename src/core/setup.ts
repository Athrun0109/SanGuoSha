import { Game, GameOptions, RNG } from './game.js';
import { Player } from './player.js';
import { ROLE_NAME, type Role } from './types.js';
import { generals } from './registry.js';
import { getMode, identityMode, ROLE_TABLE, type GameMode } from './mode.js';
import { buildDeck } from '../content/cards.js';
import { LORD_GENERALS, STANDARD_GENERALS } from '../content/generals.js';
import type { Agent } from './agent.js';

/** 各人数下的身份配置 —— 定义搬到了 core/mode.ts,这里转出保持老引用可用 */
export { ROLE_TABLE };

export interface SetupOptions extends Omit<GameOptions, 'mode'> {
  playerCount?: number;
  /**
   * 对局模式。传 GameMode 对象或名字('identity' / 'team2v2'),默认身份局。
   * 决定身份怎么分、有没有主公加血、谁先手、怎么算赢 —— 见 core/mode.ts
   */
  mode?: GameMode | string;
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
   * 注意数组是按 `[先手, 后手]` 理解的,不是按座位号 —— 谁先手由主公决定
   * (`game.current`),而主公不一定坐 0 号位。见下面 createGame 里那段交换。
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
  // 2v2 的两支队伍
  blue: 'blue', 蓝: 'blue', 蓝队: 'blue', 队1: 'blue', '1队': 'blue',
  red: 'red', 红: 'red', 红队: 'red', 队2: 'red', '2队': 'red',
};

/**
 * 解析身份/队伍串,如 "主公,内奸,,反贼" —— 空位表示随机。写法见 ROLE_ALIAS。
 * mode 决定这些名字在本局合不合法(2v2 里没有"主公")。
 */
export function parseRoleSpec(
  spec: string | string[] | undefined, n: number, mode: GameMode = identityMode,
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
可用:主公/忠臣/反贼/内奸,或 lord/loyalist/rebel/renegade;2v2 用 蓝队/红队`);
  }
  if (!Object.keys(out).length) return undefined;
  // 名额对不对在这里就查 —— 留到 createGame 里才炸的话,横幅都打出去了,
  // 而且那是个未捕获的堆栈,看着像 bug 而不是"你参数写错了"
  mode.check(out, n);
  return out;
}

/** 校验一份身份指定在 n 人局里是否成立。不合法就抛出带本局配置的错误 */
export function checkRoles(
  fixed: Record<number, Role>, n: number, mode: GameMode = identityMode,
): void {
  mode.check(fixed, n);
}

/**
 * 定下每个座位的阵营。没有指定时保持原有行为(身份局 0 号位主公,其余打乱)。
 *
 * 指定过的座位占掉对应名额,剩下的名额洗牌后填进空座位 —— 所以**剩余部分仍然
 * 由 seed 决定**,同一个 seed + 同一份指定,开出来的局是一样的。
 */
export function resolveRoles(
  n: number, rng: RNG, fixed?: Record<number, Role>, mode: GameMode = identityMode,
): Role[] {
  // 命令行那条路已经在 parseRoleSpec 里查过了;这里再查一遍是为了挡住
  // 直接构造对象传进来的调用方(界面、脚本、测试)
  if (fixed && Object.keys(fixed).length) mode.check(fixed, n);
  return mode.assign(n, rng, fixed);
}

export function createGame(opts: SetupOptions): Game {
  const n = opts.playerCount ?? 8;
  const mode = typeof opts.mode === 'string' ? getMode(opts.mode) : opts.mode ?? identityMode;
  if (!mode.sizes.includes(n)) {
    throw new Error(`${mode.label}不支持 ${n} 人(可选 ${mode.sizes.join('/')} 人)`);
  }

  const game = new Game({ ...opts, mode });
  const rng = game.rng;

  const finalRoles = resolveRoles(n, rng, opts.fixedRoles, mode);

  // 武将
  const pool = rng.shuffle([...STANDARD_GENERALS]);
  const usedNames = new Set<string>();

  for (let i = 0; i < n; i++) {
    const p = new Player(i, `${i}号位`);
    p.role = finalRoles[i];

    let gname = opts.fixedGenerals?.[i]?.trim();
    if (!gname) {
      if (p.role === 'lord') {
        // 主公从主公武将池里挑(2v2 没有主公,走不到这一支)
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
    p.maxHp = def.hp + ((opts.lordBonusHp ?? true) ? mode.bonusHp(p.role, n) : 0);
    p.hp = p.maxHp;
    p.name = `${i}号位·${def.name}`;
    if (mode.revealed(p.role)) p.revealed = true;

    game.players.push(p);
    game.agents.set(p, opts.makeAgent(p, i));
  }

  // 牌堆
  game.deck = rng.shuffle(buildDeck());
  // 先手由模式决定:身份局跟着主公走(主公可以不坐 0 号位),2v2 就是 0 号位
  game.current = mode.first(game.players);

  // 起始手牌(1v1 的后手补牌就在这里生效)
  const defaultHand = n === 2 ? [4, 4 + DUEL_HANDICAP] : undefined;
  const hands = resolveStartingHands(n, opts.startingHand ?? defaultHand);

  /*
   * **后手补牌要跟着行动顺序走,不是跟着座位号。**
   *
   * 补牌数是按 [先手, 后手] 写的,以前"0 号位 = 主公 = 先手"永远成立,所以直接
   * 按座位发就对。放开 fixedRoles 之后主公可以坐 1 号位 —— 而先手是跟着主公的,
   * 于是出现过一次:主公坐 1 号位,既先手、又拿了本该补给后手的牌,优势叠了两层。
   */
  if (n === 2 && hands[0] !== hands[1]) {
    const firstSeat = game.current.seat;
    const richer = hands[0] > hands[1] ? 0 : 1;
    if (richer === firstSeat) [hands[0], hands[1]] = [hands[1], hands[0]];
  }
  for (let i = 0; i < n; i++) {
    game.players[i].hand.push(...game.drawFromDeck(hands[i]));
  }

  return game;
}
