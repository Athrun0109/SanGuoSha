/**
 * 人类界面相关:「0. 查看局势」选项、局势面板、.env 读写、启动向导的模型筛选。
 * HumanAgent 的输入输出是可注入的,所以这些都能离线测。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { HumanAgent, formatBoard } from '../cli/humanAgent.js';
import { parseEnv, saveEnv, loadEnv } from '../cli/env.js';
import { pickRecommended } from '../cli/start.js';
import { realCard } from '../core/types.js';

/** 造一局并返回一个用脚本输入驱动的 HumanAgent */
function scripted(inputs: string[], seed = 5) {
  const asked: string[] = [];
  const out: string[] = [];
  let agent!: HumanAgent;
  const game = createGame({
    playerCount: 3, seed, verbose: false,
    makeAgent: (p, i) => {
      if (i !== 0) return new BasicAI(`r${i}`);
      agent = new HumanAgent('you', {
        ask: async (q) => { asked.push(q); return inputs.shift() ?? ''; },
        print: (s) => out.push(s),
      });
      return agent;
    },
  });
  return { game, get agent() { return agent; }, out, asked, text: () => out.join('\n') };
}

// ————————————————— 查看局势 —————————————————

test('每个选择都带 0. 查看局势,真正的选项从 1 开始编号', async () => {
  const h = scripted(['2']);            // 直接选第 2 项 → 原下标 1
  const me = h.game.players[0];
  const picked = await h.agent.chooseOption(h.game, me, ['甲', '乙', '丙'], '随便选一个');

  assert.equal(picked, 1, '显示的 2 应该映射回原数组下标 1');
  const t = h.text();
  assert.ok(t.includes('0. 查看局势'));
  assert.ok(t.includes('1. 甲') && t.includes('2. 乙') && t.includes('3. 丙'));
});

test('输入 0 会打印局势并重新提问,不消耗选择', async () => {
  const h = scripted(['0', '1']);
  const me = h.game.players[0];
  const picked = await h.agent.chooseOption(h.game, me, ['甲', '乙'], '选一个');

  assert.equal(picked, 0);
  assert.equal(h.asked.length, 2, '看完局势应该再问一次');
  const t = h.text();
  assert.ok(t.includes('座位') && t.includes('装备'), '应打印局势面板');
  assert.equal((t.match(/0\. 查看局势/g) ?? []).length, 2, '选项列表应重新渲染一遍');
});

test('局势面板列出每个座位的武将、体力、手牌数、装备', async () => {
  const game = createGame({
    playerCount: 4, seed: 11, verbose: false,
    fixedGenerals: { 0: '关羽', 1: '吕布', 2: '诸葛亮', 3: '貂蝉' },
    makeAgent: () => new BasicAI('r'),
  });
  const me = game.players[0];
  await game.equipCard(game.players[1], { id: 9001, name: '青龙偃月刀', suit: '♠', rank: 5 });

  const board = formatBoard(game, me);
  for (const g of ['关羽', '吕布', '诸葛亮', '貂蝉']) {
    assert.ok(board.includes(g), `缺少 ${g}`);
  }
  for (let i = 0; i < 4; i++) assert.ok(board.includes(`[${i}]`), `缺少座位 ${i}`);
  assert.ok(board.includes('青龙偃月刀'), '应显示装备');
  assert.ok(board.includes('♥'), '应显示体力');
  assert.ok(board.includes('距你'), '应显示距离');
  assert.ok(/攻击范围|手牌上限|牌堆剩余/.test(board), '应显示自己的关键数值');
});

test('多选题里的 0 同样是查看局势,不会被当成第一张牌', async () => {
  const h = scripted(['0', '1 2']);
  const me = h.game.players[0];
  const cards = [realCard({ id: 1, name: '杀', suit: '♠', rank: 7 }).cards[0],
    realCard({ id: 2, name: '闪', suit: '♦', rank: 3 }).cards[0],
    realCard({ id: 3, name: '桃', suit: '♥', rank: 9 }).cards[0]];
  const got = await h.agent.chooseCards(h.game, me, cards, 2, 2, '弃两张');

  assert.deepEqual(got.map(c => c.id), [1, 2], '显示的 1、2 应映射回前两张');
  assert.ok(h.text().includes('座位'), '中间看过一次局势');
});

