/**
 * 重试与兜底:什么时候该重试、什么时候该直接放弃、兜底原因有没有被带出来。
 * 之前的实现是"任何接口错误立刻放弃",一次网络抖动就白白丢一个决策。
 */

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo, type LLMClient } from '../ai/llmAgent.js';
import {
  createOpenRouterClient, DEFAULT_TIMEOUT_MS, DEFAULT_PROVIDER,
  REASONING_BUDGET, timeoutForBudget,
} from '../ai/openrouterClient.js';

const okJson = (choice: number[] = [0]) => ({
  content: [{ type: 'text', text: JSON.stringify({ thinking: 'ok', choice }) }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

/** 单独驱动一次决策,拿到 onDecision 的回调内容 */
async function oneDecision(
  create: (params: any, n: number) => any,
  opts: Partial<ConstructorParameters<typeof LLMAgent>[1]> = {},
) {
  let n = 0;
  const seen: any[] = [];
  const client: LLMClient = {
    messages: {
      async create(params: any) {
        seen.push(params);
        const r = create(params, n++);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  const infos: DecisionInfo[] = [];
  let agent!: LLMAgent;
  const game = createGame({
    playerCount: 2, seed: 4, verbose: false,
    makeAgent: (p, i) => {
      if (i !== 0) return new BasicAI('r');
      agent = new LLMAgent('llm', { client, onDecision: (d: DecisionInfo) => infos.push(d), ...opts } as any);
      return agent;
    },
  }) as any;
  const me = game.players[0];
  const picked = await agent.chooseOption(game, me, ['甲', '乙', '丙'], '选一个');
  return { picked, infos, seen, agent };
}

test('临时错误会重试,而不是一次失败就兜底', async () => {
  const r = await oneDecision((_p, n) => (n < 2 ? new Error('socket hang up') : okJson([1])));
  assert.equal(r.picked, 1, '第三次成功了就该用模型的结果');
  assert.equal(r.seen.length, 3, '应该重试过两次');
  assert.equal(r.infos[0].usedFallback, false);
  assert.equal(r.agent.stats.fallbacks, 0);
});

test('凭据类错误不重试,直接兜底', async () => {
  const r = await oneDecision(() => new Error('OpenRouter 401:{"error":{"message":"No auth credentials found"}}'));
  assert.equal(r.seen.length, 1, '401 重试多少次都一样,不该浪费');
  assert.equal(r.infos[0].usedFallback, true);
  assert.match(r.infos[0].error ?? '', /401/);
});

test('正文被推理吃光时,加大预算重试', async () => {
  const r = await oneDecision((_p, n) =>
    (n === 0 ? new Error('返回的正文为空(finish_reason=length,推理占了 8000 tokens —— max_tokens 不够)') : okJson([2])),
    { maxTokens: 4096 },
  );
  assert.equal(r.picked, 2);
  assert.equal(r.seen.length, 2);
  assert.equal(r.seen[0].max_tokens, 4096);
  assert.equal(r.seen[1].max_tokens, 8192, '第二次应该把预算翻倍');
});

test('兜底时把失败原因带出来,而不是只说一句"兜底"', async () => {
  const r = await oneDecision(() => new Error('请求超时(120000ms)'));
  const info = r.infos[0];
  assert.equal(info.usedFallback, true);
  assert.match(info.error ?? '', /请求超时/);
});

test('模型一直给非法编号,也会说明是这个原因', async () => {
  const r = await oneDecision(() => ({
    content: [{ type: 'text', text: JSON.stringify({ thinking: '越界', choice: [99] }) }],
  }));
  assert.equal(r.infos[0].usedFallback, true);
  assert.match(r.infos[0].error ?? '', /不合法/);
});

/** 让 fetch 返回一份指定的 OpenRouter 响应 */
function fakeReply(choice: any, reasoningTokens = 0) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [choice],
    usage: {
      prompt_tokens: 100, completion_tokens: reasoningTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  }), { status: 200 })) as any;
  return () => { globalThis.fetch = orig; };
}

test('默认按吞吐路由,并把实际服务的供应商带回来', async () => {
  // 同一个模型 OpenRouter 会分给多家供应商,实测同一局里单次调用在 20~100 秒之间跳。
  // 这个项目一局几十次调用,延迟直接决定能不能用,而 flash 本来就便宜 —— 按速度排。
  assert.deepEqual(DEFAULT_PROVIDER, { sort: 'throughput' });

  let body: any = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"choice":[0]}' }, finish_reason: 'stop' }],
      usage: {}, provider: 'DeepInfra',
    }), { status: 200 });
  }) as any;
  try {
    const res = await createOpenRouterClient({ apiKey: 'sk-test' })
      .messages.create({ model: 'm', max_tokens: 100, messages: [] });
    assert.deepEqual(body.provider, { sort: 'throughput' }, '路由偏好要真的发出去');
    assert.equal(res.provider, 'DeepInfra', '哪家服务的要带回来,否则没法对比路由效果');

    // 传 null 就完全交回 OpenRouter 自己的默认路由
    await createOpenRouterClient({ apiKey: 'sk-test', provider: null })
      .messages.create({ model: 'm', max_tokens: 100, messages: [] });
    assert.equal(body.provider, undefined);
  } finally { globalThis.fetch = orig; }
});

