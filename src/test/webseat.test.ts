/**
 * 网页座位:把引擎的 `await 决策` 翻转成"浏览器提交"。
 *
 * 两件事要焊死:
 *  1. **题面能映射回实体。** 光有文字标签的话前端只能给一串按钮;有了 items
 *     才能做到"点角色框选目标、点手牌选牌"。
 *  2. **别人的题绝不能出现在我的快照里。** 选项本身就泄露手牌 ——
 *     "是否使用【闪】"这道题出现,就等于告诉看到它的人"这家伙有闪"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { WebAgent } from '../web/webAgent.js';
import { snapshot } from '../web/state.js';
import { give } from './helpers.js';
import { realCard } from '../core/types.js';
import type { Game } from '../core/game.js';

/** 开一局,0 号位是网页座位。返回 agent 和「跑到下一个待决策点」的 promise */
function start(seed = 2026) {
  let web!: WebAgent;
  let notified = 0;
  const game: Game = createGame({
    playerCount: 3, seed, log: () => {},
    makeAgent: (_p, i) => {
      if (i !== 0) return new BasicAI(`ai${i}`);
      web = new WebAgent('you', () => { notified++; });
      return web;
    },
  });
  const done = game.setupAndRun().catch(() => {});   // 引擎会卡在第一个网页决策上
  return { game, web: web!, done, hits: () => notified };
}

const settle = () => new Promise(r => setTimeout(r, 0));

/**
 * 把这次结算跑完:提交完自己关心的那一步之后,后面还可能冒出别的题
 * (五谷对其他目标结算时会问你要不要【无懈可击】—— 只要你手上真有一张)。
 * 不答就永远停在那里,整个测试文件跟着挂死。
 *
 * 这条是改牌表之后炸出来的:0 号位的起手牌变了、多了一张无懈,
 * 而测试只提交了一次答案。以前能过纯属那副牌里恰好没有无懈。
 */
async function finish(web: WebAgent, pr: Promise<unknown>) {
  let done = false;
  void pr.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 50 && !done; i++) {
    await settle();
    const p = web.pending;
    if (p) web.submit(Array.from({ length: p.min }, (_, j) => j));   // 能放弃就放弃
  }
  await pr;
}

/** 开一局,0 号位是网页座位,引擎不自动跑 —— 由测试自己驱动到想要的那一步 */
async function stage(generals: Record<number, string>) {
  let web!: WebAgent;
  const game = createGame({
    playerCount: 3, seed: 4, fixedGenerals: generals, log: () => {},
    makeAgent: (_p, i) => {
      if (i !== 0) return new BasicAI(`ai${i}`);
      web = new WebAgent('you', () => {});
      return web;
    },
  });
  game.current = game.players[0];
  return { game, me: game.players[0], web: web! };
}

test('轮到网页座位时挂起,题面和选项都拿得到', async () => {
  const { web, hits } = start();
  await settle();
  assert.ok(web.pending, '应该卡在一个待决策点上');
  assert.ok(hits() > 0, 'onPending 要被叫到,否则前端不知道该重画');
  assert.equal(web.pending!.min, 1);
  assert.equal(web.pending!.max, 1);
  assert.ok(web.pending!.options.length > 1);
  assert.equal(web.pending!.items.length, web.pending!.options.length,
    '每个选项都要有对应的实体信息');
});

test('出牌阶段的选项能映射回具体的牌和技能', async () => {
  const { game, web } = start();
  await settle();
  const p = web.pending!;
  const myIds = new Set(game.players[0].hand.map(c => c.id));

  const cards = p.items.filter(it => it.kind === 'card');
  assert.ok(cards.length > 0, '出牌阶段应该有牌可出');
  for (const it of cards) {
    assert.ok(it.kind === 'card' && it.ids.every(id => myIds.has(id)),
      '牌选项指向的必须是我自己手里的牌');
  }
  assert.ok(p.items.some(it => it.kind === 'end'), '"结束出牌阶段"要能被认出来');
});

test('提交后引擎继续跑,下一题接上', async () => {
  const { web } = start();
  await settle();
  const first = web.pending!.question;
  assert.equal(web.submit([0]), null, '合法提交应该被收下');
  await settle();
  assert.ok(web.pending, '引擎应该跑到了下一个决策点');
  assert.notEqual(web.pending!.question, first);
});

test('非法提交被挡回,题目还在原地', async () => {
  const { web } = start();
  await settle();
  const n = web.pending!.options.length;
  assert.match(web.submit([n + 5]) ?? '', /编号/);
  assert.match(web.submit([]) ?? '', /至少|个/);
  assert.ok(web.pending, '挡回之后题目不能丢');
  assert.equal(web.submit([0]), null);
});

test('没轮到你的时候提交会被拒', async () => {
  const { web } = start();
  await settle();
  web.submit([0]);
  assert.match(web.submit([0]) ?? '', /没有轮到你/);
});

// ————————————————— 别人的题不能进我的快照 —————————————————

test('纯观战没有"自己",也就不该有任何待决策题面', async () => {
  const { game, web } = start();
  await settle();
  const s = snapshot(game, { viewer: null, pending: web.pending });
  assert.equal(s.pending, null, '观战视角必须看不到任何人的选项');
});

test('题面只在传进来时出现 —— 调用方负责确认归属', async () => {
  const { game, web } = start();
  await settle();
  // 调用方判断这题属于 0 号位,才把它传进来
  assert.ok(snapshot(game, { viewer: 0, pending: web.pending }).pending);
  // 不传就没有 —— 1 号位的视角拿不到 0 号位的题
  assert.equal(snapshot(game, { viewer: 1 }).pending, null);
});

