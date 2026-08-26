/**
 * 行为指标的解析器。
 *
 * 这东西的输出会被拿来判断"提示词改动有没有效果",所以它自己算错了最要命 ——
 * 不会崩、不会报错,只会给出一个看起来很像那么回事的数字,然后据此做决定。
 * 所以每条指标都用一份手写的最小记录钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { metricsOfLog, merge, avg, ratio } from '../eval/metrics.js';

/** 手搓一份 jsonl —— 字段和 Recorder 写出来的一致 */
function writeLog(rows: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-metrics-test-'));
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, rows.map((r, i) => JSON.stringify({ i, ...r })).join('\n'));
  return file;
}

const snap = (turn: number, cur: number, hands: number[]) => ({
  type: 'state', turn, cur,
  players: hands.map((n, seat) => ({ seat, alive: true, hand: new Array(n).fill('杀[♠7]') })),
});

test('出牌阶段:还有牌可用却收手', () => {
  const file = writeLog([
    { type: 'meta', seats: [{ control: 'llm' }, { control: 'rule' }] },
    { type: 'setup', players: [{ seat: 0, general: '甘宁' }, { seat: 1, general: '张飞' }] },
    snap(1, 0, [3, 3]),
    // 有别的选项却收手 -> 计入
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 3, choice: [1] },
    // 只有"结束"可选 -> 不该计入分母
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['结束出牌阶段'] },
    { type: 'answer', of: 5, choice: [0] },
    // 有别的选项,用了 -> 进分母不进分子
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 7, choice: [0] },
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.couldAct, 2, '"只剩收手"那次不算 —— 那不是选择');
  assert.equal(m.endedEarly, 1);
  assert.equal(m.control, 'llm');
  assert.equal(m.general, '甘宁');
});

test('技能:主动技和转化技都要认', () => {
  /*
   * 这条最初写漏了:只认 `【奇袭】` 这种主动技的写法,而甘宁的【奇袭】是转化技,
   * 菜单里长成 `过河拆桥[♠7](奇袭:杀)` —— 于是甘宁、关羽、赵云、大乔这些
   * 转化技武将整个不进统计,指标显示 `—`,看着像"没有技能可用"。
   */
  const file = writeLog([
    { type: 'setup', players: [{ seat: 0, general: '甘宁' }] },
    snap(1, 0, [2]),
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '过河拆桥[♠3](奇袭:杀)', '结束出牌阶段'] },
    { type: 'answer', of: 2, choice: [1] },                 // 用了转化技
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '【离间】', '结束出牌阶段'] },
    { type: 'answer', of: 4, choice: [0] },                 // 有主动技但没用
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 6, choice: [0] },                 // 没有技能可选 -> 不进分母
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.skillOffered, 2);
  assert.equal(m.skillTaken, 1);
});

test('顺序:削弱排在进攻前面', () => {
  // 这条直接对应最初那个观察 —— 甘宁先【杀】后【拆】,顺序反了
  const file = writeLog([
    { type: 'setup', players: [{ seat: 0, general: '甘宁' }] },
    snap(1, 0, [3]),
    // 回合 1:先拆后杀 ✓
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['过河拆桥[♠3]', '结束出牌阶段'] },
    { type: 'answer', of: 2, choice: [0] },
    { type: 'ask', kind: 'playAction', seat: 0, turn: 1, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 4, choice: [0] },
    snap(2, 0, [3]),
    // 回合 2:先杀后拆 ✗
    { type: 'ask', kind: 'playAction', seat: 0, turn: 2, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 7, choice: [0] },
    { type: 'ask', kind: 'playAction', seat: 0, turn: 2, options: ['顺手牵羊[♠3]', '结束出牌阶段'] },
    { type: 'answer', of: 9, choice: [0] },
    snap(3, 0, [3]),
    // 回合 3:只有进攻 -> 两类没凑齐,不进统计
    { type: 'ask', kind: 'playAction', seat: 0, turn: 3, options: ['杀[♠7]', '结束出牌阶段'] },
    { type: 'answer', of: 12, choice: [0] },
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.bothKinds, 2, '只有一类的回合不该进分母');
  assert.equal(m.weakenFirst, 1);
});

