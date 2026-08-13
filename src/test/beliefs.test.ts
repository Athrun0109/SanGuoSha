/**
 * 身份判断表。
 *
 * 重点在两条边界:
 *  - 规则已确认的身份不接受模型覆盖(它说主公是反贼也没用)
 *  - 真实身份只能出现在日志和评分里,**绝不能进提示词** —— 否则整个推理任务就没了
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { BeliefTable } from '../ai/beliefs.js';
import { Codec } from '../ai/codec.js';
import { LLMAgent } from '../ai/llmAgent.js';
import { Recorder } from '../log/recorder.js';
import { loadLog } from '../log/replay.js';
import { scoreBeliefs } from '../cli/logview.js';
import type { Game } from '../core/game.js';
import type { Role } from '../core/types.js';

function mk(n = 5, seed = 20260806): Game {
  return createGame({
    playerCount: n, seed,
    log: () => {},
    makeAgent: (p, i) => new BasicAI(`ai${i}`),
  });
}

test('1v1 关掉身份推理 —— 两人身份从配置就能推出,没什么可猜的', () => {
  assert.equal(new BeliefTable(2).enabled, false);
  assert.equal(new BeliefTable(3).enabled, true);

  const t = new BeliefTable(2);
  const g = mk(2);
  t.sync(g, g.players[0]);
  assert.equal(t.claimRefresh(1), false);
  assert.deepEqual(t.apply([{ seat: 1, role: 'rebel' }], 1), []);
  assert.equal(t.render(g, g.players[0], new Codec(g, 'verbose')), '');
});

test('规则已确认的身份被锁定,模型改不动', () => {
  const g = mk(5);
  const self = g.players.find(p => p.role !== 'lord')!;
  const lord = g.players.find(p => p.role === 'lord')!;
  const t = new BeliefTable(5);
  t.sync(g, self);

  // 主公开局明示 + 自己 —— 都是 locked
  const rows = t.entries(g);
  assert.equal(rows.find(r => r.seat === lord.seat)!.locked, true);
  assert.equal(rows.find(r => r.seat === self.seat)!.locked, true);

  const applied = t.apply([
    { seat: lord.seat, role: 'rebel', conf: 1, why: '瞎猜' },
    { seat: self.seat, role: 'rebel', conf: 1, why: '瞎猜' },
  ], 3);
  assert.deepEqual(applied, [], '锁定的格子一条都不该生效');
  assert.equal(t.entries(g).find(r => r.seat === lord.seat)!.role, 'lord');
});

test('模型的判断能写进去、能被后续判断推翻', () => {
  const g = mk(5);
  const self = g.players[0];
  const other = g.players.find(p => p !== self && p.role !== 'lord')!;
  const t = new BeliefTable(5);
  t.sync(g, self);

  t.apply([{ seat: other.seat, role: 'rebel', conf: 0.8, why: '打了主公' }], 3);
  let row = t.entries(g).find(r => r.seat === other.seat)!;
  assert.equal(row.role, 'rebel');
  assert.equal(row.conf, 0.8);
  assert.equal(row.round, 3);

  t.apply([{ seat: other.seat, role: 'loyalist', conf: 0.6, why: '改主意了' }], 7);
  row = t.entries(g).find(r => r.seat === other.seat)!;
  assert.equal(row.role, 'loyalist', '后来的判断要能推翻先前的');
  assert.equal(row.round, 7);
});

test('非法的 role / seat / conf 一律被丢掉或夹住', () => {
  const g = mk(5);
  const t = new BeliefTable(5);
  t.sync(g, g.players[0]);
  const free = g.players.find(p => p.seat !== 0 && p.role !== 'lord')!.seat;

  assert.deepEqual(t.apply([{ seat: free, role: '内奸头子' }], 1), [], '不认识的身份要丢掉');
  assert.deepEqual(t.apply([{ seat: 99, role: 'rebel' }], 1), [], '不存在的座位要丢掉');

  t.apply([{ seat: free, role: 'rebel', conf: 7.5, why: 'x'.repeat(500) }], 1);
  const row = t.entries(g).find(r => r.seat === free)!;
  assert.equal(row.conf, 1, 'conf 要夹到 0~1');
  assert.ok(row.why.length <= 80, 'why 要截断,不能让模型往记忆里塞长文');
});

test('真实身份不出现在提示词里', () => {
  const g = mk(5);
  const self = g.players[0];
  const c = new Codec(g, 'verbose');
  const t = new BeliefTable(5);
  t.sync(g, self);
  t.apply(g.players.filter(p => p !== self).map(p => ({
    seat: p.seat, role: 'rebel', conf: 0.5, why: '随便猜的',
  })), 2);

  const text = t.render(g, self, c);
  for (const p of g.players) {
    if (p === self || p.revealed) continue;
    // 渲染出来的每一行只能是模型自己猜的 rebel,不能是真身份
    if (p.role !== 'rebel') {
      assert.ok(!new RegExp(`P${p.seat} ${p.role}\\b`).test(text),
        `P${p.seat} 的真实身份 ${p.role} 泄露进了提示词`);
    }
  }
  // 已明示的座位不重复渲染(局面表里已经有了)
  const lord = g.players.find(p => p.role === 'lord')!;
  assert.ok(!text.includes(`P${lord.seat} `), '已明示的身份不该在判断表里重复出现');
});

test('准确率只统计"自己猜的且给了明确答案"的格子', () => {
  const g = mk(5);
  const self = g.players[0];
  const t = new BeliefTable(5);
  t.sync(g, self);

  assert.deepEqual(t.accuracy(g), { right: 0, total: 0 }, '一条没猜时分母是 0');

  const others = g.players.filter(p => p !== self && !p.revealed);
  // 一条猜对、一条猜错、其余不作答
  const rightOne = others[0], wrongOne = others[1];
  t.apply([
    { seat: rightOne.seat, role: rightOne.role, conf: 0.9, why: '' },
    { seat: wrongOne.seat, role: wrongOne.role === 'rebel' ? 'loyalist' : 'rebel', conf: 0.4, why: '' },
  ], 3);

  assert.deepEqual(t.accuracy(g), { right: 1, total: 2 },
    '没作答的和规则送的都不进分母');
});

test('一轮只催一次复核', () => {
  const t = new BeliefTable(5);
  assert.equal(t.claimRefresh(1), true);
  assert.equal(t.claimRefresh(1), false, '同一轮不该反复催');
  assert.equal(t.claimRefresh(2), true);
});

// ————————————————— 端到端 —————————————————

/** 假客户端:总是选第一个合法选项,并在被要求时给出一份身份判断 */
function fakeClient(reads: () => any[]) {
  let calls = 0;
  return {
    messages: {
      async create(params: any) {
        calls++;
        const asked = /复核身份判断/.test(params.messages[0].content);
        const hasReads = !!params.output_config?.format?.schema?.properties?.reads;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              thinking: 't',
              choice: [0],
              ...(hasReads ? { reads: asked ? reads() : [] } : {}),
            }),
          }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
    get calls() { return calls; },
  };
}

