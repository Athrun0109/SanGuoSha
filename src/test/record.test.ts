/**
 * 记录与重放。
 *
 * 核心的一条:**记录器不能改变牌局**。这是整套工具能用的前提 ——
 * 如果开着记录跑出来的对局和不开时不一样,那记下来的东西就没有参考价值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { Recorder, strip } from '../log/recorder.js';
import { loadLog, replay, ReplayScript, ReplayAgent } from '../log/replay.js';
import type { Game } from '../core/game.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-rec-'));
}

/** 跑一局 8 人纯 AI 局;record=true 时全程记录 */
async function runGame(seed: number, dir?: string) {
  const lines: string[] = [];
  const rec = dir ? new Recorder({ dir }) : null;
  const game = createGame({
    playerCount: 8,
    seed,
    log: rec ? rec.logFn(m => lines.push(strip(m))) : (m) => lines.push(strip(m)),
    makeAgent: (p, i) => {
      const a = new BasicAI(`ai${i}`);
      return rec ? rec.wrap(a) : a;
    },
  });
  if (rec) { rec.bind(game); rec.start({ seed, playerCount: 8 }); }
  const res = await game.setupAndRun();
  if (rec) {
    rec.finish({ reason: res.reason, winners: res.winners.map(p => p.seat), turns: game.turnCount });
    rec.close();
  }
  return { game, res, lines, rec };
}

