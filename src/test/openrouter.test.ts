/**
 * OpenRouter 适配层的测试。用假 fetch 跑,不需要 API key 也不花钱。
 * 验证报文翻译、用量映射、错误处理,以及"换后端不影响 agent"这件事。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { LLMAgent, extractJson } from '../ai/llmAgent.js';
import { createOpenRouterClient, toOpenAI } from '../ai/openrouterClient.js';

/** 替换全局 fetch,记录请求 */
function fakeFetch(handler: (url: string, init: any) => { status?: number; body: any }) {
  const calls: Array<{ url: string; body: any; headers: any }> = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body, headers: init.headers });
    const r = handler(String(url), init);
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      { status: r.status ?? 200 },
    );
  }) as any;
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const okReply = (text: string) => ({
  body: {
    model: 'deepseek/deepseek-v4-flash',
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 900 } },
  },
});

// ————————————————— 报文翻译 —————————————————

test('把 Anthropic 形状的请求翻译成 OpenAI 形状', () => {
  const out: any = toOpenAI({
    model: 'deepseek/deepseek-v4-flash',
    max_tokens: 4096,
    system: [{ type: 'text', text: '规则' }, { type: 'text', text: '身份', cache_control: {} }],
    messages: [{ role: 'user', content: '局面' }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object' } } },
    cache_control: { type: 'ephemeral' },
  });

  assert.equal(out.model, 'deepseek/deepseek-v4-flash');
  assert.equal(out.max_tokens, 4096);
  assert.deepEqual(out.messages[0], { role: 'system', content: '规则\n\n身份' });
  assert.deepEqual(out.messages[1], { role: 'user', content: '局面' });
  assert.equal(out.response_format.type, 'json_schema');
  assert.equal(out.response_format.json_schema.strict, true);
  assert.deepEqual(out.reasoning, { effort: 'low' });
  assert.ok(!('cache_control' in out), 'cache_control 是 Anthropic 专有的,不该透传');
});

test('effort 的 xhigh/max 收敛到 high(OpenRouter 只有三档)', () => {
  for (const e of ['xhigh', 'max']) {
    const out: any = toOpenAI({ model: 'm', output_config: { effort: e } });
    assert.deepEqual(out.reasoning, { effort: 'high' });
  }
  const none: any = toOpenAI({ model: 'm' });
  assert.ok(!('reasoning' in none), '没给 effort 就不该带这个字段');
});

// ————————————————— 客户端行为 —————————————————

test('正常返回:内容和用量都映射回 Anthropic 形状', async () => {
  const f = fakeFetch(() => okReply('{"thinking":"ok","choice":[1]}'));
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    const res: any = await client.messages.create({ model: 'deepseek/deepseek-v4-flash', max_tokens: 100, messages: [] });

    assert.deepEqual(res.content, [{ type: 'text', text: '{"thinking":"ok","choice":[1]}' }]);
    assert.equal(res.usage.input_tokens, 1200);
    assert.equal(res.usage.output_tokens, 80);
    assert.equal(res.usage.cache_read_input_tokens, 900);
    assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(f.calls[0].headers.authorization, 'Bearer sk-test');
  } finally { f.restore(); }
});

test('HTTP 错误带上状态码和响应体,便于排查', async () => {
  const f = fakeFetch(() => ({ status: 401, body: { error: { message: 'No auth credentials found' } } }));
  try {
    const client = createOpenRouterClient({ apiKey: 'bad' });
    await assert.rejects(
      () => client.messages.create({ model: 'm', messages: [] }),
      /401.*No auth credentials/s,
    );
  } finally { f.restore(); }
});

test('OpenRouter 把错误塞在 200 里也能识别', async () => {
  const f = fakeFetch(() => ({ body: { error: { message: 'model not found' } } }));
  try {
    const client = createOpenRouterClient({ apiKey: 'sk-test' });
    await assert.rejects(() => client.messages.create({ model: 'x/y', messages: [] }), /model not found/);
  } finally { f.restore(); }
});

test('没有凭据时构造就报错,而不是等到发请求', () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.throws(() => createOpenRouterClient(), /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});

// ————————————————— 宽松 JSON 解析 —————————————————

test('模型不老实时也能把 JSON 抠出来', () => {
  assert.deepEqual(extractJson('{"thinking":"a","choice":[0]}'), { thinking: 'a', choice: [0] });
  assert.deepEqual(extractJson('```json\n{"thinking":"a","choice":[2]}\n```'), { thinking: 'a', choice: [2] });
  assert.deepEqual(extractJson('好的,我的选择是:\n{"thinking":"a","choice":[1]}'), { thinking: 'a', choice: [1] });
  assert.throws(() => extractJson('我选第二个'), /无法从响应里解析出 JSON/);
});

// ————————————————— 端到端 —————————————————

test('换成 OpenRouter 后端,整局照样能打完', async () => {
  const f = fakeFetch((_url, init) => {
    const body = JSON.parse(init.body);
    const last = body.messages[body.messages.length - 1].content as string;
    const optCount = (last.match(/^\d+:/gm) ?? []).length;
    let min = 1, m: RegExpMatchArray | null;
    if ((m = last.match(/选0~(\d+)个/))) min = 0;
    else if ((m = last.match(/选(\d+)~(\d+)个/))) min = Number(m[1]);
    else if ((m = last.match(/选(\d+)个/))) min = Number(m[1]);
    // 故意裹上围栏,顺便验证宽松解析在真实链路上生效
    return okReply('```json\n' + JSON.stringify({
      thinking: '测试', choice: Array.from({ length: Math.min(min, optCount) }, (_, i) => i),
    }) + '\n```');
  });
  try {
    let agent!: LLMAgent;
    const game = createGame({
      playerCount: 2, seed: 21, verbose: false,
      makeAgent: (p, i) => {
        if (i !== 0) return new BasicAI('rule');
        agent = new LLMAgent('llm', {
          client: createOpenRouterClient({ apiKey: 'sk-test' }),
          model: 'deepseek/deepseek-v4-flash',
        });
        return agent;
      },
    });

    const res = await game.setupAndRun();
    assert.ok(res.reason);
    assert.ok(agent.stats.calls > 5, '应该真的调用过');
    assert.equal(agent.stats.fallbacks, 0, '围栏包裹不该触发兜底');
    assert.ok(agent.stats.cacheReadTokens > 0, '缓存命中数应被统计');
    // 每一次请求都应带上结构化输出约束
    for (const c of f.calls) {
      assert.equal(c.body.response_format?.type, 'json_schema');
    }
  } finally { f.restore(); }
});