test('端到端:判断表跨回合累积,并进了对局日志', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-blf-'));
  try {
    const rec = new Recorder({ dir });
    let game: Game;
    const client = fakeClient(() => {
      // 每次被问就把所有未明示的座位都猜成 rebel
      return game.players
        .filter(p => !p.revealed && p !== game.players[0])
        .map(p => ({ seat: p.seat, role: 'rebel', conf: 0.7, why: `R${game.round} 观察` }));
    });

    const llm = new LLMAgent('llm-0', { client: client as any, model: 'fake' });
    const hook = rec.llmHook();
    (llm as any).onDecision = hook;

    game = createGame({
      playerCount: 5, seed: 4242,
      log: rec.logFn(),
      makeAgent: (p, i) => rec.wrap(i === 0 ? llm : new BasicAI(`ai${i}`)),
    });
    rec.bind(game);
    rec.start({ seed: 4242, playerCount: 5 });
    const res = await game.setupAndRun();
    rec.finish({ reason: res.reason, winners: res.winners.map(p => p.seat) });
    rec.close();

    assert.ok(llm.beliefs?.enabled, '5 人局应启用身份推理');
    const acc = llm.beliefs!.accuracy(game);
    assert.ok(acc.total > 0, '应该有可评分的判断');

    const log = loadLog(rec.file);
    const events = log.events.filter(e => e.type === 'belief');
    assert.ok(events.length > 0, '身份判断要单独记事件');
    assert.ok(events.every(e => e.agentId === 'llm-0'));
    // 每条事件都带真相和对错,供事后算准确率
    const t = events[0].table;
    assert.ok(t.some((r: any) => r.truth), '日志里的判断表要带真实身份');
    assert.ok(t.some((r: any) => r.locked), '规则已确认的格子要标出来');

    // 按轮记录:同一轮不该有两条
    const rounds = events.map(e => e.round);
    assert.equal(new Set(rounds).size, rounds.length, '一轮只该更新一次');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('端到端:1v1 不带 reads 字段,提示词里也没有判断表', async () => {
  let sawReadsField = false;
  let sawHint = false;
  const client = {
    messages: {
      async create(params: any) {
        if (params.output_config?.format?.schema?.properties?.reads) sawReadsField = true;
        if (/复核身份判断/.test(params.messages[0].content)) sawHint = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ thinking: 't', choice: [0] }) }],
          usage: {},
        };
      },
    },
  };

  const game = createGame({
    playerCount: 2, seed: 9,
    log: () => {},
    makeAgent: (p, i) => i === 0
      ? new LLMAgent('llm', { client: client as any, model: 'fake' })
      : new BasicAI('rule'),
  });
  await game.setupAndRun();

  assert.equal(sawReadsField, false, '2 人局不该把 reads 塞进 schema');
  assert.equal(sawHint, false, '也不该催它复核身份');
});

