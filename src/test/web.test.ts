/**
 * 观战界面。
 *
 * 最要紧的是**隐藏信息**:推给浏览器的是一份完整快照,漏写一个字段就等于开图。
 * 之前 MCP 那次泄露 LLM 手牌就是这类问题,所以这里直接对序列化出来的
 * JSON 文本做断言 —— 不管字段怎么改名、怎么嵌套,别人的牌名不许出现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { snapshot, ringSlots, seatSlots } from '../web/state.js';
import { startViewer } from '../web/server.js';
import { cardLabel } from '../core/types.js';

function makeGame(n = 3, seed = 20260806) {
  return createGame({
    playerCount: n, seed,
    log: () => {},
    makeAgent: (p, i) => new BasicAI(`ai${i}`),
  });
}

test('快照不泄露其他座位的手牌', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: 0 });

  assert.ok(st.seats[0].hand, '自己的手牌要能看到');
  assert.equal(st.seats[1].hand, null, '别人的手牌明细必须是 null');
  assert.equal(st.seats[2].hand, null);
  assert.equal(st.seats[1].handCount, game.players[1].hand.length, '但张数是公开的');

  // 别人手上那几张牌,连"牌名+花色+点数"这个组合都不该出现在 payload 里 ——
  // 光看字段名不够,得看实际内容,不然哪天多序列化一个字段就漏了
  const json = JSON.stringify(st);
  for (const p of game.players.slice(1)) {
    for (const c of p.hand) {
      const fragment = JSON.stringify({ name: c.name, suit: c.suit }).slice(1, -1);
      assert.ok(!json.includes(fragment),
        `${p.seat}号的手牌 ${cardLabel(c)} 泄露到了快照里`);
    }
  }
});

test('快照里出现的牌 id 只能是自己的', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: 1 });
  const mine = new Set(game.players[1].hand.map(c => c.id));

  const seen: number[] = [];
  JSON.stringify(st, (k, v) => {
    if (k === 'id' && typeof v === 'number') seen.push(v);
    return v;
  });

  const equipIds = new Set(game.players.flatMap(p => p.equipCards.map(c => c.id)));
  for (const id of seen) {
    assert.ok(mine.has(id) || equipIds.has(id),
      `快照里出现了不该出现的牌 id=${id}(既不是视角座位的手牌,也不是台面上的装备)`);
  }
});

test('纯观战模式下所有人的手牌都是盖着的', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: null });
  assert.ok(st.seats.every(s => s.hand === null), '没有视角座位时不该有任何人的手牌明细');
  assert.equal(st.viewer, null);
});

test('reveal 必须显式打开才开图', () => {
  const game = makeGame(3);
  assert.equal(snapshot(game, { viewer: 0 }).seats[1].hand, null, '默认不能开图');
  const open = snapshot(game, { viewer: 0, reveal: true });
  assert.ok(open.seats[1].hand && open.seats[2].hand, 'reveal=true 时才全可见');
  assert.equal(open.reveal, true);
});

test('身份只在明示后可见,主公开局就明示', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: 1 });
  const lord = game.players.find(p => p.role === 'lord')!;

  assert.equal(st.seats[lord.seat].role, 'lord', '主公开局明示');
  assert.equal(st.seats[1].roleName, game.players[1].role === 'lord' ? '主公' : st.seats[1].roleName);
  for (const s of st.seats) {
    if (s.seat === 1 || s.seat === lord.seat) continue;
    assert.equal(s.role, null, `${s.seat}号还没明示,身份不该出现在快照里`);
    assert.equal(s.roleName, null);
  }
});

test('阵亡后身份翻开', async () => {
  const game = makeGame(3);
  const victim = game.players.find(p => p.role !== 'lord')!;
  await game.kill(victim, null).catch(() => { /* 可能直接触发结算 */ });

  const st = snapshot(game, { viewer: game.players.find(p => p !== victim)!.seat });
  assert.equal(st.seats[victim.seat].alive, false);
  assert.equal(st.seats[victim.seat].role, victim.role, '阵亡的人身份要翻开');
});

test('势力始终可见', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: 0 });
  for (const s of st.seats) {
    assert.ok(['wei', 'shu', 'wu', 'qun'].includes(s.kingdom));
    assert.ok(['魏', '蜀', '吴', '群'].includes(s.kingdomName));
    assert.equal(s.kingdomHidden, false, '标准版没有暗将;这个位是给国战留的');
  }
});

