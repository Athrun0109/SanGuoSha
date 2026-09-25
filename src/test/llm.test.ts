/**
 * LLM 链路测试 —— 用假客户端跑,不需要 API key,也不花钱。
 * 覆盖:提示词组装、编号校验、异常兜底、代号化不泄漏原名、滚动战报、记牌器算术。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type LLMClient } from '../ai/llmAgent.js';
import { CARD_CODE, missingCodes } from '../ai/codec.js';
import { cardLabel } from '../core/types.js';
import { countCards, countGroup } from '../ai/cardCounter.js';
import { generals } from '../core/registry.js';
import { DECK_TABLE } from '../content/cards.js';

function mockClient(
  responder: (params: any, callIndex: number) => string | Error,
): LLMClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      async create(params: any) {
        const r = responder(params, calls.length);
        // messages 每次都是新数组,但 system 是共享引用,做个浅快照就够
        calls.push({ ...params, messages: [...params.messages] });
        if (r instanceof Error) throw r;
        return {
          content: [{ type: 'thinking', text: '' }, { type: 'text', text: r }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
        };
      },
    },
  } as any;
}

/** 解析新版紧凑题面:选项行是 `N:...`,数量要求是 `选1个` / `选0~5个` / `选2~3个` */
function naiveResponder(params: any): string {
  const last = params.messages[params.messages.length - 1].content as string;
  const optCount = (last.match(/^\d+:/gm) ?? []).length;
  let min = 1, max = 1, m: RegExpMatchArray | null;
  if ((m = last.match(/选0~(\d+)个/))) { min = 0; max = Number(m[1]); }
  else if ((m = last.match(/选(\d+)~(\d+)个/))) { min = Number(m[1]); max = Number(m[2]); }
  else if ((m = last.match(/选(\d+)个/))) { min = max = Number(m[1]); }
  const k = Math.min(min, optCount);
  return JSON.stringify({ thinking: '测试策略', choice: Array.from({ length: k }, (_, i) => i) });
}

function runGame(opts: { client: LLMClient; codec?: 'verbose' | 'anon'; seed?: number; players?: number }) {
  let agent!: LLMAgent;
  const game = createGame({
    playerCount: opts.players ?? 2,
    seed: opts.seed ?? 7,
    verbose: true,
    makeAgent: (p, i) => {
      if (i !== 0) return new BasicAI(`rule${i}`);
      agent = new LLMAgent('llm', { client: opts.client, codec: opts.codec });
      return agent;
    },
  });
  return { game, get agent() { return agent; } };
}

// ————————————————— 基本链路 —————————————————

test('假客户端能把一整局打完,且不触发兜底', async () => {
  const client = mockClient(naiveResponder);
  const h = runGame({ client });
  const res = await h.game.setupAndRun();
  assert.ok(res.reason);
  assert.ok(client.calls.length > 0, '模型应被调用');
  assert.equal(h.agent.stats.fallbacks, 0);
});

test('请求结构:system 两段 + 缓存断点 + 结构化输出 + 单条 user 消息', async () => {
  const client = mockClient(naiveResponder);
  await runGame({ client, seed: 11 }).game.setupAndRun();

  const p = client.calls[0];
  assert.equal(p.model, 'claude-opus-5');
  assert.equal(p.system.length, 2);
  assert.equal(p.system[1].cache_control.type, 'ephemeral');
  assert.equal(p.cache_control.type, 'ephemeral');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.messages.length, 1, '正常情况下每次决策只发一条 user 消息');

  const u = p.messages[0].content as string;
  for (const key of ['你的手牌', '记牌器', '问题']) {
    assert.ok(u.includes(key), `缺少 ${key} 段落`);
  }
});

test('规则块不再解释合法性,只讲后果', async () => {
  const client = mockClient(naiveResponder);
  await runGame({ client }).game.setupAndRun();
  const rules = client.calls[0].system[0].text as string;
  assert.ok(rules.includes('引擎已经过滤掉所有非法动作'));
  for (const legality of ['出牌阶段限一次', '距离1以内', '只能指定攻击范围内']) {
    assert.ok(!rules.includes(legality), `规则里不该再有合法性描述:${legality}`);
  }
});

test('非法编号会带着具体原因要求重答', async () => {
  let first = true;
  const client = mockClient((params) => {
    if (first) { first = false; return JSON.stringify({ thinking: '越界', choice: [999] }); }
    return naiveResponder(params);
  });
  await runGame({ client, seed: 13 }).game.setupAndRun();
  const retry = client.calls[1];
  assert.equal(retry.messages.length, 3, '重试应在同一条对话里追加纠错');
  assert.ok((retry.messages[2].content as string).includes('编号必须在'));
});

