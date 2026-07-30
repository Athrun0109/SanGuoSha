/**
 * MCP server 的端到端测试:真的把 server 作为子进程拉起来,走 stdio 打一局。
 * 这样验证的是 Claude Code 实际会执行的那条命令,而不只是内部函数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function connect() {
  // 和 .mcp.json 里配置的启动方式保持一致:直接用 node 拉 tsx,
  // 避开 Windows 上 spawn npx/.cmd 的坑
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['node_modules/tsx/dist/cli.mjs', 'src/mcp/server.ts'],
    cwd: root,
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

function textOf(res: any): string {
  return (res.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
}

/** 从题面里解析选项数量和需要选几个 */
function parseQuestion(t: string) {
  const optCount = (t.match(/^\d+:/gm) ?? []).length;
  let min = 1, max = 1, m: RegExpMatchArray | null;
  if ((m = t.match(/选0~(\d+)个/))) { min = 0; max = Number(m[1]); }
  else if ((m = t.match(/选(\d+)~(\d+)个/))) { min = Number(m[1]); max = Number(m[2]); }
  else if ((m = t.match(/选(\d+)个/))) { min = max = Number(m[1]); }
  return { optCount, min, max };
}

test('server 暴露 new_game / decide / look 三个工具', async () => {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['decide', 'list_generals', 'look', 'new_game']);
    const newGame = tools.find(t => t.name === 'new_game')!;
    for (const k of ['players', 'seat', 'seed', 'codec', 'generals', 'handicap']) {
      assert.ok(newGame.inputSchema.properties?.[k], `new_game 缺少参数 ${k}`);
    }
  } finally { await close(); }
});

test('开局返回规则 + 身份 + 局面 + 第一个待决策', async () => {
  const { client, close } = await connect();
  try {
    const res: any = await client.callTool({
      name: 'new_game',
      arguments: { players: 2, seed: 1234, generals: ['关羽', '吕布'] },
    });
    const t = textOf(res);
    assert.ok(t.includes('三国杀标准版'), '应包含规则');
    assert.ok(t.includes('武圣'), '应包含你的技能说明');
    assert.ok(t.includes('无双'), '应包含对手的技能说明(公开信息)');
    assert.ok(t.includes('记牌器'), '应包含记牌器');
    assert.ok(t.includes('问题'), '应包含待决策问题');
    assert.ok(/^0:/m.test(t), '选项应带编号');
    assert.ok(t.includes('decide'), '应告诉调用方下一步用什么工具');
  } finally { await close(); }
});

test('能靠 decide 一路把整局打完', async () => {
  const { client, close } = await connect();
  try {
    let t = textOf(await client.callTool({
      name: 'new_game', arguments: { players: 2, seed: 88 },
    }) as any);

    let steps = 0;
    while (!t.includes('游戏结束') && steps < 300) {
      const { optCount, min } = parseQuestion(t);
      assert.ok(optCount > 0, `第 ${steps} 步没有可选项:\n${t.slice(-400)}`);
      const choice = Array.from({ length: Math.min(min, optCount) }, (_, i) => i);
      t = textOf(await client.callTool({ name: 'decide', arguments: { choice } }) as any);
      steps++;
    }
    assert.ok(t.includes('游戏结束'), `${steps} 步内没打完:\n${t.slice(-400)}`);
    assert.ok(/获胜|失败/.test(t), '结局应说明你赢了还是输了');
    assert.ok(steps > 5, '一局不该只有几步');
  } finally { await close(); }
});

test('非法编号会被拒绝并重新给出题面,不会推进牌局', async () => {
  const { client, close } = await connect();
  try {
    await client.callTool({ name: 'new_game', arguments: { players: 2, seed: 5 } });
    const before = textOf(await client.callTool({ name: 'look', arguments: {} }) as any);

    const bad = textOf(await client.callTool({ name: 'decide', arguments: { choice: [999] } }) as any);
    assert.ok(bad.includes('不合法'), '应明确拒绝');
    assert.ok(bad.includes('编号必须在'), '应说明原因');

    const after = textOf(await client.callTool({ name: 'look', arguments: {} }) as any);
    assert.equal(after, before, '被拒绝的提交不应改变牌局状态');
  } finally { await close(); }
});

