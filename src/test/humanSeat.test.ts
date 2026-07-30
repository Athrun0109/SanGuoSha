/**
 * 人机同桌:Claude 一个座位,真人一个座位,双方各自作答。
 * 重点验证两件事:轮到谁引擎才问谁(不会自己跑完),以及各自只看得到自己该看到的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import '../content/cards.js';
import '../content/generals.js';
import { GameSession } from '../mcp/session.js';
import { cardLabel } from '../core/types.js';

/**
 * 假"真人"客户端。auto=false 时收到提问不作答 ——
 * 牌局会冻结在那一刻,方便对着稳定的状态做断言(顺便也验证了引擎确实在等人)。
 */
function fakeHuman(port: number, auto = true) {
  const asks: any[] = [];
  const logs: string[] = [];
  let over: string | null = null;
  const sock = net.createConnection({ port, host: '127.0.0.1' });
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk: string | Buffer) => {
    buf += String(chunk);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.type === 'log') logs.push(m.line);
      else if (m.type === 'over') over = m.text;
      else if (m.type === 'ask') {
        asks.push(m);
        if (auto) answer(m);
      }
    }
  });
  const answer = (m: any) => {
    const k = Math.min(m.min, m.options.length);
    sock.write(JSON.stringify({
      type: 'answer', id: m.id, choice: Array.from({ length: k }, (_, j) => j),
    }) + '\n');
  };
  return {
    asks, logs, answer,
    get over() { return over; },
    close: () => sock.destroy(),
    ready: new Promise<void>(r => sock.once('connect', () => r())),
  };
}

const handLine = (view: string) => view.split('\n').find(l => l.startsWith('你的手牌')) ?? '';

/**
 * 等到条件成立。
 * 必须用真实定时器 —— settle() 走的是 microtask,光靠 await 它不会让 socket 有机会投递数据。
 */
async function waitUntil(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
}

/** Claude 侧一路选前 min 个,把牌局推到底 */
async function driveClaude(session: GameSession, maxSteps = 500): Promise<number> {
  let n = 0;
  for (let i = 0; i < maxSteps && !session.over; i++) {
    if (!(await session.settle(8000))) break;
    if (session.over) break;
    const p = session.pending!;
    session.submit(Array.from({ length: Math.min(p.min, p.options.length) }, (_, j) => j));
    n++;
    if (n % 20 === 0) await new Promise(r => setTimeout(r, 0)); // 让出一次 I/O
  }
  return n;
}

test('真人座位会真的被问到,牌局在他作答前不会自己往下跑', async () => {
  const session = new GameSession({ players: 2, seat: 0, humanSeat: 1, seed: 99 });
  assert.ok(session.hub, '设了 humanSeat 就该有 hub');
  const port = await session.hub!.listen(0);
  assert.ok(port > 0);

  const human = fakeHuman(port);
  await human.ready;
  try {
    const claudeDecisions = await driveClaude(session);

    assert.ok(session.over, '牌局应该打完');
    assert.ok(claudeDecisions > 5, `Claude 侧应做过多次决策,实际 ${claudeDecisions}`);
    assert.ok(human.asks.length > 5, `真人侧应被问过多次,实际 ${human.asks.length}`);
    assert.ok(human.logs.length > 10, '真人应能实时收到公开战报');
    assert.ok(await waitUntil(() => human.over !== null), '结束时真人应收到结算');
    assert.ok(/游戏结束/.test(human.over!));
  } finally {
    human.close();
    session.hub!.close();
  }
});

test('两边各自只看到自己的手牌', async () => {
  const session = new GameSession({ players: 2, seat: 0, humanSeat: 1, seed: 99 });
  const port = await session.hub!.listen(0);
  const human = fakeHuman(port, false);   // 不作答 → 牌局会停在真人这一步
  await human.ready;
  try {
    void driveClaude(session);
    assert.ok(await waitUntil(() => human.asks.length > 0), '真人应该被问到过');

    // 此刻牌局冻结在等真人作答,双方状态稳定
    const [claude, me] = session.game.players;
    const humanHand = handLine(human.asks[0].view);
    const claudeHand = handLine(session.render());
    assert.ok(session.hub!.waiting, '此刻牌局应该正卡在等真人作答');

    for (const c of me.hand) {
      assert.ok(humanHand.includes(cardLabel(c)), `真人视图缺少自己的牌 ${cardLabel(c)}`);
    }
    for (const c of claude.hand) {
      assert.ok(claudeHand.includes(cardLabel(c)), `Claude 视图缺少自己的牌 ${cardLabel(c)}`);
    }
    for (const c of claude.hand.filter(x => !me.hand.some(y => y.id === x.id))) {
      assert.ok(!humanHand.includes(cardLabel(c)), `真人视图泄漏了对手的牌 ${cardLabel(c)}`);
    }
    for (const c of me.hand.filter(x => !claude.hand.some(y => y.id === x.id))) {
      assert.ok(!claudeHand.includes(cardLabel(c)), `Claude 视图泄漏了真人的牌 ${cardLabel(c)}`);
    }
    assert.notEqual(humanHand, claudeHand);
  } finally {
    human.close();
    session.hub!.close();
  }
});

test('真人没接入时,Claude 侧被告知在等人而不是报错', async () => {
  const session = new GameSession({ players: 2, seat: 0, humanSeat: 1, seed: 7 });
  await session.hub!.listen(0);
  try {
    for (let i = 0; i < 50; i++) {
      if (!(await session.settle(1200))) break;
      if (session.over) break;
      const p = session.pending!;
      session.submit(Array.from({ length: Math.min(p.min, p.options.length) }, (_, j) => j));
    }
    const view = session.render();
    assert.ok(/在等人类玩家加入|对手正在行动中/.test(view), `应提示在等对手:\n${view.slice(-300)}`);
    assert.ok(!session.over, '不该因为没人接入就结束');
  } finally {
    session.hub!.close();
  }
});

test('唯一合法解的决策会被自动跳过,不占交互', async () => {
  const session = new GameSession({ players: 2, seat: 0, seed: 1234 });
  const seen: Array<{ n: number; min: number; max: number }> = [];
  for (let step = 0; step < 500 && !session.over; step++) {
    if (!(await session.settle(5000))) break;
    if (session.over) break;
    const p = session.pending!;
    seen.push({ n: p.options.length, min: p.min, max: p.max });
    session.submit(Array.from({ length: Math.min(p.min, p.options.length) }, (_, i) => i));
  }
  assert.ok(seen.length > 5);
  assert.deepEqual(
    seen.filter(s => s.n === s.min && s.min === s.max), [],
    '强制唯一解不该再被问出来',
  );
});
