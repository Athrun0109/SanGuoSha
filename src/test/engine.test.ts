import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkGame, give, stackDeck, ScriptAgent, buildDeck } from './helpers.js';
import { createGame, parseGeneralSpec } from '../core/setup.js';
import { cardSpecs, generals } from '../core/registry.js';
import { realCard } from '../core/types.js';
import { STANDARD_GENERALS } from '../content/generals.js';
import { DECK_TABLE } from '../content/cards.js';

// ————————————————— 内容完整性 —————————————————

test('牌堆:每张牌都有对应的行为定义', () => {
  const deck = buildDeck();
  assert.equal(deck.length, DECK_TABLE.length);
  assert.equal(deck.length, 106, '当前配比为 106 张;改了 DECK_TABLE 记得同步这里');
  for (const c of deck) assert.ok(cardSpecs.has(c.name), `未定义的牌:${c.name}`);
  const ids = new Set(deck.map(c => c.id));
  assert.equal(ids.size, deck.length, '牌的 id 必须唯一');
});

test('武将:标准包 25 将全部注册且都有技能', () => {
  assert.equal(STANDARD_GENERALS.length, 25);
  for (const name of STANDARD_GENERALS) {
    const g = generals.get(name);
    assert.ok(g, `未注册的武将:${name}`);
    assert.ok(g!.skills.length > 0, `${name} 没有技能`);
  }
});

// ————————————————— 距离与攻击范围 —————————————————

test('距离:座次 + 坐骑 + 马术', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '关羽', 2: '马超' }, 3);
  const [a, b, c] = game.players;
  assert.equal(game.distance(a, b), 1);
  assert.equal(game.attackRange(a), 1);

  // 马超的马术:自己算距离 -1,但最小为 1
  assert.equal(game.distance(c, a), 1);

  // 给 b 装一匹 +1 马,别人算到他的距离 +1
  const horse = give(game, b, '+1马', '♠', 5);
  await game.equipCard(b, horse);
  assert.equal(game.distance(a, b), 2);
  assert.equal(game.distance(b, a), 1);
});

test('武器改变攻击范围', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '关羽', 2: '甘宁' }, 3);
  const p = game.players[0];
  assert.equal(game.attackRange(p), 1);
  await game.equipCard(p, give(game, p, '青龙偃月刀', '♠', 5));
  assert.equal(game.attackRange(p), 3);
});

// ————————————————— 杀 / 闪 / 伤害 —————————————————

test('杀:没有闪就掉血,有闪就闪掉', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;

  const slash = give(game, a, '杀', '♣', 7);
  await game.useCard(game.makeUse(realCard(slash), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '无闪应受到 1 点伤害');

  give(game, b, '闪', '♦', 3);
  const slash2 = give(game, a, '杀', '♣', 8);
  await game.useCard(game.makeUse(realCard(slash2), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '有闪应免疫伤害');
  assert.equal(b.hand.length, 0, '闪应被消耗');
});

test('仁王盾挡黑杀,青釭剑无视仁王盾', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  await game.equipCard(b, give(game, b, '仁王盾', '♣', 2));

  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♠', 7)), a, [b]));
  assert.equal(b.hp, b.maxHp, '黑杀应被仁王盾无效');

  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♥', 7)), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '红杀不受仁王盾影响');

  await game.equipCard(a, give(game, a, '青釭剑', '♠', 6));
  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♠', 8)), a, [b]));
  assert.equal(b.hp, b.maxHp - 2, '青釭剑应无视仁王盾');
});

