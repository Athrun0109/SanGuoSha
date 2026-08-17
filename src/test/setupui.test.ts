/**
 * 开局设置页:配置校验 + API key 的出入口。
 *
 * 最重要的是最后那组:**原始 key 一个字节都不能出站**。
 * 这和 `web/state.ts` 挡手牌是同一个套路 —— 所有出站数据只经过一个函数,
 * 泄密就只可能发生在那一个地方,于是可以用测试把它焊死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { normalizeConfig, splitFixed, startingHandOf, defaultConfig } from '../web/config.js';
import { maskKey, setupApi, sessionApi } from '../web/setup.js';
import { preflight } from '../ai/preflight.js';
import { startViewer } from '../web/server.js';

const base = (over: Record<string, unknown> = {}) => ({
  playerCount: 3, seed: 42, viewer: null, reveal: false, speed: 0, record: false,
  seats: [{ control: 'rule' }, { control: 'rule' }, { control: 'rule' }],
  ...over,
});

// ————————————————— 配置校验 —————————————————

test('浏览器传上来的配置一律要过校验', () => {
  assert.throws(() => normalizeConfig(null), /必须是一个对象/);
  assert.throws(() => normalizeConfig(base({ playerCount: 9 })), /人数只能是 2~8/);
  assert.throws(() => normalizeConfig(base({ playerCount: 5 })), /席位数量.*和人数.*对不上/);
  assert.throws(() => normalizeConfig(base({ viewer: 7 })), /视角座位要在 0~2/);
});

test('武将必须存在,而且不能重复上场', () => {
  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'rule', general: '林冲' }, { control: 'rule' }, { control: 'rule' }],
  })), /没有这个武将:林冲/);

  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'rule', general: '关羽' }, { control: 'rule', general: '关羽' }, { control: 'rule' }],
  })), /【关羽】被指定了两次/);
});

test('身份名额由引擎那份唯一判定来管', () => {
  // 3 人局没有忠臣
  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'rule', role: 'loyalist' }, { control: 'rule' }, { control: 'rule' }],
  })), /忠臣 指定多了/);

  const ok = normalizeConfig(base({
    seats: [{ control: 'rule' }, { control: 'rule', role: 'renegade' }, { control: 'rule' }],
  }));
  assert.equal(ok.seats[1].role, 'renegade');
});

test('模型席位必须有模型 id,选项非法要报清楚是哪个座位', () => {
  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'llm' }, { control: 'rule' }, { control: 'rule' }],
  })), /0 号位选了大模型,但没有指定模型 id/);

  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'llm', model: 'x/y', effort: 'ultra' }, { control: 'rule' }, { control: 'rule' }],
  })), /0 号位的思考深度 只能是 low \/ medium \/ high/);

  assert.throws(() => normalizeConfig(base({
    seats: [{ control: 'wizard' }, { control: 'rule' }, { control: 'rule' }],
  })), /0 号位的控制者 只能是/);
});

test('模型挂在席位上 —— 同一局里不同席位可以用不同模型', () => {
  const cfg = normalizeConfig(base({
    playerCount: 2,
    seats: [
      { control: 'llm', model: 'deepseek/v4', effort: 'low', codec: 'anon' },
      { control: 'llm', model: 'anthropic/opus', effort: 'high' },
    ],
  }));
  assert.equal(cfg.seats[0].model, 'deepseek/v4');
  assert.equal(cfg.seats[0].codec, 'anon');
  assert.equal(cfg.seats[1].model, 'anthropic/opus');
  assert.equal(cfg.seats[1].codec, 'verbose', '没指定就是默认值');
});

test('拆出引擎要的两张表,没指定的座位不出现', () => {
  const cfg = normalizeConfig(base({
    seats: [{ control: 'rule', general: '关羽' }, { control: 'rule', role: 'renegade' }, { control: 'rule' }],
  }));
  const { fixedGenerals, fixedRoles } = splitFixed(cfg);
  assert.deepEqual(fixedGenerals, { 0: '关羽' });
  assert.deepEqual(fixedRoles, { 1: 'renegade' });
  assert.deepEqual(splitFixed(defaultConfig(3)), { fixedGenerals: undefined, fixedRoles: undefined });
});

test('后手补牌只有 1v1 才有', () => {
  assert.deepEqual(startingHandOf(normalizeConfig(base({
    playerCount: 2, handicap: 2, seats: [{ control: 'rule' }, { control: 'rule' }],
  }))), [4, 6]);
  assert.equal(startingHandOf(normalizeConfig(base())), undefined, '3 人局不该有补牌');
});

// ————————————————— 探路 —————————————————

/** 只记下请求参数的假客户端 */
function spyClient(fail?: string) {
  const seen: any[] = [];
  return {
    seen,
    messages: {
      async create(p: any) {
        seen.push(p);
        if (fail) throw new Error(fail);
        return { content: [{ type: 'text', text: 'OK' }] };
      },
    },
  };
}