test('非法输入会提示重来而不是崩', async () => {
  const h = scripted(['99', 'abc', '2']);
  const me = h.game.players[0];
  const picked = await h.agent.chooseOption(h.game, me, ['甲', '乙'], '选一个');
  assert.equal(picked, 1);
  assert.ok(h.text().includes('请输入 0~2 之间的编号'));
});

test('可放弃的选择直接回车返回 -1', async () => {
  const h = scripted(['']);
  const me = h.game.players[0];
  const picked = await h.agent.chooseOption(h.game, me, ['甲'], '要不要', true);
  assert.equal(picked, -1);
});

// ————————————————— .env —————————————————

test('解析 .env:忽略注释空行,支持引号', () => {
  const v = parseEnv([
    '# 注释',
    '',
    'OPENROUTER_API_KEY=sk-or-abc',
    'QUOTED="has space"',
    "SINGLE='x'",
    'BAD_LINE',
    '=nokey',
  ].join('\n'));
  assert.deepEqual(v, {
    OPENROUTER_API_KEY: 'sk-or-abc',
    QUOTED: 'has space',
    SINGLE: 'x',
  });
});

test('写 .env 会更新已有键并保留其它内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-env-'));
  const file = path.join(dir, '.env');
  try {
    fs.writeFileSync(file, '# 我的配置\nFOO=1\nOPENROUTER_API_KEY=old\n');
    saveEnv('OPENROUTER_API_KEY', 'new', file);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.includes('OPENROUTER_API_KEY=new'));
    assert.ok(!after.includes('old'));
    assert.ok(after.includes('# 我的配置') && after.includes('FOO=1'), '其它内容不该丢');

    saveEnv('NEW_KEY', 'v', file);
    assert.ok(fs.readFileSync(file, 'utf8').includes('NEW_KEY=v'), '新键应追加');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('加载 .env 不覆盖已经 export 过的环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-env-'));
  const file = path.join(dir, '.env');
  const saved = process.env.SGS_TEST_KEY;
  try {
    fs.writeFileSync(file, 'SGS_TEST_KEY=from-file\nSGS_TEST_ONLY=file-only\n');
    process.env.SGS_TEST_KEY = 'from-shell';
    loadEnv(file);
    assert.equal(process.env.SGS_TEST_KEY, 'from-shell', '环境变量优先级更高');
    assert.equal(process.env.SGS_TEST_ONLY, 'file-only');
  } finally {
    if (saved === undefined) delete process.env.SGS_TEST_KEY; else process.env.SGS_TEST_KEY = saved;
    delete process.env.SGS_TEST_ONLY;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ————————————————— 启动向导的模型筛选 —————————————————

test('只推荐支持结构化输出的模型,DeepSeek 优先且按价格排', () => {
  const all = [
    { id: 'x/no-struct', ctx: 1, inPrice: 0.01, outPrice: 0.02, structured: false },
    { id: 'deepseek/deepseek-v4-pro', ctx: 1, inPrice: 0.435, outPrice: 0.87, structured: true },
    { id: 'deepseek/deepseek-v4-flash', ctx: 1, inPrice: 0.14, outPrice: 0.28, structured: true },
    { id: 'other/cheap', ctx: 1, inPrice: 0.05, outPrice: 0.1, structured: true },
  ];
  const rec = pickRecommended(all);
  assert.ok(!rec.some(m => m.id === 'x/no-struct'), '不支持结构化输出的不该被推荐');
  assert.equal(rec[0].id, 'deepseek/deepseek-v4-flash', 'DeepSeek 里最便宜的排最前');
  assert.equal(rec[1].id, 'deepseek/deepseek-v4-pro');
  assert.equal(rec[2].id, 'other/cheap', '其它厂商排在 DeepSeek 之后');
});

test('推荐数量有上限', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `v${i}/m`, ctx: 1, inPrice: i, outPrice: i, structured: true,
  }));
  assert.equal(pickRecommended(many, 5).length, 5);
});
