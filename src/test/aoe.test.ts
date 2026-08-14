/**
 * 群体锦囊的结算次序。
 *
 * 这是一个真实报上来的 bug:1 号位使用【五谷丰登】,结果 0 号位先挑牌。
 * 根因是 `autoTargets` 用了 `g.alivePlayers` / `g.others(from)` —— 这两个都按
 * **座位号**排,不是按**行动顺序**排,于是 0 号位永远排在最前面。
 *
 * 正确的规则:
 *   收益牌(桃园结义、五谷丰登)  从使用者自己开始,按座次
 *   伤害牌(南蛮入侵、万箭齐发)  跳过使用者,从其下家开始,按座次
 *
 * 次序不是摆设:五谷先挑走好牌是使用它的主要理由;南蛮里先被点到的人先结算
 * 伤害、先濒死,而谁先死会改变后面还有谁活着能出【桃】。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { cardSpecs } from '../core/registry.js';
import { mkGame, give, stackDeck } from './helpers.js';
import { realCard } from '../core/types.js';

/** 某张牌由 seat 使用时,目标依次是谁 */
function orderOf(name: string, seat: number, n = 4): number[] {
  const { game } = mkGame({}, n);
  const spec = cardSpecs.get(name)!;
  return spec.autoTargets!(game, game.players[seat], null as any).map(p => p.seat);
}

test('收益牌从使用者自己开始,按座次绕一圈', () => {
  for (const name of ['五谷丰登', '桃园结义']) {
    assert.deepEqual(orderOf(name, 1), [1, 2, 3, 0], `${name}:1 号位使用时该自己先`);
    assert.deepEqual(orderOf(name, 0), [0, 1, 2, 3], `${name}:0 号位使用`);
    assert.deepEqual(orderOf(name, 3), [3, 0, 1, 2], `${name}:末位使用要绕回去`);
  }
});

test('伤害牌跳过使用者,从下家开始', () => {
  for (const name of ['南蛮入侵', '万箭齐发']) {
    assert.deepEqual(orderOf(name, 1), [2, 3, 0], `${name}:不该打到自己`);
    assert.deepEqual(orderOf(name, 0), [1, 2, 3]);
    assert.deepEqual(orderOf(name, 3), [0, 1, 2], `${name}:末位使用要绕回去`);
  }
});

test('阵亡的角色不参与,次序照样从使用者往下绕', () => {
  const { game } = mkGame({}, 4);
  game.players[2].alive = false;
  const wugu = cardSpecs.get('五谷丰登')!;
  assert.deepEqual(
    wugu.autoTargets!(game, game.players[1], null as any).map(p => p.seat), [1, 3, 0]);
  const nanman = cardSpecs.get('南蛮入侵')!;
  assert.deepEqual(
    nanman.autoTargets!(game, game.players[1], null as any).map(p => p.seat), [3, 0]);
});

test('端到端:1 号位打五谷,先挑牌的是 1 号位', async () => {
  const { game, agents } = mkGame({ 0: '貂蝉', 1: '孙尚香', 2: '甘宁' }, 3);
  // 每个人都挑池子里的第一张,这样"谁先挑"直接决定谁拿到桃
  for (const a of agents) a.option = () => 0;

  const from = game.players[1];
  const wugu = give(game, from, '五谷丰登', '♥', 4);
  stackDeck(game, [['桃', '♦', 12], ['青釭剑', '♠', 6], ['闪', '♥', 2]]);
  // 走 selectTargets —— 那才是引擎应用 autoTargets 的入口,直接 makeUse 会绕过它
  const vc = realCard(wugu);
  const targets = await game.selectTargets(from, vc);
  assert.deepEqual(targets!.map(p => p.seat), [1, 2, 0], '目标次序:使用者优先');
  await game.useCard(game.makeUse(vc, from, targets!));

  const picks = game.logLines.filter(l => l.includes('取走')).map(l => l.trim());
  assert.equal(picks.length, 3, '三个人各取一张');
  assert.match(picks[0], /1号位.*取走 桃/, '使用者先挑,拿到最上面那张【桃】');
  assert.match(picks[1], /2号位/, '然后是下家');
  assert.match(picks[2], /0号位/);
});
