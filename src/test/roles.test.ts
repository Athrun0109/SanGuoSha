/**
 * 手动指定身份 —— 测试用的口子。
 *
 * "我想看内奸在 1 号位怎么打"这类实验,靠碰运气开局要跑很多次才轮得到一次。
 * 这里锁三件事:
 *  1. **不指定时行为一字不变**(0 号位主公,其余按 seed 打乱)。这条最重要 ——
 *     以前所有用 seed 记下来的胜率数据不能因为加了这个功能就失效。
 *  2. 指定之后剩余身份**仍然由 seed 决定**,同一份配置开出来的局是同一局。
 *  3. 指定错了要报清楚错在哪,而不是开出一局身份不合法的牌。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import '../content/cards.js';
import '../content/generals.js';
import { createGame, resolveRoles, parseRoleSpec, ROLE_TABLE } from '../core/setup.js';
import { RNG } from '../core/game.js';
import { BasicAI } from '../ai/basicAI.js';
import type { Role } from '../core/types.js';

function mk(n: number, fixedRoles?: Record<number, Role>, seed = 20260814) {
  return createGame({
    playerCount: n, seed, fixedRoles,
    log: () => {},
    makeAgent: (_p, i) => new BasicAI(`ai${i}`),
  });
}
/** 一局身份的多重集,和 ROLE_TABLE 比对用 */
const bag = (rs: Role[]) => rs.slice().sort().join(',');

test('不指定身份时,行为和以前一字不变', () => {
  for (const n of [2, 3, 5, 8]) {
    const g = mk(n);
    assert.equal(g.players[0].role, 'lord', `${n} 人局 0 号位应该是主公`);
    assert.equal(bag(g.players.map(p => p.role)), bag(ROLE_TABLE[n]));
    // 同一个 seed 必须开出同一局 —— 老的胜率数据才有意义
    assert.deepEqual(mk(n).players.map(p => p.role), g.players.map(p => p.role));
  }
});

test('可以把内奸钉在指定座位', () => {
  const g = mk(5, { 1: 'renegade' });
  assert.equal(g.players[1].role, 'renegade');
  assert.equal(bag(g.players.map(p => p.role)), bag(ROLE_TABLE[5]),
    '其余座位仍然要凑成一副合法身份');
});

test('主公可以不坐 0 号位,先手跟着主公走', () => {
  const g = mk(3, { 2: 'lord' });
  assert.equal(g.players[2].role, 'lord');
  assert.equal(g.current, g.players[2], '主公先手,不能写死 players[0]');
  assert.equal(g.players[2].revealed, true, '主公开局就明示');
  assert.equal(g.players[0].revealed, false);
  assert.ok(g.players[2].maxHp > g.players[2].general.hp, '主公 +1 体力上限跟着身份走');
});

test('全部座位都指定时,完全照办', () => {
  const spec: Record<number, Role> = { 0: 'rebel', 1: 'lord', 2: 'renegade' };
  assert.deepEqual(mk(3, spec).players.map(p => p.role), ['rebel', 'lord', 'renegade']);
});

test('剩余身份仍然由 seed 决定,同配置可复现', () => {
  const a = mk(8, { 3: 'renegade' }, 999);
  const b = mk(8, { 3: 'renegade' }, 999);
  assert.deepEqual(a.players.map(p => p.role), b.players.map(p => p.role));
  const c = mk(8, { 3: 'renegade' }, 1000);
  assert.notDeepEqual(c.players.map(p => p.role), a.players.map(p => p.role),
    '换 seed 应该开出不同的局');
});

test('指定超额会报错,并说明本局的身份配置', () => {
  // 5 人局只有 2 个反贼
  assert.throws(() => mk(5, { 0: 'rebel', 1: 'rebel', 2: 'rebel' }), (e: Error) => {
    assert.match(e.message, /反贼/);
    assert.match(e.message, /只有 2 个/);
    assert.match(e.message, /5 人局的身份配置/, '要把本局配置摆出来,不然不知道该怎么改');
    return true;
  });
  // 3 人局没有忠臣
  assert.throws(() => mk(3, { 1: 'loyalist' }), /忠臣 指定多了 —— 本局只有 0 个/);
  // 两个主公
  assert.throws(() => mk(5, { 0: 'lord', 1: 'lord' }), /主公 指定多了/);
});

test('座位越界报错', () => {
  assert.throws(() => mk(3, { 5: 'rebel' }), /没有 5 号位.*0~2/s);
});

test('身份串中英文都认,空位表示随机', () => {
  assert.deepEqual(parseRoleSpec('主公,内奸,,反贼', 5), { 0: 'lord', 1: 'renegade', 3: 'rebel' });
  assert.deepEqual(parseRoleSpec('lord,RENEGADE', 5), { 0: 'lord', 1: 'renegade' });
  assert.deepEqual(parseRoleSpec('主,反,忠,内', 4),
    { 0: 'lord', 1: 'rebel', 2: 'loyalist', 3: 'renegade' });
  assert.equal(parseRoleSpec(undefined, 5), undefined);
  assert.equal(parseRoleSpec(',,', 5), undefined, '全是空位等于没指定');
  assert.throws(() => parseRoleSpec('主公,间谍', 5), /不认识的身份:间谍/);
  // 超出人数的部分直接忽略,不报错
  assert.deepEqual(parseRoleSpec('主公,反贼,反贼', 2), { 0: 'lord', 1: 'rebel' });
});

test('名额不对在解析时就拦下,不等到开局才炸', () => {
  // 留到 createGame 才抛的话,横幅已经打出去了,而且是个未捕获的堆栈,
  // 看着像 bug 而不是"参数写错了"
  assert.throws(() => parseRoleSpec('反贼,反贼,反贼', 5), /反贼 指定多了 —— 本局只有 2 个/);
  assert.throws(() => parseRoleSpec('主公,主公', 5), /主公 指定多了/);
  assert.doesNotThrow(() => parseRoleSpec('反贼,反贼', 5), '正好用满名额是合法的');
});

test('resolveRoles 不吃掉多余的随机数 —— 未指定时和原实现同流', () => {
  // 原实现:rng.shuffle(table.slice(1))。换了实现之后这条流不能变,
  // 否则同一个 seed 的牌堆会跟着漂移(发牌用的是同一个 rng)
  const table = ROLE_TABLE[5];
  const expect: Role[] = ['lord', ...new RNG(7).shuffle(table.slice(1))];
  assert.deepEqual(resolveRoles(5, new RNG(7)), expect);
});
