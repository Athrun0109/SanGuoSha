/**
 * 玩家世界 ↔ LLM 世界 的转译层。
 *
 * 两种模式:
 *  - verbose:保留"赵云""乐不思蜀"这些专有名词。模型能吃到预训练里关于三国杀的先验。
 *  - anon:全部换成代号(P0、S、w4、K3)。模型只能读你给的技能文本,读不到它记忆里的原版规则。
 *
 * 什么时候该用 anon:**当你 DIY 改过技能之后**。
 * 一旦遗计变成每回合限一次,"郭嘉"这个名字带来的先验就从资产变成负债 ——
 * 模型会按记忆里的原版推理,而且错得很自信。anon 模式强制它只看你写的文本。
 *
 * 转译不只作用在数据结构上,也作用在引擎产生的自由文本(提示语、战报)上,
 * 否则 "0号位·刘备 对你使用【杀】" 这种句子会把原名泄回去。
 */

import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { Card, cardLabel, rankName } from '../core/types.js';
import { cardSpecs } from '../core/registry.js';

export type CodecMode = 'verbose' | 'anon';

/** 牌名 → 代号。分组的坐骑共用一个代号,反正它们功能完全一样 */
export const CARD_CODE: Record<string, string> = {
  杀: 'S', 闪: 'D', 桃: 'P',
  过河拆桥: 'X', 顺手牵羊: 'G', 决斗: 'U', 无中生有: 'A',
  南蛮入侵: 'B', 万箭齐发: 'R', 桃园结义: 'T', 五谷丰登: 'W',
  借刀杀人: 'J', 无懈可击: 'N', 乐不思蜀: 'L', 闪电: 'E',
  诸葛连弩: 'w1', 雌雄双股剑: 'w2', 青釭剑: 'w3', 青龙偃月刀: 'w4',
  丈八蛇矛: 'w5', 贯石斧: 'w6', 方天画戟: 'w7', 麒麟弓: 'w8',
  八卦阵: 'a1', 仁王盾: 'a2',
  绝影: 'h+', 大宛: 'h+', 紫骍: 'h+',
  赤兔: 'h-', 的卢: 'h-', 爪黄飞电: 'h-',
};

export class Codec {
  readonly mode: CodecMode;
  /** 技能名 → 代号,anon 模式下用 */
  private skillCode = new Map<string, string>();
  /** 用于翻译自由文本的替换表,按长度降序 */
  private replacements: Array<[string, string]> = [];

  constructor(game: Game, mode: CodecMode) {
    this.mode = mode;
    const map = new Map<string, string>();

    // 即使是 verbose 模式也把 "0号位·曹操" 压成 "P0" ——
    // 战报里每行都要提好几次角色,这是纯粹的重复开销,而局面表里已经写明 P0 是谁。
    for (const p of game.players) map.set(p.name, `P${p.seat}`);
    if (mode === 'verbose') {
      this.replacements = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
      return;
    }

    let k = 1;
    for (const p of game.players) {
      map.set(p.general.name, `P${p.seat}`);
      for (const s of p.general.skills) {
        if (!this.skillCode.has(s.name)) this.skillCode.set(s.name, `K${k++}`);
      }
    }
    // 装备附带的技能也要有代号(名字常和牌名重合,靠 CARD_CODE 兜住)
    for (const [name, code] of this.skillCode) map.set(name, code);
    for (const [name, code] of Object.entries(CARD_CODE)) map.set(name, code);
    this.replacements = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  }

  /** 翻译引擎产生的自由文本(提示语、日志) */
  text(s: string): string {
    let out = s;
    for (const [from, to] of this.replacements) out = out.split(from).join(to);
    return out;
  }

  /** 角色标签 */
  player(p: Player, observer?: Player): string {
    const tag = `P${p.seat}`;
    const base = this.mode === 'verbose' ? `${tag}(${p.general.name})` : tag;
    return p === observer ? `${base}*` : base;
  }

  cardName(name: string): string {
    return this.mode === 'verbose' ? name : (CARD_CODE[name] ?? name);
  }

  /** 一张具体的牌:代号 + 花色点数(花色点数不能省,判定和转化技要用) */
  card(c: Card): string {
    return this.mode === 'verbose'
      ? cardLabel(c)
      : `${this.cardName(c.name)}${c.suit}${rankName(c.rank)}`;
  }

  skill(name: string): string {
    return this.mode === 'verbose' ? name : (this.skillCode.get(name) ?? name);
  }

  /** 一名角色的技能清单 */
  skills(p: Player): string {
    const list = p.allSkills.filter(s => s.desc);
    if (!list.length) return '-';
    return list.map(s => `${this.skill(s.name)}:${this.text(s.desc!)}`).join(' ');
  }

  /** anon 模式下,牌代号表要作为规则的一部分给出(但不给原名) */
  get usesCodes(): boolean { return this.mode === 'anon'; }
}

/** 校验代号表覆盖了牌堆里所有的牌 —— 漏一张就会有原名泄漏到 anon 模式 */
export function missingCodes(): string[] {
  return [...cardSpecs.keys()].filter(n => !(n in CARD_CODE));
}
