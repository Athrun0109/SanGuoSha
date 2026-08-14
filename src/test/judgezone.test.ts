/**
 * 判定区里放的是**实体牌**,不是 flag。
 *
 * 这点容易写错成"给目标打个标记,牌直接进弃牌堆"。一旦那样写,大乔用 ♦【闪】
 * 当【乐不思蜀】甩出去之后,别人拿【顺手牵羊】去顺判定区就会拿到一张不存在的牌
 * (或者干脆拿不到)。正确行为是:判定区躺着那张 ♦闪,顺走的就是它。
 *
 * 另外判定区是**明置**的 —— "算什么"和"实际是什么"都是公开信息。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { mkGame, give, stackDeck } from './helpers.js';
import { realCard, cardLabel } from '../core/types.js';
import type { ViewAsSkill } from '../core/skill.js';

/** 大乔用一张 ♦牌当乐不思蜀丢给 target */
async function guose(game: any, daqiao: any, target: any, suit = '♦', rank = 6, name = '闪') {
  const card = give(game, daqiao, name, suit as any, rank);
  const sk = daqiao.allSkills.find((s: any) => s.name === '国色') as ViewAsSkill;
  const vc = sk.viewAs(game, daqiao, [card], { mode: 'play' })!;
  await game.useCard(game.makeUse(vc, daqiao, [target]));
  return card;
}

const G = { 0: '大乔', 1: '孙权', 2: '甘宁' };

test('国色放进判定区的是实体牌,不是凭空的乐不思蜀', async () => {
  const { game } = mkGame(G, 3);
  const [daqiao, b] = game.players;
  game.current = daqiao;
  const card = await guose(game, daqiao, b);

  assert.deepEqual(b.judgeZone, [card], '判定区里躺着的就是那张实体牌');
  assert.equal(cardLabel(b.judgeZone[0]), '闪[♦6]');
  assert.equal(game.judgeName(b, card), '乐不思蜀', '但它算作乐不思蜀');
});

test('顺手牵羊顺判定区,拿到的是那张实体牌', async () => {
  const { game, agents } = mkGame(G, 3);
  const [daqiao, b, c] = game.players;
  game.current = daqiao;
  const card = await guose(game, daqiao, b);

  let seen: string[] = [];
  agents[2].option = (opts: string[]) => {
    seen = opts;
    return opts.findIndex(o => o.includes('判定区'));
  };
  const shun = give(game, c, '顺手牵羊', '♠', 4);
  await game.useCard(game.makeUse(realCard(shun), c, [b]));

  assert.ok(c.hand.includes(card), '拿到的必须是那张 ♦闪');
  assert.equal(b.judgeZone.length, 0);
  assert.ok(seen.some(o => o.includes('乐不思蜀') && o.includes('闪[♦6]')),
    `判定区明置,选项里要同时说清"算什么"和"是什么",实际是:${seen.join(' | ')}`);
});

test('牌离开判定区时,"它算什么"这条记录要跟着清掉', async () => {
  const { game } = mkGame(G, 3);
  const [daqiao, b] = game.players;
  game.current = daqiao;
  const card = await guose(game, daqiao, b);
  assert.equal(b.judgeAs[card.id], '乐不思蜀');

  await game.moveCards([card], null, 'discard', '测试');
  assert.equal(b.judgeAs[card.id], undefined,
    '留着不会立刻出错,但那是颗雷 —— 换了主人换了身份还挂着上一任的记录');
});

test('判定结算之后,那张 ♦闪 进弃牌堆(而不是变成一张乐不思蜀)', async () => {
  const { game } = mkGame(G, 3);
  const [daqiao, b] = game.players;
  game.current = daqiao;
  const card = await guose(game, daqiao, b);

  stackDeck(game, [['杀', '♣', 5]]);          // 非♥ → 生效
  await game.runPhase(b, 'judge');
  assert.equal(b.mark('turn:skip:play'), 1, '乐不思蜀应该生效');
  assert.ok(game.discardPile.includes(card), '进弃牌堆的是那张实体 ♦闪');
  assert.equal(b.judgeAs[card.id], undefined);
});

test('真的乐不思蜀不会被写成"乐不思蜀(乐不思蜀[♠6])"', async () => {
  const { game } = mkGame({ 0: '孙权', 1: '吕蒙', 2: '甘宁' }, 3);
  const [a, b] = game.players;
  game.current = a;
  const lucky = give(game, a, '乐不思蜀', '♠', 6);
  await game.useCard(game.makeUse(realCard(lucky), a, [b]));
  assert.equal(game.judgeLabel(b, lucky), '乐不思蜀[♠6]', '名字一样时不该套娃');
});