test('look 不消耗决策,可以反复看', async () => {
  const { client, close } = await connect();
  try {
    await client.callTool({ name: 'new_game', arguments: { players: 5, seed: 9 } });
    const a = textOf(await client.callTool({ name: 'look', arguments: {} }) as any);
    const b = textOf(await client.callTool({ name: 'look', arguments: { rules: true } }) as any);
    assert.equal(a, textOf(await client.callTool({ name: 'look', arguments: {} }) as any));
    assert.ok(b.length > a.length, 'rules:true 应该更长');
  } finally { await close(); }
});

test('anon 模式下工具返回里不出现武将原名', async () => {
  const { client, close } = await connect();
  try {
    const t = textOf(await client.callTool({
      name: 'new_game',
      arguments: { players: 2, seed: 77, codec: 'anon', generals: ['关羽', '吕布'] },
    }) as any);
    for (const name of ['关羽', '吕布', '武圣', '无双', '三国杀']) {
      assert.ok(!t.includes(name), `anon 模式泄漏了:${name}`);
    }
    assert.ok(t.includes('P0'), '应使用座位代号');
  } finally { await close(); }
});

test('未开局时调用 decide 会给出明确提示', async () => {
  const { client, close } = await connect();
  try {
    const t = textOf(await client.callTool({ name: 'decide', arguments: { choice: [0] } }) as any);
    assert.ok(t.includes('new_game'), '应提示先开局');
  } finally { await close(); }
});

test('list_generals 列出全部武将,也能查单个详情', async () => {
  const { client, close } = await connect();
  try {
    const all = textOf(await client.callTool({ name: 'list_generals', arguments: {} }) as any);
    assert.ok(all.includes('关羽') && all.includes('貂蝉'), '应列出全部 25 将');
    assert.equal((all.match(/^\s*\d+\. /gm) ?? []).length, 25);

    const one = textOf(await client.callTool({ name: 'list_generals', arguments: { name: '诸葛亮' } }) as any);
    assert.ok(one.includes('观星') && one.includes('空城'));
    assert.ok(one.includes('牌堆顶'), '详情应含技能全文');
  } finally { await close(); }
});

test('手动点将生效,不认识的名字给出候选', async () => {
  const { client, close } = await connect();
  try {
    const ok = textOf(await client.callTool({
      name: 'new_game', arguments: { players: 2, seed: 3, generals: ['诸葛亮', '貂蝉'] },
    }) as any);
    assert.ok(ok.includes('诸葛亮') && ok.includes('貂蝉'));
    assert.ok(ok.includes('观星'), '应带上所点武将的技能');

    const bad = textOf(await client.callTool({
      name: 'new_game', arguments: { players: 2, generals: ['关羽', '张三'] },
    }) as any);
    assert.ok(bad.includes('没有这些武将') && bad.includes('张三'));
    assert.ok(bad.includes('可选'), '应给出候选列表');
  } finally { await close(); }
});

test('留空位表示该座位随机点将', async () => {
  const { client, close } = await connect();
  try {
    const t = textOf(await client.callTool({
      name: 'new_game', arguments: { players: 2, seed: 6, generals: ['', '吕布'] },
    }) as any);
    assert.ok(t.includes('吕布'), '指定的那位应生效');
    assert.ok(t.includes('无双'));
  } finally { await close(); }
});

test('handicap 参数被接受且能开出局', async () => {
  const { client, close } = await connect();
  try {
    const t = textOf(await client.callTool({
      name: 'new_game', arguments: { players: 2, seed: 21, handicap: 0 },
    }) as any);
    assert.ok(t.includes('问题'), '应正常开局并给出第一个决策');
  } finally { await close(); }
});