test('探路请求要给足预算 —— 给小了会把好模型误判成坏的', async () => {
  // 这里原本写的是 16("够回一个 OK 就行"),结果 DeepSeek 光推理就烧了 28 个,
  // 正文一个字没吐就 finish_reason=length,凭据明明是好的却报"max_tokens 不够"
  const c = spyClient();
  const r = await preflight(c, 'deepseek/v4-flash');
  assert.equal(r.ok, true);
  assert.ok(c.seen[0].max_tokens >= 1024,
    `探路预算只有 ${c.seen[0].max_tokens},带推理的模型会直接撞截断`);
  assert.equal(c.seen[0].output_config?.effort, 'low', '探路不需要深思考,把推理压到最短');
});

test('探路失败不抛异常,把原因原样带回来', async () => {
  const r = await preflight(spyClient('OpenRouter 401:No auth credentials found'), 'x/y');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /401/);
  assert.ok(typeof r.ms === 'number');
});

// ————————————————— API key 不能出站 —————————————————

const SECRET = 'sk-or-v1-0123456789abcdef0123456789abcdef';

test('掩码不泄露中段,短 key 整条打星', () => {
  const m = maskKey(SECRET);
  assert.ok(!m.includes('0123456789abcdef'), '中段不能露');
  assert.ok(m.startsWith('sk-or-') && m.endsWith(SECRET.slice(-4)));
  assert.equal(maskKey('short'), '*****');
  assert.equal(maskKey(''), '');
});

test('接口的任何响应里都不出现原始 key', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = SECRET;
  const view = await startViewer({ port: 0, api: setupApi({ onStart: () => {} }) });
  try {
    // 逐个打接口,把响应体全拼起来,断言整段里找不到那把 key
    const bodies: string[] = [];
    for (const [path, init] of [
      ['/api/key', undefined],
      ['/api/generals', undefined],
      ['/api/start', { method: 'POST', body: JSON.stringify(base()) }],
      ['/api/nope', undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const r = await fetch(view.url + path, init);
      bodies.push(await r.text());
    }
    const all = bodies.join('\n');
    assert.ok(!all.includes(SECRET), '原始 key 泄漏到响应里了');
    assert.ok(all.includes(maskKey(SECRET)), '/api/key 应该回掩码');

    // 开局接口应该已经把这一局占住,再来一次要被挡
    const again = await fetch(view.url + '/api/start', { method: 'POST', body: JSON.stringify(base()) });
    assert.equal(again.status, 409);
  } finally {
    await view.close();
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev;
  }
});

test('配置不合法时,错误原样回给页面而不是 500', async () => {
  const view = await startViewer({ port: 0, api: setupApi({ onStart: () => {} }) });
  try {
    const r = await fetch(view.url + '/api/start', {
      method: 'POST',
      body: JSON.stringify(base({ seats: [{ control: 'rule', general: '林冲' }, {}, {}] })),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).error, /没有这个武将:林冲/);
  } finally { await view.close(); }
});

test('模型席位没配 key 时开局被挡住,而不是整局都在兜底', async () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const view = await startViewer({ port: 0, api: setupApi({ onStart: () => {} }) });
  try {
    const r = await fetch(view.url + '/api/start', {
      method: 'POST',
      body: JSON.stringify(base({
        seats: [{ control: 'llm', model: 'deepseek/x' }, { control: 'rule' }, { control: 'rule' }],
      })),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).error, /还没有配置 API key/);
  } finally {
    await view.close();
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
  }
});