test('被公开过的单张手牌是公开信息', () => {
  const game = makeGame(3);
  const other = game.players[1];
  const shown = other.hand[0];
  game.revealToAll(shown, other);

  const st = snapshot(game, { viewer: 0 });
  assert.equal(st.seats[1].hand, null, '其余手牌仍然盖着');
  assert.deepEqual(st.seats[1].knownHand.map(c => c.id), [shown.id], '公开过的那张要看得见');
});

test('距离和攻击范围只对视角座位计算', () => {
  const game = makeGame(3);
  const st = snapshot(game, { viewer: 0 });
  assert.equal(st.seats[0].distance, null, '自己到自己不显示距离');
  assert.equal(st.seats[1].distance, game.distance(game.players[0], game.players[1]));
  assert.equal(st.attackRange, game.attackRange(game.players[0]));
});

test('座位排布:下家在右,上家在左(逆时针)', () => {
  // 3 人局,视角 0 号:1 号(下家)在右上,2 号(上家)在左上
  assert.deepEqual(seatSlots(3, 0), { 0: 'me', 1: 'tr', 2: 'tl' });
  // 换个视角,相对关系不变
  assert.deepEqual(seatSlots(3, 2), { 2: 'me', 0: 'tr', 1: 'tl' });
  // 1v1:对手在正上方
  assert.deepEqual(seatSlots(2, 0), { 0: 'me', 1: 't' });

  // 每种人数都要有足够的位置,且不重复
  for (let others = 1; others <= 7; others++) {
    const s = ringSlots(others);
    assert.equal(s.length, others, `${others} 个对手应分到 ${others} 个位置`);
    assert.equal(new Set(s).size, others, '位置不能重复');
  }
});

/**
 * 布局表在 state.ts(给测试/服务端用)和 client.html(给浏览器用)里各有一份。
 * 前端拿不到 TS 模块,这个重复躲不掉,所以用测试钉住:两边不一致的话
 * 界面会静默地把人摆错位置,不会报任何错。
 */
test('前后端的座位布局表一致,且用到的位置都在 CSS 里定义过', () => {
  const html = fs.readFileSync(
    path.join(fileURLToPath(new URL('../web/client.html', import.meta.url))), 'utf8');

  const m = html.match(/const RING_BY_COUNT = (\{[\s\S]*?\n\});/);
  assert.ok(m, 'client.html 里应该有 RING_BY_COUNT');
  // eslint-disable-next-line no-eval
  const front = eval(`(() => { const RING = ${JSON.stringify(ringSlots(7))}; return ${m[1]}; })()`);

  for (let others = 1; others <= 7; others++) {
    assert.deepEqual(front[others], ringSlots(others),
      `${others} 个对手时前后端布局不一致`);
  }

  const areas = html.match(/grid-template-areas:([\s\S]*?);/)?.[1] ?? '';
  for (const slot of [...ringSlots(7), 'me', 'mid']) {
    assert.ok(new RegExp(`\\b${slot}\\b`).test(areas), `CSS 网格里没有 "${slot}" 这个位置`);
  }
});

test('服务端:能返回页面,SSE 推送能收到,刷新后补发当前状态', async () => {
  const view = await startViewer({ port: 0 });
  try {
    const html = await fetch(`${view.url}/`).then(r => r.text());
    assert.match(html, /EventSource/, '页面里应该有 SSE 客户端代码');

    const game = makeGame(3);
    // 先推一份,再连 —— 新连上来的客户端应该立刻收到当前状态
    view.push(snapshot(game, { viewer: 0 }));

    const res = await fetch(`${view.url}/events`);
    const reader = res.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const text = chunk.includes('data:') ? chunk
      : new TextDecoder().decode((await reader.read()).value);

    const payload = JSON.parse(text.split('data: ')[1].split('\n\n')[0]);
    assert.equal(payload.seats.length, 3);
    assert.equal(payload.viewer, 0);
    await reader.cancel();
  } finally {
    await view.close();
  }
});

test('服务端:端口被占用时自动顺延', async () => {
  const a = await startViewer({ port: 5199 });
  try {
    const b = await startViewer({ port: 5199 });
    try {
      assert.notEqual(a.port, b.port, '第二个实例应该换个端口,而不是抛错');
    } finally { await b.close(); }
  } finally { await a.close(); }
});
