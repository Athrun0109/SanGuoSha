/**
 * 身份判断表 —— LLM 对"谁是什么身份"的持久记忆。
 *
 * 为什么要单独做一份结构化状态,而不是靠回带最近几条 thinking:
 *
 *  1. **能累积。** 自由文本里模型这次提身份、下次不提,判断就断了。有了表,
 *     它每次都看得见自己上一轮的结论,也能明确地推翻自己。
 *  2. **能度量。** 表能和真相逐格比对,直接算出身份推理准确率。这是换模型、
 *     改提示词时唯一能拿来横向比较的硬指标 —— 「感觉打得挺聪明」不是指标。
 *  3. **是协作的前提。** 主忠方现在打不过反贼,根子就是没有共同的"谁是自己人"。
 *
 * 两条边界:
 *  - 表里只有模型自己推出来的东西,加上**规则已经公开**的身份(主公明示、阵亡翻开)。
 *    后者标记为 locked,不再让模型浪费推理,也不会被它的猜测覆盖。
 *  - 1v1 没有可推的身份(两人身份从配置就能推出),整个机制关掉。
 */

import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import type { Role } from '../core/types.js';
import { ROLE_NAME } from '../core/types.js';
import type { Codec } from './codec.js';

export const ROLE_IDS = ['lord', 'loyalist', 'rebel', 'renegade'] as const;
export type RoleGuess = Role | 'unknown';

export interface Belief {
  role: RoleGuess;
  /** 0~1 */
  conf: number;
  why: string;
  /** 最后更新的轮次 */
  round: number;
  /** 规则已确认,不是猜的 */
  locked: boolean;
}

/** 模型返回的一条判断 */
export interface Read {
  seat: number;
  role: string;
  conf?: number;
  why?: string;
}

export interface BeliefRow extends Belief {
  seat: number;
  /** 真实身份 —— 只用于日志和评分,**绝不进提示词** */
  truth?: Role;
  correct?: boolean;
}

export class BeliefTable {
  /** 1v1 没什么可推的,直接关掉 */
  readonly enabled: boolean;
  private m = new Map<number, Belief>();
  private askedRound = 0;

  constructor(playerCount: number) {
    this.enabled = playerCount > 2;
  }

  /** 把规则已经公开的身份写进表并锁定;其余座位保持模型自己的判断 */
  sync(game: Game, self: Player) {
    if (!this.enabled) return;
    for (const p of game.players) {
      const known = p === self || p.revealed;
      const cur = this.m.get(p.seat);
      if (known) {
        this.m.set(p.seat, {
          role: p.role, conf: 1, round: game.round, locked: true,
          why: p === self ? '你自己' : '已明示',
        });
      } else if (!cur) {
        this.m.set(p.seat, { role: 'unknown', conf: 0, why: '', round: 0, locked: false });
      }
    }
  }

  /**
   * 本轮是否该让模型复核身份。
   * 调用即视为已问 —— 一轮只问一次,模型不答就等下一轮,别在同一轮里反复催。
   */
  claimRefresh(round: number): boolean {
    if (!this.enabled || round <= this.askedRound) return false;
    this.askedRound = round;
    return true;
  }

  /** 合并模型返回的判断。返回实际生效的条数 */
  apply(reads: Read[] | undefined, round: number): Read[] {
    if (!this.enabled || !Array.isArray(reads)) return [];
    const applied: Read[] = [];
    for (const r of reads) {
      const seat = Number(r?.seat);
      const cur = this.m.get(seat);
      // 锁定的格子不接受覆盖 —— 模型说主公是反贼也没用,那是规则给的事实
      if (!cur || cur.locked) continue;
      const role = String(r.role) as RoleGuess;
      if (role !== 'unknown' && !ROLE_IDS.includes(role as Role)) continue;
      this.m.set(seat, {
        role,
        conf: clamp(Number(r.conf)),
        why: String(r.why ?? '').slice(0, 80),
        round,
        locked: false,
      });
      applied.push({ seat, role, conf: clamp(Number(r.conf)), why: r.why });
    }
    return applied;
  }

  /**
   * 渲染进提示词。
   * **只渲染还没确认的座位** —— 已明示的身份在局面表里已经有了,重复给只是烧 token。
   */
  render(game: Game, self: Player, c: Codec): string {
    if (!this.enabled) return '';
    const rows: string[] = [];
    for (const p of game.players) {
      if (p === self || p.revealed || !p.alive) continue;
      const b = this.m.get(p.seat);
      rows.push(b && b.role !== 'unknown'
        ? `${c.player(p)} ${b.role} ${b.conf.toFixed(1)} R${b.round} ${b.why}`.trimEnd()
        : `${c.player(p)} ? 还没判断`);
    }
    if (!rows.length) return '';
    return `你的身份判断(自己维护的记忆,只有你看得到)\n${rows.join('\n')}`;
  }

  /** 让模型复核的那句提示 */
  static refreshHint(): string {
    return '本轮请顺便复核身份判断:把有变化的写进 reads(座位号=P后面的数字);' +
      '没有变化就给 reads: []。';
  }

  entries(game?: Game): BeliefRow[] {
    const out: BeliefRow[] = [];
    for (const [seat, b] of [...this.m.entries()].sort((a, b2) => a[0] - b2[0])) {
      const truth = game?.players[seat]?.role;
      out.push({
        seat, ...b, truth,
        correct: truth && !b.locked && b.role !== 'unknown' ? b.role === truth : undefined,
      });
    }
    return out;
  }

  /**
   * 身份推理准确率。只统计"模型自己猜的且给了明确答案"的格子 ——
   * 规则送的(locked)不算成绩,没作答的(unknown)不算分母。
   */
  accuracy(game: Game): { right: number; total: number } {
    let right = 0, total = 0;
    for (const row of this.entries(game)) {
      if (row.correct === undefined) continue;
      total++;
      if (row.correct) right++;
    }
    return { right, total };
  }

  /** 人读的一行摘要,给 CLI 用 */
  summary(game: Game): string {
    const parts = this.entries(game)
      .filter(r => !r.locked && r.role !== 'unknown')
      .map(r => `P${r.seat}=${ROLE_NAME[r.role as Role] ?? r.role}${r.correct ? '✓' : '✗'}`);
    return parts.join(' ');
  }
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** 决策 schema 里 reads 那一段。strict 模式要求所有字段都在 required 里 */
export const READS_SCHEMA = {
  type: 'array',
  description: '身份判断更新。没有要改的就给空数组 []',
  items: {
    type: 'object',
    properties: {
      seat: { type: 'integer', description: '座位号,即 P 后面的数字' },
      role: { type: 'string', enum: [...ROLE_IDS, 'unknown'] },
      conf: { type: 'number', description: '把握程度 0~1' },
      why: { type: 'string', description: '一句话依据' },
    },
    required: ['seat', 'role', 'conf', 'why'],
    additionalProperties: false,
  },
} as const;