test('吕布无双:需要两张闪', async () => {
  const { game } = mkGame({ 0: '吕布', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;

  give(game, b, '闪', '♦', 3);
  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♣', 7)), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '只有一张闪挡不住无双');

  give(game, b, '闪', '♦', 4);
  give(game, b, '闪', '♦', 5);
  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♣', 8)), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '两张闪应挡住');
});

// ————————————————— 转化技 —————————————————

test('关羽武圣:红色牌可以当杀', () => {
  const { game } = mkGame({ 0: '关羽', 1: '吕蒙', 2: '甘宁' }, 3);
  const a = game.players[0];
  give(game, a, '桃', '♥', 3);
  give(game, a, '闪', '♦', 4);
  give(game, a, '过河拆桥', '♠', 3);   // 黑色,不能转化

  const opts = game.enumerateResponses(a, { names: ['杀'] }, { mode: 'respond', purpose: 'slash' });
  assert.equal(opts.length, 2, '两张红牌应各产生一个【杀】选项');
  assert.ok(opts.every(o => o.card.name === '杀' && o.card.skill === '武圣'));
});

test('赵云龙胆:杀闪互转', () => {
  const { game } = mkGame({ 0: '赵云', 1: '吕蒙', 2: '甘宁' }, 3);
  const a = game.players[0];
  give(game, a, '杀', '♣', 7);
  assert.equal(
    game.enumerateResponses(a, { names: ['闪'] }, { mode: 'respond', purpose: 'dodge' }).length, 1,
    '手里的【杀】应该能当【闪】',
  );
});

test('诸葛亮空城:没手牌就不能被杀指定', () => {
  const { game } = mkGame({ 0: '孙权', 1: '诸葛亮', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  const slash = realCard(give(game, a, '杀', '♣', 7));
  assert.equal(game.canTarget(a, b, slash, []), false, '空城生效');
  give(game, b, '闪', '♦', 3);
  assert.equal(game.canTarget(a, b, slash, []), true, '有手牌则空城失效');
});

// ————————————————— 判定 / 延时锦囊 —————————————————

test('闪电:♠2-9 判定成功造成 3 点伤害', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const a = game.players[0];
  const light = give(game, a, '闪电', '♠', 1);
  await game.useCard(game.makeUse(realCard(light), a, [a]));
  assert.equal(a.judgeZone.length, 1, '闪电应进入判定区');

  stackDeck(game, [['杀', '♠', 5]]);   // 判定成功
  await game.runPhase(a, 'judge');
  assert.equal(a.hp, a.maxHp - 3, '闪电应造成 3 点伤害');
});

test('乐不思蜀:判定非♥则跳过出牌阶段', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  await game.useCard(game.makeUse(realCard(give(game, a, '乐不思蜀', '♠', 6)), a, [b]));
  assert.equal(b.judgeZone.length, 1);

  stackDeck(game, [['杀', '♣', 5]]);   // 非红桃 -> 生效
  await game.runPhase(b, 'judge');
  assert.equal(b.mark('turn:skip:play'), 1, '应被标记为跳过出牌阶段');
});

test('司马懿鬼才可以改判定', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '司马懿', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  give(game, b, '闪', '♥', 3);    // 用红桃去改判定

  await game.useCard(game.makeUse(realCard(give(game, a, '乐不思蜀', '♠', 6)), a, [a]));
  stackDeck(game, [['杀', '♣', 5]]);  // 原本会生效
  agents[1].option = () => 0;         // 司马懿:发动鬼才
  await game.runPhase(a, 'judge');
  assert.equal(a.mark('turn:skip:play'), 0, '判定被改成♥,乐不思蜀不生效');
});

// ————————————————— 无懈可击 —————————————————

test('无懈可击可以抵消锦囊,再来一张则恢复效果', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b, c] = game.players;

  give(game, b, '无懈可击', '♠', 11);
  agents[1].respond = () => 0;   // 吕蒙:出无懈
  agents[2].respond = () => -1;
  await game.useCard(game.makeUse(realCard(give(game, a, '决斗', '♠', 1)), a, [b]));
  assert.equal(b.hp, b.maxHp, '决斗被无懈抵消');

  // 连环:b 无懈,c 再无懈 -> 决斗恢复效果
  give(game, b, '无懈可击', '♠', 11);
  give(game, c, '无懈可击', '♣', 12);
  agents[2].respond = (o, p, ctx) => (ctx?.negated ? 0 : -1);
  await game.useCard(game.makeUse(realCard(give(game, a, '决斗', '♣', 1)), a, [b]));
  assert.equal(b.hp, b.maxHp - 1, '第二张无懈应让决斗恢复效果');
});