test('快照里不会夹带别人的手牌(网页座位没改变这条)', async () => {
  const { game, web } = start();
  await settle();
  const s = snapshot(game, { viewer: 0, pending: web.pending });
  assert.ok(s.seats[0].hand, '自己的手牌看得见');
  assert.equal(s.seats[1].hand, null, '别人的手牌仍然是盖着的');
  assert.equal(s.seats[2].hand, null);
});

// ————————————————— items 串味(真实卡死事故) —————————————————

test('上一题被短路后,下一题的选项不会跟着丢', async () => {
  /*
   * 真实事故:周瑜发动【反间】问我选花色,网页上一个按钮都没有,牌局卡死。
   *
   * 链路是这样的:WebAgent.chooseResponse 先把 nextItems 设成 [](手上没无懈,
   * 空选项),父类 ChoiceAgent 看到空选项直接 return -1 —— decide() 根本没被调用,
   * nextItems 就留在了实例上。轮到 chooseSuit 时 `nextItems ?? …` 拿到的是 []
   * (不是 null,?? 不生效),于是 items 是空数组,前端按它枚举 → 零个按钮。
   */
  const { game, web } = start();
  await settle();
  web.submit([web.pending!.options.length - 1]);   // 结束出牌阶段
  await settle();

  // 手上没有无懈:引擎为了不泄露手牌照样会问一次,agent 立刻答 -1
  await web.chooseResponse(game, game.players[0], [], '是否使用【无懈可击】?', false, {});
  // 紧接着来一道真题
  const suit = web.chooseSuit(game, game.players[0], '反间:请选择一种花色');
  await settle();

  const p = web.pending!;
  assert.ok(p, '必须挂起等你选');
  assert.equal(p.options.length, 4, '四种花色');
  assert.equal(p.items.length, p.options.length,
    'items 必须和 options 一一对应 —— 对不上前端就渲染不出选项');
  assert.ok(p.items.every(it => it.kind === 'plain'), '花色不对应界面上的实体,应该是 plain');
  web.submit([0]);
  assert.ok(await suit);
});

// ————————————————— 中止 / 重开 —————————————————

test('中止会把挂起的决策兑现掉,而不是让引擎永远停在那', async () => {
  const { web, done } = start();
  await settle();
  assert.ok(web.pending, '先卡在一个决策上');

  web.abort();
  assert.equal(web.pending, null, '题面要清掉,否则界面还显示着一局已经不存在的牌');
  // done 是 setupAndRun().catch(...),中止后它必须能走完 —— 卡住就意味着整局泄漏
  await done;
  assert.match(web.submit([0]) ?? '', /中止/, '中止之后再提交要被拒');
});

test('中止之后不会再接新题', async () => {
  const { game, web } = start();
  await settle();
  web.abort();
  await assert.rejects(
    () => web.chooseSuit(game, game.players[0], '反间:请选择一种花色'),
    (e: Error) => e.name === 'GameAborted',
  );
});

// ————————————————— 中央牌堆 —————————————————

/**
 * 候选**本身是牌**、而且**不在自己手上**时,界面把它们摊在中央给你看。
 * 判据就是 items 里的 card 类型 + 卡牌 id 在不在自己手里 —— 这两条锁住,
 * 前端那段渲染逻辑就有依据。
 */
test('五谷的候选是"牌",不是一排文字按钮', async () => {
  const { game, me, web } = await stage({ 0: '孙权', 1: '吕蒙', 2: '甘宁' });
  const c = give(game, me, '五谷丰登', '♥', 3);
  const pr = game.useCard(game.makeUse(realCard(c), me, (await game.selectTargets(me, realCard(c)))!));
  await settle();

  const p = web.pending!;
  assert.match(p.question, /五谷丰登/);
  assert.ok(p.options.length >= 2);
  assert.ok(p.items.every(it => it.kind === 'card'),
    '候选必须是牌类型,否则界面只能画成文字按钮:' + JSON.stringify(p.items));

  const mine = new Set(me.hand.map(x => x.id));
  assert.ok(p.items.every(it => it.kind === 'card' && !it.ids.some(id => mine.has(id))),
    '五谷的候选来自牌堆,不该和自己手牌重合 —— 重合了就会被误判成"在手牌里点"');
  web.submit([0]);
  await finish(web, pr);
});

test('弃牌选的是自己的手牌 —— 那些在手牌行里点,不进中央牌堆', async () => {
  const { game, me, web } = await stage({ 0: '孙权', 1: '吕蒙', 2: '甘宁' });
  give(game, me, '杀', '♠', 9);
  give(game, me, '桃', '♥', 8);
  me.hp = 1;                                   // 手牌上限 1,必须弃
  const pr = game.runPhase(me, 'discard');
  await settle();

  const p = web.pending!;
  assert.match(p.question, /弃/);
  const mine = new Set(me.hand.map(x => x.id));
  assert.ok(p.items.every(it => it.kind === 'card' && it.ids.every(id => mine.has(id))),
    '弃牌的候选全是自己的手牌');
  // 弃牌是 min=max=N,少交一个会被校验挡回、promise 永远不兑现(这里挂过一次)
  assert.equal(web.submit(Array.from({ length: p.min }, (_, i) => i)), null);
  await finish(web, pr);
});
