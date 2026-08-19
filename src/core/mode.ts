/**
 * 对局模式 —— 把"身份怎么分、谁先手、怎么算赢"这些规则从引擎里抽出来。
 *
 * 引擎本身不认识"主公""反贼",它只问模式:这个座位是什么阵营?谁先手?这局结束了吗?
 * 所以加一个新模式 = 加一个实现,不是往 game.ts 里再插一堆 `if`。
 *
 * 现在有两个:
 *   identity  身份局(2~8 人)—— 主忠反内,身份是隐藏信息,推理身份是玩法的一部分
 *   team2v2   2v2 对抗      —— 两队各 2 人,阵营公开,没有主公,考的是配合
 */

import type { Game } from './game.js';
import type { Player } from './player.js';
import type { RNG } from './game.js';
import { ROLE_NAME, type Role } from './types.js';

export interface ModeResult {
  winners: Player[];
  reason: string;
}

export interface GameMode {
  readonly name: string;
  readonly label: string;
  /** 支持几人 */
  readonly sizes: number[];
  /**
   * 阵营是不是隐藏信息。
   * false 时身份推理没有意义(`BeliefTable` 会自动停用),提示词也会直接写明谁是谁。
   */
  readonly hidden: boolean;

  /** n 人局用到的阵营清单(有重复,如 5 人局有两个 rebel)。校验和界面都用它 */
  table(n: number): Role[];
  /** 每个座位的阵营。fixed 是手动指定的部分 */
  assign(n: number, rng: RNG, fixed?: Record<number, Role>): Role[];
  /** 校验一份手动指定在这个模式的 n 人局里成不成立,不合法就抛 */
  check(fixed: Record<number, Role>, n: number): void;
  /** 起始体力上限加成 */
  bonusHp(role: Role, n: number): number;
  /** 开局是否明示阵营 */
  revealed(role: Role): boolean;
  /** 谁先手 —— 同时也是"一轮"的锚点(转回他就是新的一轮) */
  first(players: Player[]): Player;
  /** 胜负判定。返回 null 表示还没结束 */
  checkOver(game: Game): ModeResult | null;
  /** 击杀奖惩 */
  onKill(game: Game, victim: Player, killer: Player | null): Promise<void>;
  /** 两个座位是不是一伙的 */
  ally(a: Player, b: Player): boolean;
}

// ————————————————— 身份局 —————————————————

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

/** 从一张阵营表里分配座位:指定过的占掉名额,剩下的洗牌填空位 */
function assignFrom(table: Role[], n: number, rng: RNG, fixed?: Record<number, Role>): Role[] {
  if (!fixed || !Object.keys(fixed).length) {
    // 不指定时保持原有行为:第一个位置固定,其余打乱。
    // **这条不能改** —— 以前所有用 seed 记下来的胜率数据都靠它才对得上。
    return [table[0], ...rng.shuffle(table.slice(1))];
  }
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

function checkAgainst(table: Role[], fixed: Record<number, Role>, n: number, what: string): void {
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
        `${n} 人局的${what}配置:${table.map(r => ROLE_NAME[r]).join(' ')}`);
    }
    pool.splice(at, 1);
  }
}

export const identityMode: GameMode = {
  name: 'identity',
  label: '身份局',
  sizes: [2, 3, 4, 5, 6, 7, 8],
  hidden: true,

  table(n) {
    const table = ROLE_TABLE[n];
    if (!table) throw new Error(`身份局不支持 ${n} 人`);
    return table;
  },
  assign(n, rng, fixed) { return assignFrom(this.table(n), n, rng, fixed); },
  check(fixed, n) { checkAgainst(this.table(n), fixed, n, '身份'); },
  // 主公 +1 体力上限。1v1 不加 —— 两个人的时候这一点血就是压倒性的
  bonusHp: (role, n) => (role === 'lord' && n > 2 ? 1 : 0),
  revealed: role => role === 'lord',
  first: players => players.find(p => p.role === 'lord') ?? players[0],

  checkOver(game) {
    const alive = game.alivePlayers;
    const lord = game.players.find(p => p.role === 'lord')!;
    if (!lord.alive) {
      if (alive.length === 1 && alive[0].role === 'renegade') {
        return { winners: [alive[0]], reason: '内奸获胜' };
      }
      return { winners: game.players.filter(p => p.role === 'rebel'), reason: '反贼获胜' };
    }
    if (!alive.some(p => p.role === 'rebel' || p.role === 'renegade')) {
      return {
        winners: game.players.filter(p => p.role === 'lord' || p.role === 'loyalist'),
        reason: '主忠获胜',
      };
    }
    return null;
  },

  async onKill(game, victim, killer) {
    if (!killer) return;
    if (victim.role === 'rebel') {
      game.log(`  ${killer.name} 击杀反贼,摸三张牌`);
      await game.drawCards(killer, 3, '击杀奖励');
    } else if (victim.role === 'loyalist' && killer.role === 'lord') {
      game.log(`  主公误杀忠臣,弃置所有牌`);
      await game.discardCards([...killer.hand, ...killer.equipCards], '误杀惩罚');
    }
  },

  ally(a, b) {
    const side = (p: Player) => (p.role === 'lord' || p.role === 'loyalist' ? 'zhu' : p.role);
    // 内奸谁都不是队友 —— 他要的是独存
    if (a.role === 'renegade' || b.role === 'renegade') return a === b;
    return side(a) === side(b);
  },
};