// ————————————————— 出牌接口 —————————————————

test('出牌接口可以脱离设置页单独挂 —— npm run ui 用的就是这条', async () => {
  const got: number[][] = [];
  const view = await startViewer({
    port: 0, api: sessionApi({ onDecide: (c: number[]) => { got.push(c); return null; } }),
  });
  try {
    const post = (body: unknown) => fetch(view.url + '/api/decide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ choice: [2] })).status, 200);
    assert.deepEqual(got, [[2]]);

    const bad = await post({ choice: 'x' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json() as any).error, /choice 必须是数组/);

    // agent 说不行,就把它那句话原样回给页面
    const view2 = await startViewer({ port: 0, api: sessionApi({ onDecide: () => '现在没有轮到你的决策' }) });
    const r = await fetch(view2.url + '/api/decide', {
      method: 'POST', body: JSON.stringify({ choice: [0] }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).error, /没有轮到你/);
    await view2.close();
  } finally { await view.close(); }
});

test('没有网页座位时出牌接口明确拒绝,而不是静默吞掉', async () => {
  const view = await startViewer({ port: 0, api: sessionApi({}) });
  try {
    const r = await fetch(view.url + '/api/decide', {
      method: 'POST', body: JSON.stringify({ choice: [0] }),
    });
    assert.equal(r.status, 400);
    assert.match((await r.json() as any).error, /没有网页座位/);
  } finally { await view.close(); }
});

test('设置页和棋盘是两个地址,都能取到', async () => {
  const view = await startViewer({ port: 0, api: setupApi({ onStart: () => {} }) });
  try {
    assert.equal((await fetch(view.url + '/board')).status, 200);
    assert.equal((await fetch(view.url + '/')).status, 200);
  } finally { await view.close(); }
});

// ————————————————— 退出菜单的两个动作 —————————————————

test('重开:通知调用方,并把"这局已开始"那道闸门放开', async () => {
  let resets = 0;
  const view = await startViewer({
    port: 0,
    api: setupApi({ onStart: () => {}, onReset: () => { resets++; } }),
  });
  try {
    const post = (p: string, b?: unknown) => fetch(view.url + p, {
      method: 'POST', body: b === undefined ? undefined : JSON.stringify(b),
    });
    assert.equal((await post('/api/start', base())).status, 200);
    assert.equal((await post('/api/start', base())).status, 409, '同一局不能开两次');

    const r = await post('/api/reset');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, go: '/' }, '设置页那条路要让浏览器回 /');
    assert.equal(resets, 1);

    assert.equal((await post('/api/start', base())).status, 200, '重开之后要能再开一局');
  } finally { await view.close(); }
});

test('结束:先把响应发完再退进程,否则浏览器只看到连接被掐断', async () => {
  let quits = 0;
  const view = await startViewer({
    port: 0,
    api: setupApi({ onStart: () => {}, onQuit: () => { quits++; } }),
  });
  try {
    const r = await fetch(view.url + '/api/quit', { method: 'POST' });
    assert.equal(r.status, 200, '响应要先到');
    assert.deepEqual(await r.json(), { ok: true });
    // onQuit 挂在响应写完之后,给它一拍
    await new Promise(res => setTimeout(res, 30));
    assert.equal(quits, 1);
  } finally { await view.close(); }
});

test('入口没接这两个动作时,明确拒绝而不是静默', async () => {
  const view = await startViewer({ port: 0, api: sessionApi({}) });
  try {
    for (const [path, re] of [['/api/reset', /不支持重开/], ['/api/quit', /不支持结束进程/]] as const) {
      const r = await fetch(view.url + path, { method: 'POST' });
      assert.equal(r.status, 400);
      assert.match((await r.json() as any).error, re);
    }
  } finally { await view.close(); }
});
