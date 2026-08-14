/**
 * 谁会被问、按什么顺序问。
 *
 * 两条规则(和官方略有出入,是刻意的):
 *
 *  1. **跳过刚出牌的那个人。** 锦囊的使用者不问他自己要不要无懈;把人打到濒死的
 *     那个人不问他要不要救。官方规则里这两个询问是存在的(自己无懈自己配合黄月英
 *     刷牌之类),但那是极边缘的操作,而在这个项目里每个询问都等于一次 LLM 调用、
 *     一份延迟、一次兜底风险。不值。
 *
 *  2. **没牌也要问。** 手上没有【闪】/【桃】/【无懈】的人照样被问一次。
 *     直接跳过的话,旁观者从"这一步没停顿"就能推出他没牌 —— 白送的情报。
 *     agent 看到空选项会立刻返回 -1,所以不花 token。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { mkGame, give, stackDeck } from './helpers.js';
import { realCard } from '../core/types.js';
import type { CardOption, ResponseCtx } from '../core/agent.js';

interface Ask { seat: number; purpose: string; n: number }

/**
 * 开一局,所有人一律不响应,并记下每个座位被问到的响应类决策。
 * 顺序很重要:先定行为,再包监听,否则监听会被后设的行为覆盖掉。
 */
function table(generals: Record<number, string>, n = 3) {
  const { game, agents } = mkGame(generals, n);
  game.current = game.players[0];
  const asks: Ask[] = [];
  agents.forEach((a, seat) => {
    a.respond = (opts: CardOption[], _p: string, ctx?: ResponseCtx) => {
      asks.push({ seat, purpose: ctx?.purpose ?? '?', n: opts.length });
      return -1;                                   // 谁都不出
    };
  });
  return { game, asks };
}

const G = { 0: '孙权', 1: '吕蒙', 2: '甘宁' };

test('无懈:不问锦囊使用者本人,其余人都问一遍(没牌也问)', async () => {
  const { game, asks } = table(G);
  const [a, , c] = game.players;

  const x = give(game, a, '顺手牵羊', '♠', 4);   // 即时锦囊;延时的窗口在判定阶段,见下面
  await game.useCard(game.makeUse(realCard(x), a, [c]));

  const nullify = asks.filter(x => x.purpose === 'nullify');
  assert.ok(nullify.length > 0, '应该问过无懈');
  assert.ok(!nullify.some(x => x.seat === 0), '使用者(0号位)不该被问自己的锦囊');
  assert.deepEqual([...new Set(nullify.map(x => x.seat))].sort(), [1, 2], '其余两人都要问到');
  assert.ok(nullify.every(x => x.n === 0),
    '他们手上都没有无懈,但仍然被问了 —— 这正是防泄露的点');
});

test('无懈链:刚打出无懈的人不会被问"要不要再无懈自己"', async () => {
  const { game, agents } = mkGame(G, 3);
  game.current = game.players[0];
  const [a, b, c] = game.players;
  give(game, b, '无懈可击', '♠', 11);
  give(game, b, '无懈可击', '♣', 12);   // 手上有两张,能连着刷

  const asks: Ask[] = [];
  agents.forEach((ag, seat) => {
    ag.respond = (opts: CardOption[], _p: string, ctx?: ResponseCtx) => {
      asks.push({ seat, purpose: ctx?.purpose ?? '?', n: opts.length });
      return opts.length ? 0 : -1;      // 有就出
    };
  });

  const x = give(game, a, '顺手牵羊', '♠', 4);
  await game.useCard(game.makeUse(realCard(x), a, [c]));

  // 1 号位打出第一张无懈之后,不该马上又被问第二张
  const seq = asks.filter(x => x.purpose === 'nullify').map(x => x.seat);
  for (let i = 1; i < seq.length; i++) {
    assert.notEqual(seq[i], seq[i - 1], `连着问了同一个人两次:${seq.join(',')}`);
  }
  assert.equal(b.hand.filter(x => x.name === '无懈可击').length, 1,
    '第二张无懈不该被自己刷掉');
});

test('濒死:跳过打出这一下的人,濒死者自己一定问得到', async () => {
  const { game, asks } = table(G);
  const [a, , c] = game.players;
  c.hp = 1;

  const slash = give(game, a, '杀', '♠', 7);
  await game.useCard(game.makeUse(realCard(slash), a, [c]));

  const peach = asks.filter(x => x.purpose === 'peach');
  assert.ok(peach.length > 0, '应该问过桃');
  assert.ok(!peach.some(x => x.seat === 0), '0 号位把人砍濒死,不问他要不要救');
  assert.ok(peach.some(x => x.seat === 2), '濒死者自己必须被问到');
  assert.ok(peach.some(x => x.seat === 1), '其他人也要问');
});

