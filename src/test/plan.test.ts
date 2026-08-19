/**
 * 计划执行器:模型一次写好接下来几步,本地按计划兑现,不再逐步发请求。
 *
 * 这里锁的都是**安全性质**,不是省了多少 —— 省多少要看真实对局。
 * 计划这条路唯一能接受的失败方式是"白写了一份计划",绝不能是"做了模型没打算做的事"。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo, type LLMClient } from '../ai/llmAgent.js';
import { PlanRunner } from '../ai/plan.js';
import { give } from './helpers.js';

const PLAY = '出牌阶段,选一个动作';

function mk() {
  const game = createGame({
    playerCount: 3, seed: 9, log: () => {},
    makeAgent: (_p, i) => new BasicAI(`ai${i}`),
  });
  return { game, me: game.players[0] };
}

// ————————————————— 执行器本身 —————————————————

test('计划里的动作按顺序兑现,目标和区域也一并填上', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [
    { act: '青釭剑[♠6]', target: -1, zone: '' },        // 第一步已由 choice 执行,会被丢掉
    { act: '过河拆桥[♣3]', target: 1, zone: '装备区 进攻马[♦K]' },
    { act: '杀[♣10]', target: 1, zone: '' },
  ]);
  assert.equal(r.pending, 2, '第一步是模型这次已经选的动作,不该重复执行');

  // 下一个出牌动作
  assert.deepEqual(
    r.answer(game, me, PLAY, ['出 杀[♣10]', '出 过河拆桥[♣3]', '结束出牌阶段'], 1, 1), [1]);
  // 紧接着的目标问题
  assert.deepEqual(
    r.answer(game, me, '过河拆桥:选择目标', ['P1(甄姬) hp3/3 手牌2', 'P2(甘宁) hp4/4 手牌3'], 1, 1), [0]);
  // 再紧接着的区域问题
  assert.deepEqual(
    r.answer(game, me, '过河拆桥:弃置一张牌', ['手牌(2张,随机一张)', '装备区 进攻马[♦K]'], 1, 1), [1]);
  // 然后是计划的最后一步
  assert.deepEqual(r.answer(game, me, PLAY, ['出 杀[♣10]', '结束出牌阶段'], 1, 1), [0]);
  assert.equal(r.used, 4);
});

test('摸到新牌就作废 —— 新牌会改变计划的前提', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);

  give(game, me, '桃', '♥', 5);            // 模拟集智/连营/枭姬那类"打着打着就摸牌"
  let why = '';
  assert.equal(r.answer(game, me, PLAY, ['出 杀[♣10]', '结束出牌阶段'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '摸到新牌');
  assert.equal(r.pending, 0, '整份计划都要丢掉');
});

test('对不上选项就整份作废,绝不猜一个"差不多"的', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);

  let why = '';
  // 那张杀已经不在手上了(被拆了/被顺了)
  assert.equal(r.answer(game, me, PLAY, ['出 桃[♥5]', '结束出牌阶段'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '对不上选项');
  assert.equal(r.pending, 0);
});

test('命中多个也算对不上 —— 宁可作废也不挑第一个', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  // 只写"杀",而场上有两张不同的杀
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀', target: 1, zone: '' }]);
  let why = '';
  assert.equal(
    r.answer(game, me, PLAY, ['出 杀[♣10]', '出 杀[♠3]', '结束出牌阶段'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '对不上选项');
});

test('换了回合就作废,不把上一回合的计划带过来', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);
  game.turnCount += 1;
  let why = '';
  assert.equal(r.answer(game, me, PLAY, ['出 杀[♣10]', '结束出牌阶段'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '换了回合');
});

test('冒出一道计划管不着的题 → 整份作废,不闭眼走完', () => {
  /*
   * 判据是「计划没预料到的事发生了」。刚烈让你选掉血还是弃牌、拆桥被无懈后要不要
   * 反无懈、决斗要你接杀 —— 这些一出现就说明局面偏离了计划,后面几步的前提可能
   * 已经不成立,必须把新局势交回模型重新规划。
   */
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);
  let why = '';
  assert.equal(
    r.answer(game, me, '0号位·刘备 对你使用【杀】,请打出【闪】', ['闪[♦6]'], 0, 1, w => { why = w; }),
    null, '响应类决策必须回到模型手里');
  assert.equal(why, '出了计划外的状况');
  assert.equal(r.pending, 0, '剩余步骤也要丢掉 —— 前提已经变了');
});

test('区域按语义认,不要求照抄 —— 写计划时那些选项还不存在', () => {
  /*
   * 真实事故:模型写了 zone:"手牌区",而选项是「手牌(4张,随机一张)」,对不上。
   * 但这不能怪它 —— 写计划的时候区域选项根本还没生成,它没见过那行字。
   * 区域只有三种,是封闭集合,按关键词认类别才是对的。
   */
  const zones = ['手牌(4张,随机一张)', '装备区 仁王盾[♣2]', '判定区 乐不思蜀[♠6]'];
  for (const [zone, want] of [
    ['手牌区', 0], ['手牌', 0], ['装备区', 1], ['装备区 仁王盾', 1], ['判定区', 2],
  ] as const) {
    const { game, me } = mk();
    const r = new PlanRunner();
    r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '过河拆桥[♣3]', target: 1, zone }]);
    r.answer(game, me, PLAY, ['出 过河拆桥[♣3]', '结束'], 1, 1);
    assert.deepEqual(r.answer(game, me, '拆:弃置一张牌', zones, 1, 1), [want], `zone=${zone}`);
  }
});