test('空正文 + finish_reason=length:这是真截断,要点明该加预算', async () => {
  const restore = fakeReply(
    { message: { content: '', reasoning: '想了很久…' }, finish_reason: 'length' }, 8000);
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    await assert.rejects(
      () => client.messages.create({ model: 'm', max_tokens: 100, messages: [] }),
      /finish_reason=length[\s\S]*8000[\s\S]*不够/,
    );
  } finally { restore(); }
});

test('空正文 + finish_reason=null:这是供应商卡住,**不能**报成预算问题', async () => {
  // 真实案例:等了 100 秒,只出了 1967 个推理 token,finish_reason 是 null。
  // 以前这里一律报"max_tokens 不够",于是重试逻辑把 32768 翻到 65536 ——
  // 对一个卡死的供应商毫无用处,还让下一次更慢。诊断错了,补救也跟着错。
  const restore = fakeReply(
    { message: { content: '', reasoning: '嗯…' }, finish_reason: null }, 1967);
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    await assert.rejects(
      () => client.messages.create({ model: 'm', max_tokens: 32768, messages: [] }),
      (e: Error) => {
        assert.match(e.message, /供应商卡住|掉线/);
        assert.match(e.message, /1967/);
        assert.ok(!/max_tokens.*不够/.test(e.message), '不能把它说成预算问题');
        // 重试逻辑靠这个正则区分两者,别让它误判
        assert.ok(!/finish_reason=length/.test(e.message));
        return true;
      },
    );
  } finally { restore(); }
});

test('回答被塞进 reasoning 而 content 为空时,把它捞回来', async () => {
  // 有些供应商会这么干。里面有 JSON 就交给上层的 extractJson —— 白捡一次成功
  const restore = fakeReply({
    message: { content: '', reasoning: '先想想…{"thinking":"a","choice":[1]}' },
    finish_reason: null,
  }, 50);
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    const res = await client.messages.create({ model: 'm', max_tokens: 100, messages: [] });
    assert.match(res.content[0].text ?? '', /"choice":\[1\]/);
  } finally { restore(); }
});

test('OpenRouter:推理 token 数会计入 usage', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"thinking":"a","choice":[0]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 250 } },
  }), { status: 200 })) as any;
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    const res: any = await client.messages.create({ model: 'm', messages: [] });
    assert.equal(res.usage.reasoning_tokens, 250);
    assert.equal(res.usage.output_tokens, 300);
  } finally { globalThis.fetch = orig; }
});

test('默认 max_tokens 给得宽 —— 它是上限不是预留,给小了只会换来兜底', async () => {
  const r = await oneDecision(() => okJson([0]));
  assert.equal(r.seen[0].max_tokens, 32768);
  assert.ok(r.seen[0].max_tokens <= 65536, 'deepseek-v4-flash-0731 的输出上限是 65536');
});