// ————————————————— 2v2 —————————————————

/**
 * 座次 **[蓝, 红, 红, 蓝]**。
 *
 * 这样排之后,引擎原本按座位号推进的回合顺序天然就是「蓝→红→红→蓝」——
 * 先手方只走第一个位子,中间两个连着给后手方,第四个再还回来,正好抵消先手优势。
 * 距离关系也合理:每个人的两个邻座一个是队友、一个是对手。
 *
 * 副作用是跨轮次时座位 3 和座位 0 都是蓝队,蓝队会连着走两个回合 ——
 * 这是"甲乙乙甲"座次的固有结果,官方 2v2 也是如此。
 */
const TEAM_TABLE: Role[] = ['blue', 'red', 'red', 'blue'];

/**
 * 2v2 的座位分配。
 *
 * 注意这里**不洗牌** —— 身份局里座位是随机的,而 2v2 的座次本身就是规则的一部分:
 * 打散成"甲甲乙乙"引擎不会报任何错,只是先手方凭空多出连续两个回合。
 * 于是只剩两种合法排布(蓝红红蓝 / 红蓝蓝红),手动指定只是在这两者之间二选一。
 */
function teamLayout(table: Role[], fixed?: Record<number, Role>): Role[] {
  const flipped = table.map(r => (r === 'blue' ? 'red' : 'blue') as Role);
  const entries = Object.entries(fixed ?? {});
  for (const cand of [table, flipped]) {
    if (entries.every(([k, r]) => cand[Number(k)] === r)) return [...cand];
  }
  throw new Error(
    `这份指定排不出 2v2 的座次。座次必须是「甲乙乙甲」(0、3 号位一队,1、2 号位一队)——
` +
    `这样每个人的两个邻座才是一边一个,出牌顺序也才是 队1→队2→队2→队1。`);
}

export const team2v2Mode: GameMode = {
  name: 'team2v2',
  label: '2v2 对抗',
  sizes: [4],
  // 队伍是公开的 —— 这个模式考的是配合,不是推身份
  hidden: false,

  table(n) {
    if (n !== 4) throw new Error('2v2 只支持 4 人');
    return TEAM_TABLE;
  },
  assign(n, _rng, fixed) { return teamLayout(this.table(n), fixed); },
  check(fixed, n) {
    checkAgainst(this.table(n), fixed, n, '队伍');
    teamLayout(this.table(n), fixed);
  },
  // 没有主公,谁都不加血
  bonusHp: () => 0,
  revealed: () => true,
  first: players => players[0],

  checkOver(game) {
    for (const side of ['blue', 'red'] as const) {
      const team = game.players.filter(p => p.role === side);
      if (team.length && team.every(p => !p.alive)) {
        const other = side === 'blue' ? 'red' : 'blue';
        return {
          winners: game.players.filter(p => p.role === other),
          reason: `${ROLE_NAME[other]}获胜`,
        };
      }
    }
    return null;
  },

  // 没有击杀奖励 —— 有的话会诱导 AI 抢人头,而这个模式要看的是配合
  async onKill() { /* 无 */ },

  ally: (a, b) => a.role === b.role,
};

export const MODES: Record<string, GameMode> = {
  [identityMode.name]: identityMode,
  [team2v2Mode.name]: team2v2Mode,
};

export function getMode(name?: string): GameMode {
  return (name && MODES[name]) || identityMode;
}
