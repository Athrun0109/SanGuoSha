/**
 * 「模型到底有没有用上多给它的信息?」
 *
 * ## 为什么需要单独量这个
 *
 * 明牌实验如果得出"胜率和集火都没动",有两种截然不同的解释:
 *
 *   A. **信息不是瓶颈** —— 它看了,但看了也没用,配合差在别处
 *   B. **模型压根没看** —— 信息摆在提示词里,它的推理里一次都没提
 *
 * 这两个结论指向完全相反的下一步:A 说明留言功能大概率也白搭,该去别处找问题;
 * B 说明问题出在**呈现方式**,该改的是提示词的写法,而不是放弃这条路。
 * 只看结果指标区分不了它们,所以这里直接翻模型自己的推理文本。
 *
 * ## 判定口径
 *
 * 一条推理算"用上了",要求它提到某张**当时在队友手上、而不在自己手上**的牌。
 * 两道收窄:
 *
 *  - **只认有辨识度的牌名。**杀/闪/桃满天飞,"我出杀"里的"杀"会匹配上队友手里的杀,
 *    那是纯噪声。所以只数装备和锦囊。
 *  - **同时给"逐字引用"的严格口径。**带花色点数的完整标签(`闪[♦7]`)几乎不可能
 *    是碰巧写出来的,虚报率最低;代价是模型常常只写牌名,会漏报。两个数一起看。
 *
 * 两个已知的偏差,读数时要记得:
 *
 *  - **快照是按回合存的,不是按决策存的。**一个回合内手牌会变,所以"队友当时有什么"
 *    是个近似。它对两组一视同仁,做对比没问题,但绝对值别当真。
 *  - **公开信息会混进来。**队友*打出*的南蛮、装备区里的连弩,不开明牌也看得见。
 *    所以关键从来不是治疗组的绝对值,而是**治疗组减去对照组** ——
 *    对照组那一列量的正好就是这些噪声。
 */

import * as fs from 'node:fs';

/** 有辨识度的牌名:基本牌(杀/闪/桃/酒)出现得太频繁,匹配上说明不了任何事 */
const DISTINCT = [
  '雌雄双股剑', '青龙偃月刀', '贯石斧', '丈八蛇矛', '方天画戟', '诸葛连弩',
  '寒冰剑', '青釭剑', '八卦阵', '藤甲', '白银狮子', '仁王盾', '进攻马', '防御马',
  '无懈可击', '无中生有', '过河拆桥', '顺手牵羊', '南蛮入侵', '万箭齐发',
  '桃园结义', '五谷丰登', '乐不思蜀', '闪电', '决斗', '借刀杀人',
];

export interface InfoUse {
  /** 席位的控制方式,比如 llm / llm+open */
  control: string;
  /** 模型自己产生的推理条数(照计划执行的不算 —— 那次没有推理) */
  thoughts: number;
  /** 其中提到了队友手上某张有辨识度的牌 */
  byName: number;
  /** 其中逐字引用了完整标签(`闪[♦7]`)—— 更严,虚报率最低 */
  verbatim: number;
  /** 抽几条原文出来给人看,数字对不上时能直接翻 */
  samples: string[];
}

const blank = (control: string): InfoUse =>
  ({ control, thoughts: 0, byName: 0, verbatim: 0, samples: [] });

/** 读一批对局记录,按控制方式统计"用没用上队友的暗牌" */
export function infoUse(files: string[], keepSamples = 4): Map<string, InfoUse> {
  const out = new Map<string, InfoUse>();
  const bucket = (c: string) => {
    if (!out.has(c)) out.set(c, blank(c));
    return out.get(c)!;
  };

  for (const file of files) {
    let rows: Array<Record<string, any>>;
    try {
      rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { continue; }

    const meta = rows.find(r => r.type === 'meta');
    const setup = rows.find(r => r.type === 'setup');
    if (!meta?.seats || !setup?.players) continue;
    const control = new Map<number, string>(
      (meta.seats as any[]).map((s, i) => [i, s.control ?? '?']));
    const role = new Map<number, string>(
      (setup.players as any[]).map(p => [p.seat, p.role]));

    let snap: Record<string, any> | null = null;
    for (const r of rows) {
      if (r.type === 'state' && r.players) { snap = r; continue; }
      if (r.type !== 'llm' || typeof r.thinking !== 'string' || !snap) continue;
      // 照计划执行的那些没有新推理,thinking 是引擎填的占位
      if (!r.thinking || r.thinking.startsWith('(按计划')) continue;

      const s = Number(String(r.agentId).match(/(\d+)$/)?.[1]);
      if (!Number.isInteger(s)) continue;
      const b = bucket(control.get(s) ?? '?');
      b.thoughts++;

      const th: string = r.thinking;
      const mineLabels: string[] = snap.players[s]?.hand ?? [];
      const mineNames = new Set(mineLabels.map((x: string) => x.split('[')[0]));

      let named = false, quoted = false;
      for (const q of snap.players as any[]) {
        if (q.seat === s || !q.alive || role.get(q.seat) !== role.get(s)) continue;
        for (const label of (q.hand ?? []) as string[]) {
          const name = label.split('[')[0];
          if (mineNames.has(name)) continue;      // 自己也有的牌,提到了也说明不了什么
          if (label && th.includes(label)) quoted = true;
          if (DISTINCT.includes(name) && th.includes(name)) named = true;
        }
      }
      if (named) b.byName++;
      if (quoted) b.verbatim++;
      if ((named || quoted) && b.samples.length < keepSamples) b.samples.push(th.slice(0, 200));
    }
  }
  return out;
}
