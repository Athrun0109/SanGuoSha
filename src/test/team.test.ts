/**
 * 2v2 模式。
 *
 * 这个模式存在的理由不是"多一种玩法",而是**把身份推理这一整块变量拿掉** ——
 * 队伍公开、没有主公、没有击杀奖励,剩下的就只有配合本身。所以下面这些断言里
 * 大半是在锁"什么**没有**发生":不加血、不摸牌、不问身份、不发交手记录。
 *
 * 另一半锁座次。2v2 的出牌顺序必须是 队1→队2→队2→队1,而引擎是按座位号推进的,
 * 所以这件事完全靠"甲乙乙甲"的座次安排来实现 —— 一旦有人把它改成"甲甲乙乙",
 * 引擎里不会报任何错,只是先手方凭空多出连续两个回合。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { identityMode, team2v2Mode, getMode } from '../core/mode.js';
import { BasicAI } from '../ai/basicAI.js';
import { BeliefTable } from '../ai/beliefs.js';
import { buildRules, identityBlock, hostilityBlock } from '../ai/rulesPrompt.js';
import { Codec } from '../ai/codec.js';
import { normalizeConfig } from '../web/config.js';
import type { Role } from '../core/types.js';

function mk(seed = 20260819, fixedRoles?: Record<number, Role>, fixedGenerals?: Record<number, string>) {
  return createGame({
    mode: 'team2v2', playerCount: 4, seed, fixedRoles, fixedGenerals,
    log: () => {},
    makeAgent: (_p, i) => new BasicAI(`ai${i}`),
  });
}

test('座次是"甲乙乙甲",出牌顺序天然就是 队1→队2→队2→队1', () => {
  const g = mk();
  assert.deepEqual(g.players.map(p => p.role), ['blue', 'red', 'red', 'blue']);
  // 引擎按座位号推进,所以座次即顺序;每个人的两个邻座一个队友一个对手
  for (const p of g.players) {
    const left = g.players[(p.seat + 1) % 4];
    const right = g.players[(p.seat + 3) % 4];
    assert.notEqual(g.ally(p, left), g.ally(p, right),
      `${p.seat} 号位的两个邻座应该一边一个`);
  }
  assert.equal(g.current.seat, 0, '0 号位先手');
});

test('没有主公:谁都不 +1 体力上限,谁都用不了主公技', () => {
  const g = mk(20260819, undefined, { 0: '曹操', 1: '孙权' });
  for (const p of g.players) {
    assert.equal(p.maxHp, p.general.hp, `${p.general.name} 不该有体力加成`);
    assert.equal(p.role === 'lord', false);
  }
  // 曹操的护驾、孙权的救援都是主公技 —— 没有主公身份就不生效
  const cao = g.players[0];
  const hujia = cao.skills.find(s => s.name === '护驾')!;
  assert.ok(hujia, '曹操应该带着护驾');
  assert.equal(g.skillEnabled(cao, hujia), false, '主公技在 2v2 里不生效');
});

test('队伍开局就公开 —— 这是模式的前提,不是可选项', () => {
  const g = mk();
  assert.equal(g.mode.hidden, false);
  for (const p of g.players) assert.equal(p.revealed, true);
});

test('一队全灭,另一队获胜', async () => {
  const g = mk();
  const [b0, r1, r2, b3] = g.players;
  assert.equal(g.mode.checkOver(g), null, '开局没有结束');

  await g.kill(r1, b0).catch(() => {});
  assert.equal(g.mode.checkOver(g), null, '红队还剩一个人,没结束');

  r2.alive = false;
  const res = g.mode.checkOver(g)!;
  assert.ok(res, '红队全灭应该判负');
  assert.deepEqual(res.winners.map(p => p.seat).sort(), [b0.seat, b3.seat].sort());
  assert.match(res.reason, /蓝队/);
});

test('没有击杀奖励 —— 有的话会诱导 AI 抢人头', async () => {
  const g = mk();
  const [killer, victim] = g.players;
  const before = killer.handCount;
  await g.mode.onKill(g, victim, killer);
  assert.equal(killer.handCount, before, '击杀不摸牌');
});

test('队伍公开时身份推理整块关掉', () => {
  assert.equal(new BeliefTable(4, false).enabled, false, '2v2 不问身份');
  assert.equal(new BeliefTable(4, true).enabled, true, '4 人身份局照问');
});

test('提示词:告诉它队友是谁、以及"队伍活着就算赢"', () => {
  const g = mk();
  const c = new Codec(g, 'verbose');
  const self = g.players[0];                 // 蓝队,队友是 3 号位
  const block = identityBlock(g, self, c);

  assert.match(block, /2v2/, '要说清这是什么模式');
  assert.match(block, /同队/);
  assert.ok(block.includes(c.player(g.players[3])), '队友是谁必须明写出来');
  assert.match(block, /只要你们队还有人活着就算赢/);
  assert.doesNotMatch(block, /只有你自己知道/, '队伍是公开的,别再说"只有你知道"');

  // 交手记录唯一的用途是推身份,这里纯属烧 token
  assert.equal(hostilityBlock(g, c), '');

  const rules = buildRules(c, team2v2Mode);
  assert.match(rules, /一队全部阵亡则另一队获胜/);
  assert.doesNotMatch(rules, /renegade/, '2v2 没有内奸,别把身份局的胜负条件混进来');
  assert.doesNotMatch(rules, /摸3张/, '没有击杀奖励');
  // 身份局那份不能被改坏
  assert.match(buildRules(c, identityMode), /renegade/);
});

test('规则 AI 能把一整局 2v2 打完', async () => {
  for (const seed of [1, 20260819, 777]) {
    const lines: string[] = [];
    const g = createGame({
      mode: team2v2Mode, playerCount: 4, seed,
      log: m => lines.push(m),
      makeAgent: (_p, i) => new BasicAI(`ai${i}`),
    });
    const r = await g.setupAndRun();
    assert.ok(r.winners.length > 0, `seed=${seed} 不该打成平局/超时`);
    // 胜者必须同队
    assert.equal(new Set(r.winners.map(p => p.role)).size, 1);
    assert.equal(lines.filter(l => l.includes('击杀奖励')).length, 0, '2v2 不发击杀奖励');
  }
});

test('手动指定队伍:名额和名字都按模式来', () => {
  const g = mk(20260819, { 0: 'red', 1: 'blue' });
  assert.equal(g.players[0].role, 'red');
  assert.equal(g.players[1].role, 'blue');
  assert.deepEqual(g.players.map(p => p.role).sort(), ['blue', 'blue', 'red', 'red']);

  assert.throws(() => mk(1, { 0: 'red', 1: 'red', 2: 'red' }), /红队 指定多了 —— 本局只有 2 个/);
  assert.throws(() => mk(1, { 0: 'lord' }), /主公 指定多了 —— 本局只有 0 个/);
  assert.throws(() => createGame({
    mode: 'team2v2', playerCount: 3, log: () => {},
    makeAgent: (_p, i) => new BasicAI(`ai${i}`),
  }), /2v2 对抗不支持 3 人/);
});

test('身份局一个字都不能受影响', () => {
  // 模式抽象是重构,不是改规则 —— 老的 seed 必须开出一模一样的局
  const id = (seed: number) => createGame({
    playerCount: 5, seed, log: () => {}, makeAgent: (_p, i) => new BasicAI(`ai${i}`),
  });
  const g = id(20260814);
  assert.equal(g.players[0].role, 'lord');
  assert.equal(g.current, g.players[0]);
  assert.ok(g.players[0].maxHp > g.players[0].general.hp, '主公照旧 +1 体力上限');
  assert.deepEqual(id(20260814).players.map(p => p.general.name), g.players.map(p => p.general.name));
  assert.equal(getMode(undefined), identityMode, '不指定模式就是身份局');
  assert.equal(getMode('乱写的'), identityMode);
});

test('设置页传上来的模式要过校验', () => {
  const seats = (n: number) => Array.from({ length: n }, () => ({ control: 'rule' }));
  const cfg = normalizeConfig({ mode: 'team2v2', playerCount: 4, seats: seats(4) });
  assert.equal(cfg.mode, 'team2v2');

  assert.throws(() => normalizeConfig({ mode: 'team2v2', playerCount: 3, seats: seats(3) }),
    /2v2 对抗的人数只能是 4/);
  assert.throws(() => normalizeConfig({
    mode: 'team2v2', playerCount: 4,
    seats: [{ control: 'rule', role: 'lord' }, ...seats(3)],
  }), /身份不认识.*lord/);
  // 反过来,身份局里不认识队伍
  assert.throws(() => normalizeConfig({
    playerCount: 4, seats: [{ control: 'rule', role: 'blue' }, ...seats(3)],
  }), /身份不认识.*blue/);
  assert.throws(() => normalizeConfig({ mode: '不存在的模式', playerCount: 4, seats: seats(4) }),
    /对局模式 只能是/);
});

// ————————————————— MCP 那条路 —————————————————

test('MCP 开 2v2:人数被模式纠正,队友是谁写在开局说明里', async () => {
  const { GameSession } = await import('../mcp/session.js');
  // 故意传 2 人 —— 2v2 只有 4 人这一档,应该被纠正而不是报错
  const s = new GameSession({ mode: 'team2v2', players: 2, seat: 0, seed: 42 });
  assert.equal(s.game.players.length, 4);
  assert.deepEqual(s.game.players.map(p => p.role), ['blue', 'red', 'red', 'blue']);

  const view = s.render({ withRules: true, withIdentity: true });
  assert.match(view, /同队/, '开局就得告诉它队友是谁');
  assert.match(view, /一队全部阵亡则另一队获胜/);
});

test('MCP 的 humanSeat 真的开了人类座位', async () => {
  /*
   * 真实事故:humanSeat 在工具 schema 里写着、说明里讲着,就是没往 GameSession 传。
   * 于是那个座位悄悄变成规则 AI,真人 npm run join 上来发现根本没有位子等他 ——
   * 而且没有任何报错。人机配合这条路是 2v2 的主要用途之一,这里钉死。
   */
  const { GameSession } = await import('../mcp/session.js');
  const s = new GameSession({ mode: 'team2v2', seat: 0, humanSeat: 3, seed: 42 });
  assert.equal(s.humanSeat, 3);
  assert.ok(s.hub, '设了 humanSeat 就该开 hub 等人接进来');
  assert.equal(s.game.ally(s.game.players[0], s.game.players[3]), true,
    '0 和 3 号位同队 —— 这正是"人和 AI 当队友"的坐法');
});
