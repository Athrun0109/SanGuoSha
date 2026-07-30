/**
 * 重试与兜底:什么时候该重试、什么时候该直接放弃、兜底原因有没有被带出来。
 * 之前的实现是"任何接口错误立刻放弃",一次网络抖动就白白丢一个决策。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, type DecisionInfo, type LLMClient } from '../ai/llmAgent.js';
import { createOpenRouterClient } from '../ai/openrouterClient.js';

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

test('OpenRouter:正文为空且有推理时,报错要点明是 max_tokens 不够', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '', reasoning: '想了很久…' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 100, completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 8000 } },
  }), { status: 200 })) as any;
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    await assert.rejects(
      () => client.messages.create({ model: 'm', max_tokens: 100, messages: [] }),
      /正文为空[\s\S]*length[\s\S]*8000[\s\S]*max_tokens 不够/,
    );
  } finally { globalThis.fetch = orig; }
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

test('默认 max_tokens 给到 8192 —— 4096 很容易被推理吃光', async () => {
  const r = await oneDecision(() => okJson([0]));
  assert.equal(r.seen[0].max_tokens, 8192);
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