test('记录器不改变牌局走向', async () => {
  const dir = tmpdir();
  try {
    const plain = await runGame(4242);
    const taped = await runGame(4242, dir);
    assert.deepEqual(taped.lines, plain.lines, '开记录和不开记录必须跑出一模一样的战报');
    assert.equal(taped.res.reason, plain.res.reason);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('记录内容完整:每次决策都有 ask/answer 配对,战报一行不少', async () => {
  const dir = tmpdir();
  try {
    const { rec, lines, game } = await runGame(777, dir);
    const log = loadLog(rec!.file);

    assert.deepEqual(log.logLines, lines, '记录里的战报应与引擎输出逐行一致');
    assert.ok(log.decisions.length > 30, `决策数太少:${log.decisions.length}`);
    assert.equal(log.meta.seed, 777);
    assert.equal(log.setup?.players.length, 8);
    assert.ok(log.end, '应有 end 事件');
    assert.equal(log.end!.turns, game.turnCount);

    // 每条决策的下标都必须落在当时的选项范围内
    for (const d of log.decisions) {
      for (const i of d.choice) {
        assert.ok(i >= 0 && i < d.options.length,
          `${d.kind} 的下标 ${i} 越界(共 ${d.options.length} 项)`);
      }
    }
    // 起手手牌要记下来 —— 排查"它为什么不出杀"全靠这个
    assert.ok((log.setup!.players[0].hand as string[]).length > 0);
    // 换回合时自动落一张快照
    assert.ok(log.events.some(e => e.type === 'state' && e.players?.[0]?.hand));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('重放能逐行复现原局', async () => {
  const dir = tmpdir();
  try {
    const { rec } = await runGame(20260805, dir);
    const r = await replay(rec!.file);

    assert.equal(r.error, null);
    assert.deepEqual(r.script.divergences, [], '同一份代码重放不该有任何分叉');
    assert.equal(r.firstDiff, null,
      `第 ${r.firstDiff?.line} 行开始不同:\n  原:${r.firstDiff?.was}\n  现:${r.firstDiff?.now}`);
    assert.deepEqual(r.newLines, r.log.logLines);
    assert.equal(r.script.consumed, r.script.total, '记录里的决策应被全部用掉');
    assert.equal(r.game.winners.map(p => p.seat).join(','), (r.log.end!.winners as number[]).join(','));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('崩溃的局也能落盘并被解析(不会因为缺 end 就读不出来)', async () => {
  const dir = tmpdir();
  try {
    const rec = new Recorder({ dir });
    const game = createGame({
      playerCount: 2, seed: 5,
      log: rec.logFn(),
      makeAgent: (p, i) => rec.wrap(new BasicAI(`ai${i}`)),
    });
    rec.bind(game);
    rec.start({ seed: 5, playerCount: 2 });
    // 模拟进程中途被掐掉:不调 finish,直接读文件
    game.log('打到一半');

    const log = loadLog(rec.file);
    assert.equal(log.end, null);
    assert.ok(log.logLines.includes('打到一半'));
    assert.equal(log.meta.seed, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('脚本对不上时退回规则 AI,并记下分叉点', async () => {
  const dir = tmpdir();
  try {
    const { rec } = await runGame(31337, dir);
    const log = loadLog(rec!.file);

    // 砍掉后一半决策,模拟"代码改了导致决策变多"
    const half = log.decisions.slice(0, Math.floor(log.decisions.length / 2));
    const script = new ReplayScript(half);
    const game = createGame({
      playerCount: 8, seed: 31337,
      log: () => {},
      makeAgent: (p, i) => new ReplayAgent(`r${i}`, i, script) as any,
    });
    await game.setupAndRun();

    assert.ok(script.divergences.length > 0, '记录被砍短后应该报出分叉');
    assert.match(script.divergences[0], /记录已用完/);
    assert.ok(game.winners.length >= 0, '分叉之后牌局仍要能跑完,而不是抛错');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('观星这类"排序型"决策也能原样重放', async () => {
  const dir = tmpdir();
  try {
    // 诸葛亮必然触发观星,顺便覆盖 arrange 的 top/bottom 顺序还原
    const rec = new Recorder({ dir });
    const lines: string[] = [];
    const game: Game = createGame({
      playerCount: 2, seed: 99, fixedGenerals: { 0: '诸葛亮', 1: '张飞' },
      log: rec.logFn(m => lines.push(strip(m))),
      makeAgent: (p, i) => rec.wrap(new BasicAI(`ai${i}`)),
    });
    rec.bind(game);
    rec.start({ seed: 99, playerCount: 2, fixedGenerals: { 0: '诸葛亮', 1: '张飞' } });
    const res = await game.setupAndRun();
    rec.finish({ reason: res.reason, winners: res.winners.map(p => p.seat), turns: game.turnCount });
    rec.close();

    const log = loadLog(rec.file);
    const arranges = log.decisions.filter(d => d.kind === 'arrange');
    assert.ok(arranges.length > 0, '诸葛亮这一局应该出现观星');
    assert.ok(arranges.every(d => typeof d.split === 'number'), 'arrange 必须记下 top/bottom 的分界');

    const r = await replay(rec.file);
    assert.equal(r.firstDiff, null,
      `观星局重放不一致(第 ${r.firstDiff?.line} 行):\n  原:${r.firstDiff?.was}\n  现:${r.firstDiff?.now}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 这条是被重放工具逼出来的:BasicAI.chooseSuit 原先取的是 game.rng,
 * 于是"AI 随手选个花色"顺带把洗牌序列拨走一格。后果有两个 ——
 * 重放从此对不上(下标能还原,rng 的消耗还原不了),
 * 而且换个 AI 就等于换了副牌,AI 之间的胜率对比也不干净。
 * 现在 AI 走 agentRng 开的独立流。
 */
test('AI 的随机决策不消耗牌局的随机流', async () => {
  const dir = tmpdir();
  try {
    // 周瑜的反间会先让对手选花色(AI 随机),再随机展示一张手牌
    const rec = new Recorder({ dir });
    const cfg = { playerCount: 2 as const, seed: 20260123, fixedGenerals: { 0: '周瑜', 1: '许褚' } };
    const game = createGame({
      ...cfg,
      log: rec.logFn(),
      makeAgent: (p, i) => rec.wrap(new BasicAI(`ai${i}`)),
    });
    rec.bind(game);
    rec.start(cfg);
    const res = await game.setupAndRun();
    rec.finish({ reason: res.reason, winners: res.winners.map(p => p.seat), turns: game.turnCount });
    rec.close();

    const log = loadLog(rec.file);
    assert.ok(log.decisions.some(d => d.kind === 'suit'), '这一局应触发反间的选花色');

    const r = await replay(rec.file);
    assert.equal(r.firstDiff, null,
      `含随机决策的一局重放不一致(第 ${r.firstDiff?.line} 行):\n` +
      `  原:${r.firstDiff?.was}\n  现:${r.firstDiff?.now}`);
    assert.deepEqual(r.script.divergences, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('同一局里换掉 AI 不会改变发牌', async () => {
  const deal = (id: string) => {
    const g = createGame({
      playerCount: 4, seed: 606,
      log: () => {},
      makeAgent: (p, i) => new BasicAI(`${id}${i}`),
    });
    return g.players.map(p => p.hand.map(c => c.id).join(','));
  };
  assert.deepEqual(deal('alpha'), deal('beta'), 'agent 的 id 变了,起手牌不该跟着变');
});

test('ANSI 颜色码不会进日志文件', () => {
  assert.equal(strip('\x1b[31m红\x1b[0m字'), '红字');
  assert.equal(strip('\x1b[1;36m多段\x1b[0m'), '多段');
  assert.equal(strip('没有颜色'), '没有颜色');
});
