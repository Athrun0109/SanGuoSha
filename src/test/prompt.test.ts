/**
 * 提示词体积与内容边界。
 *
 * 这里管三件事:
 *  1. **只介绍场上的武将。** 25 个武将将来会更多,但一局只用到其中几个;
 *     把没上场的技能也塞进去就是纯浪费。这条性质靠测试锁住,别哪天重构给写回去。
 *  2. **紧凑表格里不重复武将名。** 角色表已经写明 P0 是谁,交手记录和记牌器
 *     每行再带一遍是重复开销 —— 8 人局后期这一项能占到每次重发的三分之一。
 *  3. **L2 局面和 L3 战报是两种粒度。** 局面精确到花色点数(牌是拿来算的),
 *     战报只留因果(结算完的牌是 ♠10 还是 ♣3 不再影响任何决策)。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { Codec } from '../ai/codec.js';
import { generals, cardSpecs } from '../core/registry.js';
import {
  buildRules, eventsBlock, filterLog, identityBlock, situationBlock, hostilityBlock,
} from '../ai/rulesPrompt.js';
import type { Game } from '../core/game.js';
import { realCard } from '../core/types.js';
import { mkGame, give, stackDeck } from './helpers.js';

function mk(fixed: Record<number, string>, n: number, seed = 20260812): Game {
  return createGame({
    playerCount: n, seed, fixedGenerals: fixed,
    log: () => {},
    makeAgent: (p, i) => new BasicAI(`ai${i}`),
  });
}

test('提示词只介绍场上的武将,没上场的技能一个字都不出现', () => {
  const onField = { 0: '刘备', 1: '关羽', 2: '张飞' };
  const game = mk(onField, 3);
  const self = game.players[0];
  const c = new Codec(game, 'verbose');
  const prompt = [
    buildRules(c),
    identityBlock(game, self, c),
    situationBlock(game, self, c),
  ].join('\n');

  const present = new Set(game.players.map(p => p.general.name));
  for (const [name, def] of generals) {
    if (present.has(name)) continue;
    assert.ok(!prompt.includes(name), `没上场的武将 ${name} 出现在提示词里`);
    for (const s of def.skills) {
      // 装备技能和牌同名(如青龙偃月刀),那是牌不是武将技,跳过
      if (cardSpecs.has(s.name)) continue;
      assert.ok(!prompt.includes(s.name),
        `没上场的 ${name} 的技能【${s.name}】出现在提示词里`);
    }
  }
});

test('武将越多,只有 L1 变长,规则本身不变', () => {
  const c3 = new Codec(mk({}, 3), 'verbose');
  const c8 = new Codec(mk({}, 8), 'verbose');
  assert.equal(buildRules(c3), buildRules(c8), 'L0 规则和场上阵容无关');

  const g3 = mk({}, 3), g8 = mk({}, 8);
  const l1of = (g: Game) => identityBlock(g, g.players[0], new Codec(g, 'verbose'));
  assert.ok(l1of(g8).length > l1of(g3).length, '8 人局的 L1 应该更长');

  // 全部 25 个武将的技能描述加起来,比 8 人局的 L1 还长 —— 这就是省下来的量
  const all = [...generals.values()]
    .flatMap(g => g.skills.filter(s => s.desc).map(s => `${s.name}:${s.desc}`)).join(' ');
  assert.ok(all.length > l1of(g8).length,
    '如果把全部武将都塞进去,体积会超过只放场上 8 个');
});

test('交手记录用短座位号,不重复武将名', () => {
  const game = mk({}, 5);
  const [a, b] = game.players;
  game.hostilityLog.set(`${a.seat}->${b.seat}`, 2);

  const c = new Codec(game, 'verbose');
  const text = hostilityBlock(game, c);
  assert.match(text, new RegExp(`P${a.seat}→P${b.seat}:2`));
  for (const p of game.players) {
    assert.ok(!text.includes(p.general.name),
      `交手记录里不该再出现武将名 ${p.general.name}(角色表里已经有了)`);
  }
});

test('两头身份都已明示的一对被剪掉,单头明示的保留', () => {
  const game = mk({}, 5);
  const lord = game.players.find(p => p.role === 'lord')!;      // 开局就明示
  const hidden = game.players.find(p => !p.revealed)!;
  const other = game.players.find(p => p !== lord && p !== hidden && !p.revealed)!;

  game.hostilityLog.set(`${hidden.seat}->${lord.seat}`, 3);     // 未明示 → 主公:关键信号
  game.hostilityLog.set(`${other.seat}->${hidden.seat}`, 1);    // 都没明示:保留

  const c = new Codec(game, 'verbose');
  assert.match(hostilityBlock(game, c), new RegExp(`P${hidden.seat}→P${lord.seat}:3`));

  // 把 hidden 也翻开(模拟阵亡),这一对就没有推理价值了
  hidden.revealed = true;
  const after = hostilityBlock(game, c);
  assert.ok(!after.includes(`P${hidden.seat}→P${lord.seat}`),
    '两头都已明示的一对应该被剪掉');
  assert.match(after, new RegExp(`P${other.seat}→P${hidden.seat}:1`),
    '只有一头明示的仍然有推理价值,要保留');
});

test('anon 模式下 P 标签本来就不带名字,行为一致', () => {
  const game = mk({}, 5);
  game.hostilityLog.set('0->1', 1);
  const text = hostilityBlock(game, new Codec(game, 'anon'));
  assert.match(text, /P0→P1:1/);
});

// ————————————————— L2 vs L3:两种粒度 —————————————————

/** 花色点数标记,如 [♠10] */
const CARD_MARK = /\[[♠♥♣♦](?:10|[2-9AJQK])\]/;