test('手牌:回合开始 / 回合结束各取哪张快照', () => {
  // 自己回合开始 = 本回合快照;回合结束 = 下一张快照(弃牌阶段已结算)
  const file = writeLog([
    { type: 'setup', players: [{ seat: 0, general: '吕蒙' }, { seat: 1, general: '张飞' }] },
    snap(1, 0, [5, 2]),
    snap(2, 1, [3, 4]),      // 0 号位回合结束时剩 3 张
    snap(3, 0, [6, 1]),
  ]);
  const m = metricsOfLog(file);
  assert.deepEqual(m.get(0)!.handStart, [5, 6]);
  assert.deepEqual(m.get(0)!.handEnd, [3]);      // 最后一个回合没有"下一张快照"
  assert.deepEqual(m.get(1)!.handStart, [4]);
  assert.equal(m.get(0)!.turns, 2);
});

test('LLM 成本:按 agentId 尾号归到席位,计划执行不重复计费', () => {
  const file = writeLog([
    { type: 'setup', players: [{ seat: 0, general: '甘宁' }] },
    snap(1, 0, [2]),
    { type: 'llm', agentId: 'llm-0', attempts: [{ ms: 2000, usage: { reasoning_tokens: 100 } }] },
    { type: 'llm', agentId: 'llm-0', fromPlan: true },                       // 计划执行,没有 attempts
    { type: 'llm', agentId: 'llm-0', usedFallback: true,
      attempts: [{ ms: 3000, usage: { reasoning_tokens: 50 } }, { ms: 1000, usage: { reasoning_tokens: 20 } }] },
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.llmCalls, 3);
  assert.equal(m.fromPlan, 1);
  assert.equal(m.reasoningTokens, 170, '重试的那次两轮推理都要算进去');
  assert.equal(m.fallbacks, 1, '兜底那一手是规则 AI 打的,做 A/B 时要能分辨出来');
  assert.equal(m.apiCalls, 3, '重试要按次算 —— 一次决策可能发三次请求');
  assert.equal(m.apiMs, 6000);
});

/** 2v2 座次:0/3 蓝队,1/2 红队 */
const teams2v2 = {
  type: 'setup',
  players: [
    { seat: 0, general: '赵云', role: 'blue' }, { seat: 1, general: '周瑜', role: 'red' },
    { seat: 2, general: '关羽', role: 'red' }, { seat: 3, general: '甘宁', role: 'blue' },
  ],
};
const use = (round: number, from: number, card: string, ...to: number[]) => ({
  type: 'log', round,
  line: `  ${from}号位·某将 使用 ${card}[♠7] → ` + to.map(t => `${t}号位·某将`).join('、'),
});

test('误伤队友:走战报文本,因为目标唯一时压根没有 ask 事件', () => {
  /*
   * 20260821-202633:赵云带诸葛连弩,唯一合法目标是队友周瑜,引擎直接替他选掉 ——
   * 没有 ask、没有 answer,只有战报里那行"使用 杀 → 2号位·周瑜"。
   * 解析器要是走 ask/answer,这个案例会一次都统计不到,而它正是要量的东西。
   */
  const file = writeLog([
    teams2v2, snap(1, 0, [1, 1, 1, 1]),
    use(1, 0, '杀', 2),          // 打敌人 ✓
    use(1, 0, '杀', 3),          // 打队友 ✗
    use(1, 0, '决斗', 3),        // 打队友 ✗
    use(1, 0, '过河拆桥', 3),    // 拆队友 —— 可能是在拆他判定区的乐不思蜀,不算误伤
    use(1, 0, '南蛮入侵', 1, 2, 3), // AOE 打到队友,目标不是选的,不算
    use(1, 0, '无中生有', 0),    // 打给自己
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.hostileUses, 3, '分母只数杀/决斗/乐不思蜀');
  assert.equal(m.friendlyFire, 2);
  assert.equal(m.unparsedUses, 0);
});

test('集火:按"不同目标"算,连弩连出三张杀不该把比例顶上去', () => {
  const file = writeLog([
    teams2v2, snap(1, 0, [1, 1, 1, 1]),
    // 第 1 轮:0 和队友 3 都打了 2 号位 -> 集火
    use(1, 0, '杀', 2), use(1, 0, '杀', 2), use(1, 0, '杀', 2),   // 同一个目标,只算一个
    use(1, 3, '过河拆桥', 2),
    // 第 2 轮:0 打 1、队友 3 打 2 -> 各打各的
    use(2, 0, '杀', 1), use(2, 3, '杀', 2),
    // 第 3 轮:队友没出手 -> 谈不上集不集火,不进分母
    use(3, 0, '杀', 1),
  ]);
  const m = metricsOfLog(file);
  assert.equal(m.get(0)!.coAttacks, 2, '第 1 轮 1 个目标 + 第 2 轮 1 个;第 3 轮队友没动,不算');
  assert.equal(m.get(0)!.coFocus, 1);
  assert.equal(m.get(3)!.coAttacks, 2);
  assert.equal(m.get(3)!.coFocus, 1);
});

test('集火要减掉"瞎打基线",否则敌人死剩一个会被读成配合变好', () => {
  /*
   * 这条是整块配合指标里最容易出错的地方。2v2 场上只有两个敌人,瞎打也有 50% 重合;
   * 更要命的是**敌人死剩一个之后集火率必然 100%** —— 不折算的话,
   * "打到残局"会稳定地表现为"配合水平提升",而那纯粹是没得选。
   */
  const file = writeLog([
    teams2v2,
    { type: 'state', turn: 1, cur: 0, players: [0, 1, 2, 3].map(seat => ({ seat, alive: true, hand: [] })) },
    // 第 1 轮:两个敌人都活着 -> 瞎打期望 1×1/2 = 0.5
    use(1, 0, '杀', 2), use(1, 3, '杀', 2),
    // 2 号位阵亡,只剩 1 号位这一个敌人
    { type: 'state', turn: 2, cur: 1, players: [
      { seat: 0, alive: true, hand: [] }, { seat: 1, alive: true, hand: [] },
      { seat: 2, alive: false, hand: [] }, { seat: 3, alive: true, hand: [] }] },
    // 第 2 轮:只能打 1 号位 -> 集火 100%,但瞎打期望也是 1×1/1 = 1.0,净值 0
    use(2, 0, '杀', 1), use(2, 3, '杀', 1),
  ]);
  const m = metricsOfLog(file).get(0)!;
  assert.equal(m.coAttacks, 2);
  assert.equal(m.coFocus, 2, '观测值确实是 100%');
  assert.equal(m.coExpected, 1.5, '瞎打期望 0.5 + 1.0 —— 净值只有 +25pt,不是 +50pt');
});

test('胜负:一局只算一个观测,不按席位数重复计', () => {
  /*
   * 明牌实验第一版踩过这个坑:一支队伍两个席位同赢同输,按席位数
   * 60 局被数成 120 个"独立"样本 —— 标准误低估 √2 倍,
   * 显示成 68/120 p=0.039(看着显著),实际是 34/60 p=0.30(完全不显著)。
   */
  const file = writeLog([
    { type: 'meta', seats: [{ control: 'llm+open' }, { control: 'llm' }, { control: 'llm' }, { control: 'llm+open' }] },
    teams2v2,                                        // 0/3 蓝队,1/2 红队
    snap(1, 0, [1, 1, 1, 1]),
    { type: 'end', winners: [0, 3] },                // 蓝队赢
  ]);
  const m = merge([metricsOfLog(file)]);
  const open = m.get('llm+open/赵云')!;
  assert.equal(open.games + m.get('llm+open/甘宁')!.games, 1, '蓝队两个席位加起来只算一局');
  assert.equal(open.wins + m.get('llm+open/甘宁')!.wins, 1);
  const ctrl = ['llm/周瑜', 'llm/关羽'].map(k => m.get(k)!);
  assert.equal(ctrl.reduce((s, r) => s + r.games, 0), 1);
  assert.equal(ctrl.reduce((s, r) => s + r.wins, 0), 0, '红队输了');
});

test('胜负:同一队里控制方式不同时,两边各自记一局', () => {
  // 之前那批 bench 就是这个形状:每队一个 LLM 一个规则 AI
  const file = writeLog([
    { type: 'meta', seats: [{ control: 'llm' }, { control: 'llm' }, { control: 'rule' }, { control: 'rule' }] },
    teams2v2, snap(1, 0, [1, 1, 1, 1]),
    { type: 'end', winners: [0, 3] },
  ]);
  const m = merge([metricsOfLog(file)]);
  assert.equal(m.get('llm/赵云')!.games, 1, '蓝队的 llm 席位记一局');
  assert.equal(m.get('llm/赵云')!.wins, 1);
  assert.equal(m.get('rule/甘宁')!.games, 1, '同一支蓝队里的 rule 席位也记一局');
  assert.equal(m.get('rule/甘宁')!.wins, 1);
});

test('战报措辞改了要报警,而不是安静地统计成 0', () => {
  // 0 和"从不误伤"看起来一模一样 —— 这个警报器就是为了把这两件事分开
  const file = writeLog([
    teams2v2, snap(1, 0, [1, 1, 1, 1]),
    { type: 'log', round: 1, line: '  P0 使用 杀 → P2' },   // 换了写法,认不出来
  ]);
  const all = [...metricsOfLog(file).values()].reduce((s, r) => s + r.unparsedUses, 0);
  assert.equal(all, 1);
});

test('身份局:内奸没有队友,不进集火统计', () => {
  const file = writeLog([
    {
      type: 'setup', players: [
        { seat: 0, general: 'A', role: 'lord' }, { seat: 1, general: 'B', role: 'loyalist' },
        { seat: 2, general: 'C', role: 'rebel' }, { seat: 3, general: 'D', role: 'renegade' },
      ],
    },
    snap(1, 0, [1, 1, 1, 1]),
    use(1, 0, '杀', 2), use(1, 1, '杀', 2),   // 主 + 忠是一队
    use(1, 3, '杀', 2),                        // 内奸也打了 2,但它没有队友
  ]);
  const m = metricsOfLog(file);
  assert.equal(m.get(0)!.coFocus, 1, '主忠算一队');
  assert.equal(m.get(3)!.coAttacks, 0, '内奸的目标和谁都不一致,算集火没有意义');
});

test('归并:按"控制方式/武将"合,不按座位号', () => {
  // 换一局座位就变了,按座位号归并会把不同的人混在一起
  const a = new Map([[0, { ...blank(), general: '甘宁', control: 'llm', turns: 2, handStart: [3] }]]);
  const b = new Map([[2, { ...blank(), general: '甘宁', control: 'llm', turns: 3, handStart: [5] }]]);
  const m = merge([a as any, b as any]);
  assert.equal(m.size, 1);
  assert.equal(m.get('llm/甘宁')!.turns, 5);
  assert.deepEqual(m.get('llm/甘宁')!.handStart, [3, 5]);
});

test('分母为 0 时显示 —,不拿 0% 冒充"从不"', () => {
  // "0/0" 和 "0/50" 是完全不同的两件事,显示成一样的会直接误导结论
  assert.equal(ratio(0, 0), '—');
  assert.equal(ratio(0, 50), '0/50 (0%)');
  assert.equal(ratio(3, 4), '3/4 (75%)');
  assert.equal(avg([]), 0);
  assert.equal(avg([1, 2, 3]), 2);
});

function blank() {
  return {
    seat: -1, general: '?', control: '?', turns: 0, games: 0, wins: 0,
    playAsks: 0, endedEarly: 0, couldAct: 0,
    handStart: [] as number[], handEnd: [] as number[],
    bothKinds: 0, weakenFirst: 0, skillOffered: 0, skillTaken: 0,
    hostileUses: 0, friendlyFire: 0, coAttacks: 0, coFocus: 0, coExpected: 0, unparsedUses: 0,
    llmCalls: 0, fromPlan: 0, reasoningTokens: 0,
    fallbacks: 0, apiCalls: 0, apiMs: 0,
  };
}
