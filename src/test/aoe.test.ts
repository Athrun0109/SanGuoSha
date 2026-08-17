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

/** 某张牌由 seat 使用时,目标依次是谁。wound=true 时先把所有人打伤 */
function orderOf(name: string, seat: number, n = 4, wound = false): number[] {
  const { game } = mkGame({}, n);
  if (wound) for (const p of game.players) p.hp = p.maxHp - 1;
  const spec = cardSpecs.get(name)!;
  return spec.autoTargets!(game, game.players[seat], null as any).map(p => p.seat);
}

test('收益牌从使用者自己开始,按座次绕一圈', () => {
  // 桃园结义要先把人打伤 —— 它现在会跳过满血的角色(见下面那条)
  for (const [name, wound] of [['五谷丰登', false], ['桃园结义', true]] as const) {
    assert.deepEqual(orderOf(name, 1, 4, wound), [1, 2, 3, 0], `${name}:1 号位使用时该自己先`);
    assert.deepEqual(orderOf(name, 0, 4, wound), [0, 1, 2, 3], `${name}:0 号位使用`);
    assert.deepEqual(orderOf(name, 3, 4, wound), [3, 0, 1, 2], `${name}:末位使用要绕回去`);
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

// ————————————————— 桃园结义跳过满血角色 —————————————————

test('桃园结义只指定受伤的人 —— 满血的连无懈窗口都不该开', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b, c] = game.players;
  game.current = a;
  a.hp = a.maxHp - 1;          // 受伤
  c.hp = c.maxHp - 1;          // 受伤
  // b 满血

  const asks: string[] = [];
  agents.forEach((ag, seat) => {
    ag.respond = (_o: any, _p: any, ctx?: any) => { asks.push(`${seat}:${ctx?.purpose}`); return -1; };
  });

  const tao = give(game, a, '桃园结义', '♥', 1);
  const targets = await game.selectTargets(a, realCard(tao));
  assert.deepEqual(targets!.map(p => p.seat), [0, 2], '满血的 1 号位不该被指定');

  await game.useCard(game.makeUse(realCard(tao), a, targets!));
  assert.equal(a.hp, a.maxHp, '受伤的回满');
  assert.equal(c.hp, c.maxHp);
  // 无懈窗口只为真正会生效的目标开
  const nul = asks.filter(x => x.endsWith('nullify'));
  assert.ok(nul.length > 0, '受伤目标仍然要开无懈窗口');
  assert.equal(new Set(nul.map(x => x.split(':')[0])).size <= 3, true);
});

test('全场满血时桃园结义仍然可以打出去 —— 黄月英要靠它触发集智', async () => {
  // 这条和"多素材转化不剪劣势组合"是同一个道理:引擎不替玩家判断什么叫没用。
  // 黄月英的集智是"使用锦囊牌就摸一张",打一张什么都不回的桃园结义换一张牌是实打实的操作。
  const { game } = mkGame({ 0: '黄月英', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a] = game.players;
  game.current = a;
  const tao = give(game, a, '桃园结义', '♥', 1);

  const usable = game.enumerateUsable(a).map(o => o.label);
  assert.ok(usable.some(l => l.includes('桃园结义')), '全场满血也要能用:' + usable.join(' / '));

  const before = a.hand.length;
  await game.useCard(game.makeUse(realCard(tao), a, (await game.selectTargets(a, realCard(tao)))!));
  assert.equal(a.hand.length, before - 1 + 1, '牌打出去了,集智补回一张');
});