test('偶发抖动会被重试救回来,不该白丢一个决策', async () => {
  // 每 3 次失败一次:重试逻辑应该能兜住,不产生任何兜底
  const client = mockClient((params, idx) => (idx % 3 === 0 ? new Error('socket hang up') : naiveResponder(params)));
  const h = runGame({ client, seed: 17 });
  await h.game.setupAndRun();
  assert.equal(h.agent.stats.fallbacks, 0, '偶发失败应被重试消化掉');
});

test('接口持续异常时才回落到规则 AI,牌局继续', async () => {
  const client = mockClient(() => new Error('连接超时'));
  const h = runGame({ client, seed: 17 });
  const res = await h.game.setupAndRun();
  assert.ok(res.reason, '牌局仍然要能打完');
  assert.ok(h.agent.stats.fallbacks > 0, '持续失败才该兜底');
  assert.ok(client.calls.length >= h.agent.stats.fallbacks * 3, '每次兜底前应该重试满 3 次');
});

// ————————————————— 代号化 —————————————————

test('代号表覆盖牌堆里所有的牌', () => {
  assert.deepEqual(missingCodes(), [], '有牌没有代号,anon 模式会泄漏原名');
});

test('anon 模式下提示词里不出现任何武将名或牌名', async () => {
  const client = mockClient(naiveResponder);
  const h = runGame({ client, codec: 'anon', seed: 23, players: 5 });
  await h.game.setupAndRun();

  const all = client.calls
    .map(c => [...c.system.map((b: any) => b.text), ...c.messages.map((m: any) => m.content)].join('\n'))
    .join('\n');

  const leaks: string[] = [];
  for (const name of generals.keys()) if (all.includes(name)) leaks.push(`武将:${name}`);
  for (const name of Object.keys(CARD_CODE)) if (all.includes(name)) leaks.push(`卡牌:${name}`);
  assert.deepEqual(leaks, [], '这些原名泄漏到了 anon 提示词里');
});

test('verbose 模式保留原名', async () => {
  const client = mockClient(naiveResponder);
  const h = runGame({ client, codec: 'verbose', seed: 23, players: 5 });
  await h.game.setupAndRun();
  const all = client.calls.map(c => c.system[1].text).join('\n');
  const anyGeneral = [...generals.keys()].some(n => all.includes(n));
  assert.ok(anyGeneral, 'verbose 模式下身份块应出现武将名');
});

// ————————————————— 滚动战报 —————————————————

test('战报只回溯固定轮数,不随对局无限增长', async () => {
  const client = mockClient(naiveResponder);
  let agent!: LLMAgent;
  const game = createGame({
    playerCount: 5, seed: 31, verbose: true,
    makeAgent: (p, i) => {
      if (i !== 0) return new BasicAI(`r${i}`);
      agent = new LLMAgent('llm', { client, historyRounds: 2, maxLogLines: 20 });
      return agent;
    },
  });
  await game.setupAndRun();

  for (const c of client.calls) {
    const u = c.messages[0].content as string;
    const m = u.match(/近期战报\n([\s\S]*?)\n\n/);
    if (!m) continue;
    assert.ok(m[1].split('\n').length <= 20, '战报行数应受 maxLogLines 限制');
  }
  // 单次载荷不该随回合数线性膨胀
  const sizes = client.calls.map(c => (c.messages[0].content as string).length);
  const firstAvg = avg(sizes.slice(0, 10));
  const lastAvg = avg(sizes.slice(-10));
  assert.ok(lastAvg < firstAvg * 2.5, `载荷失控:开头${Math.round(firstAvg)} → 结尾${Math.round(lastAvg)}`);
});

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ————————————————— 记牌器 —————————————————

test('记牌器:已知 + 未知 = 牌堆配比总数', () => {
  const game = createGame({
    playerCount: 5, seed: 41, verbose: false,
    makeAgent: () => new BasicAI('r'),
  });
  const count = countCards(game, game.players[0]);
  const expect = new Map<string, number>();
  for (const [name] of DECK_TABLE) {
    const g = countGroup(name);
    expect.set(g, (expect.get(g) ?? 0) + 1);
  }
  for (const row of count.rows) {
    assert.equal(row.known + row.unknown, row.total, `${row.group} 账对不上`);
    assert.equal(row.total, expect.get(row.group), `${row.group} 总数与牌堆表不一致`);
  }
});

test('记牌器:未知池 = 牌堆 + 他人暗置手牌', () => {
  const game = createGame({
    playerCount: 5, seed: 43, verbose: false,
    makeAgent: () => new BasicAI('r'),
  });
  const me = game.players[0];
  const count = countCards(game, me);
  const hidden = game.players.filter(p => p !== me).reduce((s, p) => s + p.handCount, 0);
  assert.equal(count.hiddenHands, hidden);
  assert.equal(count.poolSize, game.deck.length + hidden);
});

