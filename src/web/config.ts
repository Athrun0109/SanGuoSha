/**
 * 一局的完整配置 —— 设置页、命令行、以后的批量跑,都用这一份。
 *
 * 为什么单独抽出来:同一套选项现在散在 `play.ts` / `duel.ts` / `ui.ts` 的 flag 解析里,
 * 加一个新选项就得在三处各改一遍,漏一处就是"设置了没生效"这种最难查的 bug。
 *
 * 设计上只有一条硬规矩:**这里出来的东西一律已经校验过**。
 * `normalizeConfig` 要么返回一份能直接开局的配置,要么抛出一句人能看懂的中文错误 ——
 * 调用方不需要再自己检查一遍。浏览器传上来的 JSON 是不可信输入,这就是那道闸门。
 */

import { checkRoles, ROLE_TABLE, DUEL_HANDICAP } from '../core/setup.js';
import { generals } from '../core/registry.js';
import type { Role } from '../core/types.js';

export type Control = 'human' | 'llm' | 'rule';
export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface SeatConfig {
  control: Control;
  /** null = 随机 */
  general: string | null;
  /** null = 随机 */
  role: Role | null;
  /** 以下几项只在 control==='llm' 时有意义。模型挂在**席位**上,
   *  所以同一局里 DeepSeek 和 Claude 可以对坐 —— 这是命令行做不到的 */
  model?: string;
  effort?: Effort;
  codec?: 'verbose' | 'anon';
}

export interface GameConfig {
  playerCount: number;
  seed: number;
  /** 1v1 的后手补牌。null = 用默认值 */
  handicap: number | null;
  /** 视角座位;null = 纯观战(所有人手牌都盖着) */
  viewer: number | null;
  /** 开图:所有人手牌可见。只该在调试时开 */
  reveal: boolean;
  /** 每次决策前停多少毫秒,让人眼跟得上 */
  speed: number;
  record: boolean;
  seats: SeatConfig[];
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);

function pickOne<T extends string>(v: unknown, allowed: readonly T[], def: T, what: string): T {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${what} 只能是 ${allowed.join(' / ')},收到的是 ${JSON.stringify(v)}`);
}

/**
 * 校验并补全一份配置。**唯一的入口** —— 浏览器传上来的东西必须先过这里。
 */
export function normalizeConfig(raw: unknown): GameConfig {
  if (!raw || typeof raw !== 'object') throw new Error('配置必须是一个对象');
  const c = raw as Record<string, unknown>;

  const n = c.playerCount;
  if (!isInt(n) || !ROLE_TABLE[n]) throw new Error(`人数只能是 2~8,收到的是 ${JSON.stringify(n)}`);

  const seatsRaw = c.seats;
  if (!Array.isArray(seatsRaw) || seatsRaw.length !== n) {
    throw new Error(`席位数量(${Array.isArray(seatsRaw) ? seatsRaw.length : '无'})和人数(${n})对不上`);
  }

  const seats: SeatConfig[] = [];
  const usedGenerals = new Set<string>();
  const fixedRoles: Record<number, Role> = {};

  for (let i = 0; i < n; i++) {
    const s = (seatsRaw[i] ?? {}) as Record<string, unknown>;
    const control = pickOne<Control>(s.control, ['human', 'llm', 'rule'], 'rule', `${i} 号位的控制者`);

    let general: string | null = null;
    if (typeof s.general === 'string' && s.general.trim()) {
      general = s.general.trim();
      if (!generals.has(general)) {
        throw new Error(`没有这个武将:${general}\n可选:${[...generals.keys()].join(' ')}`);
      }
      // 同一个武将不能上两次 —— 引擎的随机点将也保证了这条,手动指定时得自己守
      if (usedGenerals.has(general)) throw new Error(`【${general}】被指定了两次,同一局里武将不能重复`);
      usedGenerals.add(general);
    }

    let role: Role | null = null;
    if (typeof s.role === 'string' && s.role) {
      if (!['lord', 'loyalist', 'rebel', 'renegade'].includes(s.role)) {
        throw new Error(`${i} 号位的身份不认识:${s.role}`);
      }
      role = s.role as Role;
      fixedRoles[i] = role;
    }

    const seat: SeatConfig = { control, general, role };
    if (control === 'llm') {
      const model = typeof s.model === 'string' ? s.model.trim() : '';
      if (!model) throw new Error(`${i} 号位选了大模型,但没有指定模型 id`);
      seat.model = model;
      seat.effort = pickOne<Effort>(s.effort, EFFORTS, 'low', `${i} 号位的思考深度`);
      seat.codec = pickOne(s.codec, ['verbose', 'anon'] as const, 'verbose', `${i} 号位的代号化`);
    }
    seats.push(seat);
  }

  // 身份名额对不对,交给引擎那份唯一的判定,别在这里抄一遍规则
  checkRoles(fixedRoles, n);

  const viewerRaw = c.viewer;
  let viewer: number | null = null;
  if (viewerRaw !== null && viewerRaw !== undefined) {
    if (!isInt(viewerRaw) || viewerRaw < 0 || viewerRaw >= n) {
      throw new Error(`视角座位要在 0~${n - 1} 之间,或者留空表示纯观战`);
    }
    viewer = viewerRaw;
  }

  const seed = isInt(c.seed) && c.seed >= 0 ? c.seed : Math.floor(Math.random() * 1e9);
  const speed = isInt(c.speed) && c.speed >= 0 ? Math.min(c.speed, 10000) : 500;
  const handicap = isInt(c.handicap) && c.handicap >= 0 ? c.handicap : (n === 2 ? DUEL_HANDICAP : null);

  return {
    playerCount: n, seed, handicap, viewer,
    reveal: c.reveal === true,
    speed, record: c.record === true, seats,
  };
}

/** 拆出 createGame 要的那两张表 */
export function splitFixed(cfg: GameConfig): {
  fixedGenerals?: Record<number, string>;
  fixedRoles?: Record<number, Role>;
} {
  const g: Record<number, string> = {};
  const r: Record<number, Role> = {};
  cfg.seats.forEach((s, i) => {
    if (s.general) g[i] = s.general;
    if (s.role) r[i] = s.role;
  });
  return {
    fixedGenerals: Object.keys(g).length ? g : undefined,
    fixedRoles: Object.keys(r).length ? r : undefined,
  };
}

/** 起始手牌。只有 1v1 才有后手补牌这回事 */
export function startingHandOf(cfg: GameConfig): number[] | undefined {
  if (cfg.playerCount !== 2 || cfg.handicap === null) return undefined;
  return [4, 4 + cfg.handicap];
}

/** 默认配置:全规则 AI,谁都不指定 */
export function defaultConfig(playerCount = 3): GameConfig {
  return normalizeConfig({
    playerCount,
    seed: Math.floor(Math.random() * 1e9),
    viewer: null, reveal: false, speed: 500, record: false,
    seats: Array.from({ length: playerCount }, () => ({ control: 'rule' })),
  });
}
