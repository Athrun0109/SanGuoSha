/**
 * 多素材转化(丈八蛇矛把任意两张手牌当【杀】)。
 *
 * 引擎给的是**枚举好的组合**:4 张手牌就是 C(4,2)=6 个选项。这没问题 ——
 * 问题在于以前这 6 个选项的标签**一模一样**,全是"杀(丈八蛇矛)":
 *
 *   - 人在界面上看到 6 个相同的按钮,不知道点哪个;
 *   - **模型更惨,它只能盲选** —— 可能把桃和闪拆掉,留下两张废牌。
 *
 * 所以标签必须写清用了哪几张素材。界面那边再靠 items.via 把它收成
 * "先点武器、再点素材"两步,但那是展示层的事,不影响引擎给的选项集合。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { mkGame, give, buildDeck } from './helpers.js';
import { realCard, vcLabel } from '../core/types.js';
import { WebAgent } from '../web/webAgent.js';

/** 装上丈八蛇矛 + 4 张手牌 */
async function armed() {
  const { game } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '甘宁' }, 3);
  const me = game.players[0];
  const spear = give(game, me, '丈八蛇矛', '♠', 12);
  await game.useCard(game.makeUse(realCard(spear), me, [me]));  // 走正常装备流程,技能才挂得上
  give(game, me, '杀', '♦', 11);
  give(game, me, '桃', '♥', 8);
  give(game, me, '借刀杀人', '♣', 12);
  give(game, me, '闪', '♦', 9);
  const pat = { names: ['杀'] };
  const opts = game.enumerateResponses(me, pat, { mode: 'respond', pattern: pat, purpose: 'slash' });
  return { game, me, opts };
}

test('多素材组合的标签必须能分辨,不能全叫"杀(丈八蛇矛)"', async () => {
  const { opts } = await armed();
  const combos = opts.filter(o => o.card.cards.length > 1);
  assert.equal(combos.length, 6, '4 张手牌两两组合 = 6 种');

  const labels = new Set(combos.map(o => o.label));
  assert.equal(labels.size, 6, `6 个组合要有 6 个不同的标签,实际只有 ${labels.size} 种`);
  for (const o of combos) {
    for (const c of o.card.cards) {
      assert.ok(o.label.includes(c.name), `标签里要写清素材,缺了 ${c.name}:${o.label}`);
    }
  }
  assert.ok(labels.has('杀(丈八蛇矛:桃[♥8]+闪[♦9])'), [...labels].join(' / '));
});

test('单张转化不受影响 —— 花色点数本来就在标签里', () => {
  const { game } = mkGame({ 0: '关羽', 1: '孙权', 2: '甘宁' }, 3);
  const me = game.players[0];
  const red = give(game, me, '桃', '♥', 13);
  const pat = { names: ['杀'] };
  const opts = game.enumerateResponses(me, pat, { mode: 'respond', pattern: pat, purpose: 'slash' });
  const wusheng = opts.find(o => o.card.skill === '武圣');
  assert.ok(wusheng, '关羽应该能把红桃当杀');
  assert.match(wusheng!.label, /♥/, '单张转化的标签里本来就有花色点数');
  assert.ok(!wusheng!.label.includes('+'), '单张不该拼素材列表');
  void red;
});

test('真牌不带后缀', () => {
  const { game } = mkGame({ 0: '孙权', 1: '关羽', 2: '甘宁' }, 3);
  const c = give(game, game.players[0], '杀', '♦', 11);
  assert.equal(vcLabel(realCard(c)), '杀[♦J]');
});

test('组合选项带 via,界面才能收成"先点武器再点牌"', async () => {
  const { game, me, opts } = await armed();
  const web = new WebAgent('you', () => {});
  game.agents.set(me, web);
  const pr = web.chooseResponse(game, me, opts, '决斗:请打出【杀】', false, { purpose: 'slash' });
  await new Promise(r => setTimeout(r, 0));

  const p = web.pending!;
  assert.equal(p.items.length, p.options.length);
  const combos = p.items.filter(it => it.kind === 'card' && it.ids.length > 1);
  assert.equal(combos.length, 6);
  for (const it of combos) {
    assert.equal(it.kind === 'card' && it.via, '丈八蛇矛', 'via 要指明是哪件装备转化的');
  }
  // 真牌那个选项没有 via,界面上直接点手牌就行
  const plain = p.items.find(it => it.kind === 'card' && it.ids.length === 1);
  assert.equal(plain && plain.kind === 'card' && plain.via, undefined);

  web.submit([0]);
  await pr;
});

// ————————————————— 单张转化也要说清素材 —————————————————

test('倾国:黑牌当闪,标签要写清那张黑牌是什么', () => {
  /*
   * 真实困惑:日志里出现"闪[♣4](倾国)",看着像"一张♣4的闪"——
   * 可闪全是红色的,根本不存在♣4的闪;而且它和场上刚打出的 杀[♣4] 撞了花色点数
   * (牌堆里 ♣4 有两张:杀 和 过河拆桥),看起来就像同一张牌被用了两次。
   * 引擎是对的,错的是标签没说素材是哪张牌。
   */
  const { game } = mkGame({ 0: '诸葛亮', 1: '甄姬', 2: '甘宁' }, 3);
  const zhen = game.players[1];
  give(game, zhen, '过河拆桥', '♣', 4);
  const pat = { names: ['闪'] };
  const opts = game.enumerateResponses(zhen, pat, { mode: 'respond', pattern: pat, purpose: 'dodge' });

  const qg = opts.find(o => o.card.skill === '倾国');
  assert.ok(qg, '甄姬应该能把黑牌当闪');
  assert.equal(qg!.label, '闪[♣4](倾国:过河拆桥)');
  assert.ok(qg!.label.includes('过河拆桥'), '素材是哪张牌必须写出来');
});

test('牌堆里花色点数会撞 —— ♣4 有两张,不是同一张牌被用了两次', () => {
  const deck = buildDeck();
  const c4 = deck.filter(c => c.suit === '♣' && c.rank === 4);
  assert.equal(c4.length, 2, `♣4 应该有两张,实际 ${c4.length} 张`);
  assert.deepEqual(c4.map(c => c.name).sort(), ['杀', '过河拆桥']);
  assert.equal(new Set(c4.map(c => c.id)).size, 2, '两张牌的 id 必须不同');

  // 闪全是红色 —— 所以"♣4 的闪"只可能是转化技的产物
  assert.ok(deck.filter(c => c.name === '闪').every(c => c.suit === '♥' || c.suit === '♦'),
    '闪不该有黑色的');
});
