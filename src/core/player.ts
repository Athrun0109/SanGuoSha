import type { Card, EquipSlot, Gender, Kingdom, Role } from './types.js';
import type { Skill } from './skill.js';
import type { GeneralDef } from './skill.js';

export class Player {
  readonly seat: number;
  name: string;
  role: Role = 'rebel';
  general!: GeneralDef;
  kingdom: Kingdom = 'qun';
  gender: Gender = 'male';

  hp = 4;
  maxHp = 4;
  alive = true;
  /** 已确认死亡并处理完毕 */
  dead = false;

  hand: Card[] = [];
  equips: Partial<Record<EquipSlot, Card>> = {};
  /** 判定区;新的延时锦囊放在数组尾部,判定时从尾部开始 */
  judgeZone: Card[] = [];
  /** 判定区里牌的"实际牌名"(大乔国色把方块牌当乐不思蜀时用) */
  judgeAs: Record<number, string> = {};

  /** 来自武将的技能 */
  skills: Skill[] = [];
  /** 来自装备的技能(装备时挂上,卸下时移除) */
  equipSkills = new Map<EquipSlot, Skill[]>();

  /** 计数器:'turn:' 前缀在回合结束清空,'phase:' 在阶段结束清空,'round:' 在一轮结束清空 */
  marks: Record<string, number> = {};
  /** 身份是否已明示(主公一开始就明示) */
  revealed = false;

  constructor(seat: number, name: string) {
    this.seat = seat;
    this.name = name;
  }

  get allSkills(): Skill[] {
    const out = [...this.skills];
    for (const list of this.equipSkills.values()) out.push(...list);
    return out;
  }

  hasSkill(name: string): boolean {
    return this.allSkills.some(s => s.name === name);
  }

  get handCount() { return this.hand.length; }

  get isWounded() { return this.hp < this.maxHp; }

  get equipCards(): Card[] {
    return Object.values(this.equips).filter(Boolean) as Card[];
  }

  /** 手牌 + 装备 + 判定区,即"区域里的所有牌" */
  get allCards(): Card[] {
    return [...this.hand, ...this.equipCards, ...this.judgeZone];
  }

  hasCard(id: number): boolean {
    return this.allCards.some(c => c.id === id);
  }

  mark(key: string): number { return this.marks[key] ?? 0; }
  addMark(key: string, n = 1) { this.marks[key] = this.mark(key) + n; }
  setMark(key: string, n: number) { this.marks[key] = n; }
  clearMarks(prefix: string) {
    for (const k of Object.keys(this.marks)) if (k.startsWith(prefix)) delete this.marks[k];
  }

  toString() { return this.name; }
}