test('记牌器:自己的手牌算已知,概率相应改变', () => {
  const game = createGame({
    playerCount: 2, seed: 47, verbose: false,
    makeAgent: () => new BasicAI('r'),
  });
  const me = game.players[0];
  const before = countCards(game, me).get('杀')!.unknown;
  // 手动塞一张杀进自己手牌
  const slash = game.deck.find(c => c.name === '杀')!;
  game.deck.splice(game.deck.indexOf(slash), 1);
  me.hand.push(slash);
  const after = countCards(game, me).get('杀')!.unknown;
  assert.equal(after, before - 1, '自己拿到的杀应从未知池里扣掉');
  assert.equal(countCards(game, me).holdChance(me, '杀'), 1, '自己手上有就是 100%');
});

test('记牌器:洗牌后弃牌堆里的牌重新变回未知', async () => {
  const game = createGame({
    playerCount: 2, seed: 53, verbose: false,
    makeAgent: () => new BasicAI('r'),
  });
  const me = game.players[0];
  // 把牌堆倒进弃牌堆,模拟一局打到快没牌
  game.discardPile.push(...game.deck.splice(0, 60));
  const seen = countCards(game, me).get('杀')!.unknown;
  // 触发洗牌
  game.deck.length = 0;
  game.drawFromDeck(1);
  const afterReshuffle = countCards(game, me).get('杀')!.unknown;
  assert.ok(afterReshuffle > seen, `洗牌后未知数应回升(${seen} → ${afterReshuffle})`);
});

test('记牌器:公开进入他人手牌的牌不再算未知', async () => {
  const game = createGame({
    playerCount: 2, seed: 59, verbose: false,
    makeAgent: () => new BasicAI('r'),
  });
  const [me, foe] = game.players;
  const peach = game.deck.find(c => c.name === '桃')!;
  game.deck.splice(game.deck.indexOf(peach), 1);
  foe.hand.push(peach);

  const blind = countCards(game, me);
  const blindUnknown = blind.get('桃')!.unknown;

  game.revealToAll(peach, foe);      // 比如被五谷亮出来取走
  const known = countCards(game, me);
  assert.equal(known.get('桃')!.unknown, blindUnknown - 1);
  assert.equal(known.holdChance(foe, '桃'), 1, '已确认对方持有就是 100%');
});

test('明牌开关真的走到了发出去的那条消息里', async () => {
  /*
   * 上面 prompt.test.ts 钉的是 situationBlock 的输出,这里钉的是**整条链路**:
   * LLMAgent 的选项 -> 实际发给模型的 payload。这个实验的全部结论都建立在
   * "治疗组确实多看到了东西"上,靠两处代码碰巧一致是不够的。
   */
  const seen: string[] = [];
  const client = mockClient(naiveResponder);
  let firstAsk: { mateSeat: number; mateCard: string; foeCard: string } | null = null;
  const game = createGame({
    mode: 'team2v2', playerCount: 4, seed: 11, log: () => {},
    makeAgent: (_p, i) => (i === 0
      ? new LLMAgent('llm-0', {
        client, teamHands: 'tail', plan: false,
        onDecision: (info) => { if (info.payload) seen.push(info.payload); },
      })
      : new BasicAI(`r${i}`)),
  });
  // 起手时抓一张队友的牌和一张敌人的牌,待会儿逐字在 payload 里找
  const me = game.players[0];
  const mate = game.players.find(p => p !== me && p.role === me.role)!;
  const foe = game.players.find(p => p.role !== me.role)!;
  firstAsk = { mateSeat: mate.seat, mateCard: cardLabel(mate.hand[0]), foeCard: cardLabel(foe.hand[0]) };
  await game.setupAndRun();

  assert.ok(seen.length > 0, '至少得问过模型一次');
  assert.ok(seen.some(p => p.includes(`队友明牌 P${firstAsk!.mateSeat}`)),
    `应该点名 P${firstAsk!.mateSeat}(和 P0 同队)`);
  assert.ok(seen.some(p => p.includes(firstAsk!.mateCard)),
    `队友起手的 ${firstAsk!.mateCard} 应该逐字出现在 payload 里`);
  assert.ok(!seen.some(p => p.includes(`队友明牌 P${foe.seat}`)), '敌人绝不能被当队友明牌');
});