// ————————————————— 濒死 / 死亡 —————————————————

test('濒死时可以用桃救回', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  b.hp = 1;
  give(game, b, '桃', '♥', 5);
  agents[1].respond = () => 0;

  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♣', 7)), a, [b]));
  assert.equal(b.alive, true, '应被桃救回');
  assert.equal(b.hp, 1);
});

test('无人救援则阵亡,击杀反贼摸三张', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  b.role = 'rebel';
  a.role = 'lord';
  b.hp = 1;
  for (const ag of agents) ag.respond = () => -1;

  const before = a.handCount;
  await game.useCard(game.makeUse(realCard(give(game, a, '杀', '♣', 7)), a, [b]));
  assert.equal(b.alive, false);
  assert.equal(a.handCount, before + 3, '击杀反贼应摸三张牌');
});

// ————————————————— 技能 —————————————————

test('曹操奸雄:受伤后获得造成伤害的牌', async () => {
  const { game, agents } = mkGame({ 0: '吕蒙', 1: '曹操', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  agents[1].option = () => 0;   // 发动奸雄
  const slash = give(game, a, '杀', '♣', 7);
  await game.useCard(game.makeUse(realCard(slash), a, [b]));
  assert.equal(b.hp, b.maxHp - 1);
  assert.ok(b.hand.includes(slash), '奸雄应拿到那张杀');
});

test('张飞咆哮:出牌阶段杀不限次数', () => {
  const { game } = mkGame({ 0: '张飞', 1: '吕蒙', 2: '甘宁' }, 3);
  const a = game.players[0];
  assert.equal(game.slashLimit(a), Infinity);
  assert.equal(game.slashLimit(game.players[1]), 1);
});

test('周瑜英姿:摸牌阶段多摸一张', async () => {
  const { game } = mkGame({ 0: '周瑜', 1: '吕蒙', 2: '甘宁' }, 3);
  const a = game.players[0];
  await game.runPhase(a, 'draw');
  assert.equal(a.handCount, 3, '2 + 英姿 1 = 3');
});

test('陆逊谦逊:不能成为顺手牵羊和乐不思蜀的目标', () => {
  const { game } = mkGame({ 0: '孙权', 1: '陆逊', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  give(game, b, '闪', '♦', 3);
  assert.equal(game.canTarget(a, b, realCard(give(game, a, '顺手牵羊', '♠', 3)), []), false);
  assert.equal(game.canTarget(a, b, realCard(give(game, a, '乐不思蜀', '♠', 6)), []), false);
  assert.equal(game.canTarget(a, b, realCard(give(game, a, '过河拆桥', '♠', 4)), []), true);
});

test('黄月英奇才:锦囊无距离限制', () => {
  const { game } = mkGame({ 0: '黄月英', 1: '吕蒙', 2: '甘宁', 3: '关羽', 4: '张飞' }, 5);
  const a = game.players[0];
  const far = game.players[2];
  give(game, far, '闪', '♦', 3);          // 顺手牵羊要求目标有牌
  give(game, game.players[3], '闪', '♦', 4);
  assert.ok(game.distance(a, far) > 1);
  assert.equal(game.canTarget(a, far, realCard(give(game, a, '顺手牵羊', '♠', 3)), []), true);
  const b = game.players[1];
  assert.equal(game.canTarget(b, game.players[3], realCard(give(game, b, '顺手牵羊', '♠', 4)), []), false);
});

test('装备后牌必须离开手牌,不能同时留在两个区域', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const p = game.players[0];
  const horse = give(game, p, '+1马', '♠', 5);
  const other = give(game, p, '杀', '♣', 7);
  assert.equal(p.handCount, 2);

  await game.equipCard(p, horse);
  assert.equal(p.handCount, 1, '装备后手牌应少一张');
  assert.ok(!p.hand.includes(horse), '装备牌不能还留在手牌里');
  assert.equal(p.equips['horse+1'], horse);
  assert.equal(game.locate(horse)?.zone, 'equip');
  assert.equal(p.allCards.length, 2, '手牌1 + 装备1');
  assert.ok(p.hand.includes(other));
});

test('通过出牌阶段使用装备牌,同样只会占一份', async () => {
  const { game, agents } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const p = game.players[0];
  const weapon = give(game, p, '青龙偃月刀', '♠', 5);
  await game.useCard(game.makeUse(realCard(weapon), p, [p]));
  assert.equal(p.handCount, 0);
  assert.equal(p.equips.weapon, weapon);
  assert.equal(game.attackRange(p), 3);
});

test('用掉最后一张手牌去装备,也应触发【连营】', async () => {
  const { game, agents } = mkGame({ 0: '陆逊', 1: '吕蒙', 2: '甘宁' }, 3);
  const p = game.players[0];
  const horse = give(game, p, '-1马', '♥', 5);
  agents[0].option = () => 0;   // 陆逊:发动连营
  await game.useCard(game.makeUse(realCard(horse), p, [p]));
  assert.equal(p.handCount, 1, '连营应该补回一张牌');
});

// ————————————————— 起始手牌 / 后手补牌 —————————————————

test('多人局每人起手 4 张', () => {
  const g = createGame({
    playerCount: 5, seed: 1, verbose: false, makeAgent: () => new ScriptAgent(),
  });
  assert.deepEqual(g.players.map(p => p.handCount), [4, 4, 4, 4, 4]);
});

test('1v1 默认后手补 1 张', () => {
  const g = createGame({
    playerCount: 2, seed: 1, verbose: false, makeAgent: () => new ScriptAgent(),
  });
  assert.deepEqual(g.players.map(p => p.handCount), [4, 5], '先手 4 张,后手 5 张');
});

test('startingHand 可以覆盖默认值', () => {
  const off = createGame({
    playerCount: 2, seed: 1, verbose: false, startingHand: 4, makeAgent: () => new ScriptAgent(),
  });
  assert.deepEqual(off.players.map(p => p.handCount), [4, 4], '传数字则所有人相同');

  const custom = createGame({
    playerCount: 3, seed: 1, verbose: false, startingHand: [2, 6, 4], makeAgent: () => new ScriptAgent(),
  });
  assert.deepEqual(custom.players.map(p => p.handCount), [2, 6, 4], '传数组则按座位指定');
});

test('起始手牌确实从牌堆里扣掉了', () => {
  const g = createGame({
    playerCount: 2, seed: 1, verbose: false, startingHand: [4, 5], makeAgent: () => new ScriptAgent(),
  });
  assert.equal(g.deck.length + 9, buildDeck().length, '牌堆应少掉发出去的 9 张');
});

// ————————————————— 手动点将 —————————————————

test('parseGeneralSpec:按座位解析,空位表示随机', () => {
  assert.deepEqual(parseGeneralSpec('关羽,,吕布', 3), { 0: '关羽', 2: '吕布' });
  assert.deepEqual(parseGeneralSpec(['', '貂蝉'], 2), { 1: '貂蝉' });
  assert.equal(parseGeneralSpec('', 2), undefined);
  assert.equal(parseGeneralSpec(undefined, 2), undefined);
});

test('parseGeneralSpec:不认识的名字报错并给出候选', () => {
  assert.throws(() => parseGeneralSpec('关羽,张三', 2), /没有这些武将[\s\S]*张三[\s\S]*可选/);
});

test('点将能覆盖主公武将池(0号位不再限于三个主公将)', () => {
  const g = createGame({
    playerCount: 2, seed: 1, verbose: false,
    fixedGenerals: { 0: '吕布', 1: '诸葛亮' },
    makeAgent: () => new ScriptAgent(),
  });
  assert.equal(g.players[0].general.name, '吕布');
  assert.equal(g.players[0].role, 'lord');
  assert.equal(g.players[1].general.name, '诸葛亮');
  assert.ok(g.players[0].hasSkill('无双'), '技能应跟着点的将走');
});

test('点将只指定部分座位时,其余仍随机且不重复', () => {
  const g = createGame({
    playerCount: 5, seed: 9, verbose: false,
    fixedGenerals: { 2: '华佗' },
    makeAgent: () => new ScriptAgent(),
  });
  assert.equal(g.players[2].general.name, '华佗');
  const names = g.players.map(p => p.general.name);
  assert.equal(new Set(names).size, 5, '随机分配的武将不应重复');
});

// ————————————————— 闪电被无懈之后的去向 —————————————————

test('闪电被无懈可击抵消后应移到下家判定区,而不是被弃掉', async () => {
  const { game, agents } = mkGame({ 0: '陆逊', 1: '吕布', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  const bolt = give(game, a, '闪电', '♥', 12);
  await game.useCard(game.makeUse(realCard(bolt), a, [a]));
  assert.equal(a.judgeZone.length, 1, '闪电应先进自己的判定区');

  // 让 1 号位打出无懈可击抵消它
  give(game, b, '无懈可击', '♦', 12);
  agents[1].respond = () => 0;
  agents[0].respond = () => -1;
  agents[2].respond = () => -1;

  await game.runPhase(a, 'judge');

  assert.equal(a.judgeZone.length, 0, '不该再留在自己判定区');
  assert.equal(a.hp, a.maxHp, '被无懈了就不该掉血');
  assert.ok(!game.discardPile.includes(bolt), '闪电不该被弃掉');
  assert.ok(b.judgeZone.includes(bolt), `闪电应转到下家判定区,实际在 ${game.locate(bolt)?.zone}`);
  assert.equal(game.judgeName(b, bolt), '闪电', '转过去之后仍然是闪电');
});

test('乐不思蜀被无懈可击抵消后是弃掉(和闪电不同)', async () => {
  const { game, agents } = mkGame({ 0: '陆逊', 1: '吕布', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  const lucky = give(game, a, '乐不思蜀', '♠', 6);
  await game.useCard(game.makeUse(realCard(lucky), a, [b]));
  assert.equal(b.judgeZone.length, 1);

  give(game, a, '无懈可击', '♦', 12);
  agents[0].respond = () => 0;
  agents[1].respond = () => -1;
  agents[2].respond = () => -1;

  await game.runPhase(b, 'judge');

  assert.equal(b.judgeZone.length, 0);
  assert.ok(game.discardPile.includes(lucky), '乐不思蜀被无懈后应进弃牌堆');
  assert.equal(b.mark('turn:skip:play'), 0, '被抵消了就不该跳过出牌阶段');
});

test('闪电判定失败也走同一条转移逻辑', async () => {
  const { game, agents } = mkGame({ 0: '陆逊', 1: '吕布', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  const bolt = give(game, a, '闪电', '♥', 12);
  await game.useCard(game.makeUse(realCard(bolt), a, [a]));
  for (const ag of agents) ag.respond = () => -1;

  stackDeck(game, [['杀', '♥', 5]]);      // 非 ♠2-9,判定不生效
  await game.runPhase(a, 'judge');

  assert.equal(a.hp, a.maxHp);
  assert.ok(b.judgeZone.includes(bolt), '判定失败同样应转给下家');
});

test('闪电判定成功则造成 3 点雷伤并弃置', async () => {
  const { game, agents } = mkGame({ 0: '陆逊', 1: '吕布', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  a.maxHp = 5; a.hp = 5;          // 陆逊只有 3 血,吃 3 点雷会直接把这局打完
  const bolt = give(game, a, '闪电', '♥', 12);
  await game.useCard(game.makeUse(realCard(bolt), a, [a]));
  for (const ag of agents) ag.respond = () => -1;

  stackDeck(game, [['杀', '♠', 5]]);      // ♠5 落在 2~9,判定生效
  await game.runPhase(a, 'judge');

  assert.equal(a.hp, a.maxHp - 3, '应受到 3 点伤害');
  assert.ok(!b.judgeZone.includes(bolt), '生效后不该再传下去');
  assert.ok(game.discardPile.includes(bolt), '生效后应进弃牌堆');
});