test('超时跟着 reasoning 预算走,不是一律 180 秒', async () => {
  /*
   * 非流式请求:模型没生成完一个字节都不会到,所以生成耗时全额计入超时 ——
   * 没有预算可依据时,超时必须配得上 32768 的 max_tokens。
   */
  assert.ok(DEFAULT_TIMEOUT_MS >= 120_000,
    `默认超时只有 ${DEFAULT_TIMEOUT_MS / 1000}s,配不上 32768 的 max_tokens`);
  assert.equal(timeoutForBudget(undefined), DEFAULT_TIMEOUT_MS);

  /*
   * 但一旦 effort 把推理封了顶,180 秒就纯属干等。
   *
   * 真实事故(20260819-180527):effort=low(推理封在 2400 token),一次"出牌阶段
   * 选一个动作"、才 4 个选项,第一次调用整整等满 180 秒什么都没回来,换一家重试
   * 又花了 92 秒 —— 一个决策 272 秒。而同一个问题分到快的节点只要 1.8 秒。
   * 超时之后是**换一家重试**,不是直接兜底,所以早点重掷几乎没有代价。
   */
  const low = timeoutForBudget(REASONING_BUDGET.low);
  assert.ok(low > 50_000, `low 档 ${low / 1000}s 太紧 —— 实测合法的 low 调用慢的能到 44.5s`);
  assert.ok(low < 100_000, `low 档 ${low / 1000}s 还是太松,2400 token 不该等这么久`);
  // 预算越大容得越久,且永远不超过兜底上限
  assert.ok(timeoutForBudget(REASONING_BUDGET.medium) > low);
  assert.equal(timeoutForBudget(REASONING_BUDGET.high), DEFAULT_TIMEOUT_MS);
});

test('低 effort 的请求真的按短超时放弃,而不是等满 180 秒', async () => {
  const orig = globalThis.fetch;
  let aborted = false;
  globalThis.fetch = (async (_u: any, init: any) => {
    // 头发完、body 永远不给 —— 正是那次事故的形态
    const stalled = new ReadableStream({
      start(c) {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      },
    });
    return new Response(stalled, { status: 200 });
  }) as any;
  // 派生出来的超时是几十秒,真等一遍太慢 —— 用假定时器把它跳过去
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    const call = client.messages.create({
      model: 'm', messages: [], output_config: { effort: 'low' },
    });
    // 走到 low 档的超时点之后,再往前一点点 —— 不该等到 180 秒
    mock.timers.tick(timeoutForBudget(REASONING_BUDGET.low) + 1000);
    await assert.rejects(
      () => call,
      (e: Error) => {
        assert.match(e.message, /请求超时/);
        assert.match(e.message, new RegExp(`推理预算 ${REASONING_BUDGET.low} tokens`),
          '报错要说清预算,否则分不清是模型在想还是节点卡住了');
        assert.ok(!/180s/.test(e.message), `low 档不该再报 180s,实际:${e.message}`);
        return true;
      });
    assert.ok(aborted);
  } finally {
    mock.timers.reset();
    globalThis.fetch = orig;
  }
});

test('预算超出模型上限时往回退,不跟着翻倍再撞一次', async () => {
  const r = await oneDecision((_p, n) =>
    (n === 0 ? new Error('OpenRouter 400:{"error":{"message":"max_tokens is too large"}}') : okJson([1])),
    { maxTokens: 32768 },
  );
  assert.equal(r.picked, 1);
  assert.ok(r.seen[1].max_tokens < r.seen[0].max_tokens,
    `超限之后应该调小,实际 ${r.seen[0].max_tokens} → ${r.seen[1].max_tokens}`);
});

// ————————————————— 超时保护 —————————————————

test('响应体读到一半卡住也会超时,不会永远等下去', async () => {
  const orig = globalThis.fetch;
  // 头已经发完、body 一直不给 —— 正是之前会挂死的场景:
  // 旧代码在 fetch() 一 resolve 就清掉了超时定时器,读 body 完全没保护。
  globalThis.fetch = (async (_u: any, init: any) => {
    const stalled = new ReadableStream({
      start(c) {
        init.signal?.addEventListener('abort', () => c.error(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        ));
      },
    });
    return new Response(stalled, { status: 200 });
  }) as any;
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test', timeoutMs: 300 });
    const t0 = Date.now();
    await assert.rejects(() => client.messages.create({ model: 'm', messages: [] }), /请求超时/);
    assert.ok(Date.now() - t0 < 5000, '应该在超时设定附近放弃,而不是无限等待');
  } finally { globalThis.fetch = orig; }
});

test('每次请求都带 AbortSignal', async () => {
  const orig = globalThis.fetch;
  let sawSignal = false;
  globalThis.fetch = (async (_u: any, init: any) => {
    sawSignal = !!init.signal;
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"thinking":"a","choice":[0]}' }, finish_reason: 'stop' }],
    }), { status: 200 });
  }) as any;
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    await client.messages.create({ model: 'm', messages: [] });
    assert.ok(sawSignal);
  } finally { globalThis.fetch = orig; }
});