test('ask 写法真的贴在题面前面 —— 空结果的前提是它确实送到了', async () => {
  /*
   * 三种写法跑下来引用率全是 0。这种"什么都没发生"的结果最危险的失败方式是
   * **treatment 根本没生效**,而那看起来和"生效了但没用"一模一样。
   * 所以除了内容要在,**位置**也要钉住:ask 的全部假设就是"离问题越近注意力越高",
   * 如果它被排在战报后面、题面前面之外的任何地方,这一版探的就不是它想探的东西。
   */
  const seen: string[] = [];
  const client = mockClient(naiveResponder);
  const game = createGame({
    mode: 'team2v2', playerCount: 4, seed: 11, log: () => {},
    makeAgent: (_p, i) => (i === 0
      ? new LLMAgent('llm-0', {
        client, teamHands: 'ask', plan: false,
        onDecision: (info) => { if (info.payload) seen.push(info.payload); },
      })
      : new BasicAI(`r${i}`)),
  });
  await game.setupAndRun();

  const hit = seen.filter(p => p.includes('这会改变你接下来的选择吗'));
  assert.ok(hit.length > 0, 'ask 那句必须出现在实际发出去的消息里');
  for (const p of hit) {
    const ask = p.indexOf('这会改变你接下来的选择吗');
    const q = p.indexOf('出牌阶段,选一个动作');
    if (q < 0) continue;
    assert.ok(ask < q, 'ask 必须排在题面**之前**');
    assert.ok(q - ask < 200, `ask 和题面之间不该隔着别的段落(隔了 ${q - ask} 字)`);
  }
  // 而且局势块里不该再重复一份
  assert.ok(!seen.some(p => p.includes('队友明牌')), 'ask 写法下不该同时出现 tail 那几行');
});

test('明牌默认关 —— 实验旋钮不能悄悄成为默认行为', async () => {
  const seen: string[] = [];
  const client = mockClient(naiveResponder);
  const game = createGame({
    mode: 'team2v2', playerCount: 4, seed: 11, log: () => {},
    makeAgent: (_p, i) => (i === 0
      ? new LLMAgent('llm-0', {
        client, plan: false,
        onDecision: (info) => { if (info.payload) seen.push(info.payload); },
      })
      : new BasicAI(`r${i}`)),
  });
  await game.setupAndRun();
  assert.ok(seen.length > 0);
  assert.ok(!seen.some(p => p.includes('队友明牌')));
});

test('蜂群:一个实例接管两个席位,身份块要覆盖两个人', async () => {
  /*
   * 最容易悄悄搞错的是 L1:它带着 cache_control、**只建一次**。
   * 按"第一个来问的那个人"建的话,轮到另一个席位时身份就是错的,而且还被缓存着 ——
   * 模型会一直以为自己是另一个人,整组数据作废而且看不出来。
   */
  const seen: string[] = [];
  const client = mockClient(naiveResponder);
  let brain: LLMAgent | null = null;
  const game = createGame({
    mode: 'team2v2', playerCount: 4, seed: 11, log: () => {},
    makeAgent: (p, _i, all) => {
      if (p.role !== game0Role()) return new BasicAI('r');
      if (!brain) {
        brain = new LLMAgent('llm-hive', {
          client, plan: false,
          hiveSeats: all.filter(q => q.role === p.role).map(q => q.seat),
          onDecision: (info) => { if (info.payload) seen.push(info.payload); },
        });
      }
      return brain;
    },
  });
  function game0Role() { return 'blue'; }
  const mine = game.players.filter(p => p.role === 'blue');
  assert.equal(mine.length, 2);
  await game.setupAndRun();

  const sys = (client.calls[0].system as any[]).map(x => x.text).join('\n');
  for (const p of mine) {
    assert.ok(sys.includes(`P${p.seat}`), `身份块要点名 P${p.seat}`);
  }
  assert.match(sys, /同时操控/, '要说清它操控的是两个人,不是一个');

  // 每次决策都要写明这回替谁做决定,否则两只手会混
  assert.ok(seen.length > 1);
  for (const p of mine) {
    assert.ok(seen.some(x => x.includes(`本次要你替 P${p.seat}`)),
      `应该出现过"替 P${p.seat} 做决定"`);
  }
  // 两个席位的手牌都要看得见 —— 那本来就是同一个人的两只手
  assert.ok(seen.some(x => x.includes('你操控的 P')), '另一只手的手牌要摆出来');
});

test('蜂群:计划按席位分开,不会拿 A 的计划去答 B 的题', async () => {
  /*
   * 一份计划钉着某个人的手牌 id 和体力。共用一个 PlanRunner 的话,
   * P0 的计划轮到 P3 时会被拿去核对 —— 手牌对不上就判"计划外"作废,
   * 不会出错但会把计划命中率打到 0,白烧一堆请求。
   */
  const { PlanRunner } = await import('../ai/plan.js');
  const client = mockClient(naiveResponder);
  const agent = new LLMAgent('llm-hive', { client, hiveSeats: [0, 3] });
  const seat = (n: number) => ({ seat: n } as any);
  const a = (agent as any).plannerOf(seat(0));
  const b = (agent as any).plannerOf(seat(3));
  assert.ok(a instanceof PlanRunner);
  assert.notEqual(a, b, '两个席位必须各有一份计划');
  assert.equal(a, (agent as any).plannerOf(seat(0)), '同一个席位要拿到同一份');
});
