/**
 * 武将清单 + 手动点将。
 *
 *   npm run generals          列出全部武将
 *   npm run generals 关羽      看某个武将的技能详情
 */

import '../content/cards.js';
import '../content/generals.js';
import { generals } from '../core/registry.js';
import { KINGDOM_NAME } from '../core/types.js';
import type { GeneralDef } from '../core/skill.js';

export function allGenerals(): GeneralDef[] {
  return [...generals.values()];
}

export function generalLine(g: GeneralDef, idx?: number): string {
  const head = idx === undefined ? '' : `${String(idx).padStart(2)}. `;
  const sk = g.skills.filter(s => s.desc).map(s => `【${s.name}】`).join('');
  return `${head}${g.name.padEnd(4, '　')} ${KINGDOM_NAME[g.kingdom]} ${g.gender === 'male' ? '男' : '女'} ${g.hp}血  ${sk}`;
}

export function generalTable(): string {
  return allGenerals().map((g, i) => generalLine(g, i)).join('\n');
}

export function generalDetail(name: string): string {
  const g = generals.get(name.trim());
  if (!g) return `没有这个武将:${name}\n可选:${allGenerals().map(x => x.name).join(' ')}`;
  const sk = g.skills.filter(s => s.desc)
    .map(s => `  【${s.name}】${s.desc}`).join('\n');
  return `${generalLine(g)}\n${sk || '  (无技能)'}`;
}

/**
 * 交互式点将。对每个座位问一次:
 *   直接回车 → 随机;输入编号或武将名 → 指定;输入 ? → 重新列出清单
 */
export async function pickGenerals(
  seats: Array<{ seat: number; label: string }>,
  ask: (q: string) => Promise<string>,
): Promise<Record<number, string>> {
  const list = allGenerals();
  console.log('\n可选武将:');
  console.log(generalTable());
  console.log('\n(直接回车 = 随机;输入编号或名字 = 指定;输入 ? = 重新列出;输入名字加 ?? 看详情)');

  const out: Record<number, string> = {};
  for (const { seat, label } of seats) {
    for (;;) {
      const a = (await ask(`为 ${label} 点将 > `)).trim();
      if (!a) break;                                   // 随机
      if (a === '?') { console.log(generalTable()); continue; }
      if (a.endsWith('??')) { console.log(generalDetail(a.slice(0, -2))); continue; }
      const byIdx = /^\d+$/.test(a) ? list[Number(a)] : undefined;
      const g = byIdx ?? generals.get(a);
      if (!g) { console.log(`  没有「${a}」,输入 ? 看清单`); continue; }
      out[seat] = g.name;
      console.log(`  ${label} → ${generalLine(g)}`);
      break;
    }
  }
  return out;
}

// 作为脚本直接运行
if (process.argv[1]?.endsWith('generals.ts')) {
  const arg = process.argv[2];
  console.log(arg ? generalDetail(arg) : generalTable());
}