test('choice 不合法要重试时,这一轮的身份判断不会丢', () => {
  const g = mk(5);
  const t = new BeliefTable(5);
  t.sync(g, g.players[0]);
  const free = g.players.find(p => p.seat !== 0 && !p.revealed)!.seat;

  // 模拟:第一次返回的 choice 越界(会触发重试),但 reads 已经先收下了
  t.apply([{ seat: free, role: 'renegade', conf: 0.5, why: '第一次' }], 4);
  assert.equal(t.entries(g).find(r => r.seat === free)!.role, 'renegade');
});

/**
 * 这条是被实际输出坑出来的:一开始只看终局那张表算准确率,结果显示 0/1 ——
 * 因为阵亡的人身份翻开后变成 locked,全被排除了,分母只剩幸存者。
 * 而表面上那些格子还显示着"✓",看起来像是模型猜对了,其实是规则送的答案。
 */
test('评分按全部历史累计,且不把"已明示"算成猜对', () => {
  const truth = new Map<number, string>([[1, 'rebel'], [2, 'loyalist'], [3, 'renegade']]);
  const events = [
    { round: 1, table: [
      { seat: 1, role: 'loyalist', locked: false },
      { seat: 2, role: 'loyalist', locked: false },
      { seat: 3, role: 'unknown', locked: false },
    ] },
    { round: 5, table: [
      { seat: 1, role: 'rebel', locked: false },     // 这一轮真猜对了
      { seat: 2, role: 'loyalist', locked: false },
      { seat: 3, role: 'rebel', locked: false },
    ] },
    { round: 9, table: [
      { seat: 1, role: 'rebel', locked: true },      // 阵亡翻开 —— 不算成绩
      { seat: 2, role: 'loyalist', locked: true },
      { seat: 3, role: 'rebel', locked: false },
    ] },
  ];

  const { right, total, firstRight } = scoreBeliefs(events, truth);
  // R1: 猜 2 格(1错 2对);R5: 猜 3 格(1对 2对 3错);R9: 只有 3 号是猜的(错)
  assert.equal(total, 6, 'locked 和 unknown 都不进分母');
  assert.equal(right, 3);
  assert.equal(firstRight.get(1), 5, '1号是在第5轮才真的被猜对的');
  assert.equal(firstRight.get(2), 1);
  assert.equal(firstRight.has(3), false, '内奸从没被猜对过');
});

test('身份被翻开后,锁定值覆盖掉之前猜错的', () => {
  const g = mk(5);
  const self = g.players[0];
  const t = new BeliefTable(5);
  t.sync(g, self);

  const victim = g.players.find(p => p !== self && !p.revealed)!;
  const wrong: Role = victim.role === 'rebel' ? 'loyalist' : 'rebel';
  t.apply([{ seat: victim.seat, role: wrong, conf: 0.9, why: '猜错了' }], 2);
  assert.equal(t.entries(g).find(r => r.seat === victim.seat)!.role, wrong);

  victim.revealed = true;               // 阵亡翻开
  t.sync(g, self);
  const row = t.entries(g).find(r => r.seat === victim.seat)!;
  assert.equal(row.role, victim.role, '翻开后应以真相为准');
  assert.equal(row.locked, true);
  assert.equal(row.correct, undefined, '规则送的答案不该计入成绩');
});