test('同一区域有多张时靠牌名区分,认不出就交回模型', () => {
  const zones = ['装备区 进攻马[♦K]', '装备区 防御马[♣5]'];
  const pick = (zone: string) => {
    const { game, me } = mk();
    const r = new PlanRunner();
    r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '过河拆桥[♣3]', target: 1, zone }]);
    r.answer(game, me, PLAY, ['出 过河拆桥[♣3]', '结束'], 1, 1);
    return r.answer(game, me, '拆:弃置一张牌', zones, 1, 1);
  };
  assert.deepEqual(pick('装备区 防御马'), [1], '写了牌名就该认出来');
  assert.equal(pick('装备区'), null, '两匹马都在装备区,没写牌名就别猜');
});

test('计划里的牌被无懈抵消 → 后面的步骤要重新规划', () => {
  // "拆掉仁王盾再用黑杀":拆桥被无懈之后,那张杀的价值就变了
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);
  game.nullified++;
  let why = '';
  assert.equal(r.answer(game, me, PLAY, ['出 杀[♣10]', '结束'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '牌被无懈可击抵消');
});

test('中途掉血也要重新规划', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♣10]', target: 1, zone: '' }]);
  me.hp -= 1;                       // 决斗输了 / 闪电劈了
  let why = '';
  assert.equal(r.answer(game, me, PLAY, ['出 杀[♣10]', '结束'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '中途掉血');
});

// ————————————————— 接到 LLMAgent 上 —————————————————

/** 第一次调用返回带计划的答案,之后任何调用都算失败(证明没再发请求) */
function planningClient(plan: unknown, firstChoice = 0) {
  let calls = 0;
  const client: LLMClient = {
    messages: {
      async create() {
        calls++;
        if (calls > 1) throw new Error('不该再发请求');
        return {
          content: [{ type: 'text', text: JSON.stringify({ thinking: '连打', choice: [firstChoice], plan }) }],
          usage: {},
        };
      },
    },
  };
  return { client, calls: () => calls };
}

test('模型给了计划之后,后续几步一个请求都不发', async () => {
  const infos: DecisionInfo[] = [];
  let agent!: LLMAgent;
  const { client, calls } = planningClient([
    { act: '青釭剑[♠6]', target: -1, zone: '' },
    { act: '杀[♣10]', target: 1, zone: '' },
  ]);
  const game = createGame({
    playerCount: 3, seed: 9, log: () => {},
    makeAgent: (_p, i) => {
      if (i !== 0) return new BasicAI(`ai${i}`);
      agent = new LLMAgent('llm', { client, onDecision: d => infos.push(d) });
      return agent;
    },
  });
  const me = game.players[0];

  const first = await agent.chooseOption(game, me, ['出 青釭剑[♠6]', '出 杀[♣10]', '结束出牌阶段'], PLAY);
  assert.equal(first, 0);
  assert.equal(calls(), 1);

  // 第二步:计划里写了,不该再发请求
  const second = await agent.chooseOption(game, me, ['出 杀[♣10]', '结束出牌阶段'], PLAY);
  assert.equal(second, 0, '应该从计划里取到那张杀');
  assert.equal(calls(), 1, '一个请求都不该多发');
  assert.equal(agent.stats.planned, 1);

  const planned = infos.filter(d => d.fromPlan);
  assert.equal(planned.length, 1, '按计划走的那一步也要进日志,否则省了多少无从统计');
  assert.equal(planned[0].payloadChars, 0);
});

test('计划为空时行为和以前完全一样', async () => {
  let agent!: LLMAgent;
  const { client, calls } = planningClient([]);
  const game = createGame({
    playerCount: 3, seed: 9, log: () => {},
    makeAgent: (_p, i) => {
      if (i !== 0) return new BasicAI(`ai${i}`);
      agent = new LLMAgent('llm', { client });
      return agent;
    },
  });
  await agent.chooseOption(game, game.players[0], ['甲', '乙'], PLAY);
  assert.equal(calls(), 1);
  assert.equal(agent.stats.planned, 0);
});

test('标签完全相同的重复牌不算歧义 —— 取第一个就行', () => {
  /*
   * 牌堆里真的有同名同花色同点数的重复牌(杀♥J 两张、闪♥2 两张…)。
   * 实测吃过亏:模型规划「杀[♥J] → 杀[♥J]」,选项里正好躺着两张,
   * 被判成歧义、整份计划作废,白多问了两次。它们互相可替代,取哪个都一样。
   */
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀[♥J]', target: 1, zone: '' }]);
  assert.deepEqual(
    r.answer(game, me, PLAY, ['出 杀[♥J]', '出 杀[♥J]', '结束出牌阶段'], 1, 1), [0]);
});

test('但标签不同的多重命中仍然算歧义', () => {
  const { game, me } = mk();
  const r = new PlanRunner();
  r.adopt(game, me, [{ act: 'A', target: -1, zone: '' }, { act: '杀', target: 1, zone: '' }]);
  let why = '';
  assert.equal(
    r.answer(game, me, PLAY, ['出 杀[♥J]', '出 杀[♠3]', '结束'], 1, 1, w => { why = w; }), null);
  assert.equal(why, '对不上选项');
});