test('自伤濒死时不跳过任何人 —— 伤害来源就是濒死者自己', async () => {
  const { game, asks } = table(G);
  const [a] = game.players;
  a.hp = 1;

  // 死的是主公,引擎会抛 GameOver 结束这一局 —— 这里只关心问了谁
  await game.damage({ from: a, to: a, amount: 1, reason: '自伤' } as any).catch(() => {});

  const peach = asks.filter(x => x.purpose === 'peach');
  assert.ok(peach.some(x => x.seat === 0),
    '濒死者自己不能因为"同时是伤害来源"就被跳过');
});

test('被杀时没有闪也会被问一次', async () => {
  const { game, asks } = table(G);
  const [a, b] = game.players;

  const slash = give(game, a, '杀', '♠', 7);
  await game.useCard(game.makeUse(realCard(slash), a, [b]));

  const dodge = asks.filter(x => x.purpose === 'dodge' && x.seat === 1);
  assert.equal(dodge.length, 1, '1 号位手上没闪,但还是要被问到');
  assert.equal(dodge[0].n, 0, '选项是空的 —— agent 直接答不出,不花 token');
});

// ————————————————— 多目标锦囊的无懈窗口 —————————————————

test('多目标锦囊:使用者要被问,他可能想无懈掉别人那一份', async () => {
  // 真实 bug:A 打五谷丰登,轮到 B 选牌时应该问 A 要不要无懈掉 B 的机会。
  // 之前"跳过出牌的人"写成了无条件跳过,把这类玩法整个删掉了。
  const { game, asks } = table(G);
  const [a] = game.players;
  const wugu = give(game, a, '五谷丰登', '♥', 3);
  const targets = await game.selectTargets(a, realCard(wugu));
  await game.useCard(game.makeUse(realCard(wugu), a, targets!));

  const nullify = asks.filter(x => x.purpose === 'nullify');
  assert.ok(nullify.some(x => x.seat === 0),
    '使用者必须被问到 —— 无懈掉对手的选牌机会是正常打法');
  assert.ok(nullify.some(x => x.seat === 1) && nullify.some(x => x.seat === 2),
    '其他人当然也要问');
});

test('单目标锦囊仍然跳过使用者', async () => {
  const { game, asks } = table(G);
  const [a, , c] = game.players;
  const x = give(game, a, '顺手牵羊', '♠', 4);
  await game.useCard(game.makeUse(realCard(x), a, [c]));

  const nullify = asks.filter(x => x.purpose === 'nullify');
  assert.ok(nullify.length > 0);
  assert.ok(!nullify.some(x => x.seat === 0),
    '问他要不要无懈自己刚指向别人的牌,几乎永远是浪费');
});

// ————————————————— 延时锦囊的无懈窗口在判定阶段 —————————————————

test('乐不思蜀:使用时不问无懈,判定阶段才问', async () => {
  const { game, asks } = table(G);
  const [a, , c] = game.players;

  const lucky = give(game, a, '乐不思蜀', '♠', 6);
  await game.useCard(game.makeUse(realCard(lucky), a, [c]));
  assert.equal(asks.filter(x => x.purpose === 'nullify').length, 0,
    '置入判定区这个过程本身不可被无懈');
  assert.equal(c.judgeZone.length, 1, '牌应该已经进了判定区');

  asks.length = 0;
  stackDeck(game, [['杀', '♣', 5]]);
  await game.runPhase(c, 'judge');
  assert.ok(asks.filter(x => x.purpose === 'nullify').length > 0,
    '判定阶段、判定牌生效前才是无懈的窗口');
});

test('闪电同理 —— 放的时候不问', async () => {
  const { game, asks } = table(G);
  const [a] = game.players;
  const bolt = give(game, a, '闪电', '♠', 1);
  await game.useCard(game.makeUse(realCard(bolt), a, [a]));
  assert.equal(asks.filter(x => x.purpose === 'nullify').length, 0);
  assert.equal(a.judgeZone.length, 1);
});

test('普通锦囊不受影响,使用时照样开窗口', async () => {
  const { game, asks } = table(G);
  const [a, , c] = game.players;
  const x = give(game, a, '顺手牵羊', '♠', 4);
  await game.useCard(game.makeUse(realCard(x), a, [c]));
  assert.ok(asks.filter(x => x.purpose === 'nullify').length > 0);
});