test('局面带花色点数,战报不带', async () => {
  // L2:手牌是拿来算的,♥ 还是 ♠ 直接决定能不能用 —— 必须精确到花色点数
  const { game: g1 } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  give(g1, g1.players[0], '闪', '♥', 3);
  assert.match(situationBlock(g1, g1.players[0], new Codec(g1, 'verbose')), /闪\[♥3\]/,
    '当前局势必须保留花色点数');

  // L3:结算完的牌只留名字,记牌的活交给记牌器
  const g2 = mk({}, 3);
  await g2.setupAndRun();
  const l3 = filterLog(g2.logLines);
  assert.ok(l3.length > 20, '样本要够大才说明问题');
  for (const l of l3) {
    assert.ok(!CARD_MARK.test(l), `战报里不该出现花色点数:${l}`);
  }
});

test('判定只记生效与否,不记判定牌是什么', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a] = game.players;
  await game.useCard(game.makeUse(realCard(give(game, a, '乐不思蜀', '♠', 6)), a, [a]));
  stackDeck(game, [['杀', '♣', 5]]);        // 非♥ → 生效
  await game.runPhase(a, 'judge');

  const l3 = filterLog(game.logLines).join('\n');
  assert.match(l3, /判定\[乐不思蜀\] 生效/, '结果要留下');
  assert.ok(!l3.includes('亮出'), '翻出的是哪张牌交给记牌器,战报里不留');
  assert.ok(!/判定.*杀/.test(l3), '判定牌的牌名也不该出现');
});

test('例外:改判定的技能记录完整保留 —— 这是推身份的强证据', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '司马懿', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  give(game, b, '闪', '♥', 3);
  await game.useCard(game.makeUse(realCard(give(game, a, '乐不思蜀', '♠', 6)), a, [a]));
  stackDeck(game, [['杀', '♣', 5]]);
  agents[1].option = () => 0;               // 司马懿发动鬼才
  await game.runPhase(a, 'judge');

  const line = filterLog(game.logLines).find(l => l.includes('鬼才'));
  assert.ok(line, '鬼才这一行必须留在战报里');
  assert.ok(line!.includes('司马懿'), '谁发动的');
  assert.ok(line!.includes('闪'), '拿什么换的');
  assert.ok(line!.includes('杀'), '换掉了哪张判定牌');
  assert.ok(!CARD_MARK.test(line!), '但仍然不带花色点数');
});

test('"使用"的必然后果不重复叙述一遍', async () => {
  const game = mk({}, 3);
  await game.setupAndRun();
  const noise = [
    [/^\S+ 装备 /, '装备是"使用装备牌"的必然结果'],
    [/^\S+ 摸牌 \d+ 张/, '手牌数在 L2 快照里'],
    [/无中生有 \d+ 张/, '【无中生有】的定义就是摸 2 张'],
    [/击杀奖励 \d+ 张/, '规则里写了击杀反贼摸三张'],
    [/躲开了/, '前一行的"打出 闪"已经说明了'],
    [/濒死!/, '有没有人救,看后面有没有【桃】'],
    [/作为【.+】置于/, '判定区状态在 L2 快照里'],
  ] as const;

  for (const l of filterLog(game.logLines)) {
    for (const [re, why] of noise) {
      assert.ok(!re.test(l), `战报里不该出现「${l}」—— ${why}`);
    }
  }
});

test('战报按字数封顶,不是按行数', () => {
  const game = mk({}, 3);
  const c = new Codec(game, 'verbose');
  // 一长九短:按行数封顶会把这一整块都放进去,按字数封顶只会留住尾部
  const lines = ['x'.repeat(200), ...Array.from({ length: 9 }, (_, i) => `短行${i}`)];

  // 预算 20 字 ≈ 5 条短行。按行数封顶的话这 10 行会全进去(200+ 字)
  const out = eventsBlock(lines, c, 20);
  assert.ok(out.length < 40, `字数预算应该真的生效,实际 ${out.length} 字`);
  assert.ok(!out.includes('x'.repeat(200)), '超预算的旧行要被丢掉');
  assert.ok(out.includes('短行8'), '最新的一行必须保留');
  assert.ok(!out.includes('短行0'), '较旧的行按预算截断');

  // 预算给得再小也不能整块消失 —— 至少留最新一行
  assert.match(eventsBlock(lines, c, 1), /短行8/);
  assert.equal(eventsBlock([], c, 100), '', '没内容时不占位');
});
