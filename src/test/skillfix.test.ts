/**
 * 一批从真实对局(20260819-180527)里反馈回来的规则/交互问题。
 *
 * 这些都不是"引擎崩了"那种错 —— 每一条都安安静静地跑完了一整局,只是结果不对:
 * 该回的血没回、该由玩家定的顺序被引擎替他定了、装备区里的牌明明能当素材却看不见。
 * 所以每条都得有一个能复现的最小场景钉着。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkGame, give } from './helpers.js';
import type { Player } from '../core/player.js';

/** 把一张牌直接装到某人身上 */
function equip(game: ReturnType<typeof mkGame>['game'], p: Player, name: string, suit: any, rank: number) {
  const c = give(game, p, name, suit, rank);
  p.hand.pop();
  const slot = name.includes('马') ? (name === '进攻马' ? 'horse-1' : 'horse+1')
    : name.includes('盾') || name.includes('阵') ? 'armor' : 'weapon';
  (p.equips as any)[slot] = c;
  return c;
}

// ————————————————— 仁德 —————————————————

test('仁德:给出两张回 1 点体力,每回合限一次', async () => {
  const { game, agents } = mkGame({ 0: '刘备', 1: '甄姬', 2: '关羽' });
  const liu = game.players[0];
  liu.hp = 2;
  give(game, liu, '杀'); give(game, liu, '闪'); give(game, liu, '桃');

  const rende = liu.allSkills.find(s => s.name === '仁德')! as any;
  // 一次给两张 → 回血
  agents[0].chooseCards = async (_g, _s, cards) => cards.slice(0, 2);
  await rende.onUse(game, liu);
  assert.equal(liu.hp, 3, '给满两张就该回 1 血');

  // 同一回合再给,不再回血
  agents[0].chooseCards = async (_g, _s, cards) => cards.slice(0, 1);
  await rende.onUse(game, liu);
  assert.equal(liu.hp, 3, '每回合限一次');
});

test('仁德:张数是本回合累计的,分两次各给一张也算', async () => {
  const { game, agents } = mkGame({ 0: '刘备', 1: '甄姬', 2: '关羽' });
  const liu = game.players[0];
  liu.hp = 2;
  give(game, liu, '杀'); give(game, liu, '闪');
  const rende = liu.allSkills.find(s => s.name === '仁德')! as any;
  agents[0].chooseCards = async (_g, _s, cards) => cards.slice(0, 1);

  await rende.onUse(game, liu);
  assert.equal(liu.hp, 2, '才给一张,还不到两张');
  await rende.onUse(game, liu);
  assert.equal(liu.hp, 3, '累计满两张,回血');
});

test('仁德:换了回合重新计数', async () => {
  const { game, agents } = mkGame({ 0: '刘备', 1: '甄姬', 2: '关羽' });
  const liu = game.players[0];
  liu.hp = 1;
  for (let i = 0; i < 4; i++) give(game, liu, '杀');
  const rende = liu.allSkills.find(s => s.name === '仁德')! as any;
  agents[0].chooseCards = async (_g, _s, cards) => cards.slice(0, 2);

  await rende.onUse(game, liu);
  assert.equal(liu.hp, 2);
  liu.clearMarks('turn:');          // 引擎在回合结束时做的事
  await rende.onUse(game, liu);
  assert.equal(liu.hp, 3, '新回合应该能再回一次');
});

// ————————————————— 离间 —————————————————

test('离间:先选的那名先出【杀】(所以是后选的对先选的使用决斗)', async () => {
  const { game, agents } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '赵云' }, 3);
  const diao = game.players[0], guan = game.players[1], zhao = game.players[2];
  give(game, diao, '闪');
  // 两人都没有杀 —— 谁先被问就是谁先出
  const asked: string[] = [];
  for (const p of [guan, zhao]) {
    agents[p.seat].respond = () => -1;
  }
  const origin = game.askForCard.bind(game);
  (game as any).askForCard = async (p: Player, ...rest: any[]) => {
    asked.push(p.name);
    return origin(p, ...(rest as [any, any, any]));
  };

  const lijian = diao.allSkills.find(s => s.name === '离间')! as any;
  // 先选 关羽、后选 赵云
  agents[0].choosePlayers = async (_g, _s, cands) => [
    cands.find(p => p === guan)!, cands.find(p => p === zhao)!,
  ];
  await lijian.onUse(game, diao);

  assert.equal(asked[0], guan.name, '先选的关羽应该先被要求出【杀】');
  assert.ok(guan.hp < guan.maxHp, '接不上的先出方掉血');
  assert.equal(zhao.hp, zhao.maxHp, '后出方毫发无损');
});

test('离间视为使用的【决斗】不能被【无懈可击】拦', async () => {
  const { game, agents } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '赵云' }, 3);
  const diao = game.players[0];
  give(game, diao, '闪');
  // 三个人都揣着无懈,只要开了窗口就一定会被问到
  for (const p of game.players) give(game, p, '无懈可击', '♠', 3);
  const asked: string[] = [];
  const orig = game.askForNullification.bind(game);
  (game as any).askForNullification = async (...a: any[]) => { asked.push('nullify'); return orig(...(a as [any, any])); };

  const lijian = diao.allSkills.find(s => s.name === '离间')! as any;
  agents[0].choosePlayers = async (_g, _s, cands) => [cands[0], cands[1]];
  for (const p of game.players) agents[p.seat].respond = () => -1;
  await lijian.onUse(game, diao);

  assert.equal(asked.length, 0, '离间的决斗不该开无懈窗口');
});

// ————————————————— 选人的顺序 —————————————————

test('顺序有意义时,候选正好等于人数也必须问玩家', async () => {
  /*
   * 真实事故:场上只剩两名男性时,离间那道"选两名"的题被当成唯一解直接跳过,
   * 于是永远按座位号排 —— 先出【杀】的劣势位固定落在座位靠前的那个人身上,
   * 玩家连点都点不到。组合唯一 ≠ 排列唯一,而这里问的正是排列。
   */
  const { game } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '赵云' }, 3);
  const { ChoiceAgent } = await import('../ai/choiceAgent.js');
  const seen: string[] = [];
  class Probe extends ChoiceAgent {
    readonly id = 'probe';
    protected codecMode = 'verbose' as const;
    protected fallback = { } as any;
    protected async decide(_g: any, _s: any, q: string): Promise<number[]> {
      seen.push(q);
      return [1, 0];                      // 故意反着选
    }
  }
  const probe = new Probe();
  const diao = game.players[0];
  const cands = [game.players[1], game.players[2]];

  const plain = await probe.choosePlayers(game, diao, cands, 2, 2, '随便选两个');
  assert.equal(seen.length, 0, '顺序无所谓时,唯一解照旧直接跳过,别浪费一次交互');
  assert.deepEqual(plain, cands);

  const ordered = await probe.choosePlayers(game, diao, cands, 2, 2, '选两名', { ordered: true });
  assert.equal(seen.length, 1, '顺序有意义就必须问');
  assert.match(seen[0], /按顺序选/, '题面要说清先点的排在前面');
  assert.deepEqual(ordered, [cands[1], cands[0]], '玩家给的顺序要原样生效');
});

// ————————————————— 转化技的素材来自哪里 —————————————————

test('武圣/奇袭/国色 可以拿装备区的牌当素材,倾国不行', () => {
  const cases = [
    { general: '关羽', skill: '武圣', card: ['赤兔马-占位', '♥', 5] as const, produce: '杀' },
    { general: '甘宁', skill: '奇袭', card: ['防御马', '♠', 5] as const, produce: '过河拆桥' },
    { general: '大乔', skill: '国色', card: ['进攻马', '♦', 5] as const, produce: '乐不思蜀' },
  ];
  for (const cs of cases) {
    const { game } = mkGame({ 0: cs.general, 1: '张飞', 2: '黄盖' });
    const me = game.players[0];
    equip(game, me, cs.card[0].replace('赤兔马-占位', '防御马'), cs.card[1], cs.card[2]);
    // 拆桥/乐不思蜀要有个够得着、且身上有牌的目标,否则这条选项本来就不成立
    for (const other of game.others(me)) give(game, other, '闪');
    const usable = (game as any).enumerateUsable(me) as Array<{ label: string }>;
    assert.ok(usable.some(o => o.label.includes(cs.produce) && o.label.includes(cs.skill)),
      `${cs.general} 应该能把装备区那张牌当【${cs.produce}】用,实际选项:${usable.map(o => o.label).join(' ')}`);
  }

  // 倾国写的是"黑色**手牌**",装备区不算
  const { game } = mkGame({ 0: '甄姬', 1: '张飞', 2: '黄盖' });
  const zhen = game.players[0];
  equip(game, zhen, '防御马', '♠', 5);
  const zhenSkill = zhen.allSkills.find(s => s.name === '倾国')! as any;
  const pool = (game as any).viewAsPool(zhen, zhenSkill);
  assert.equal(pool.length, 0, '倾国只能用手牌');
});

// ————————————————— 取消发动 —————————————————

test('中途反悔不吃掉限定次数,战报也说清楚', async () => {
  /*
   * 以前次数是在 onUse **之前**扣的,技能里那些 `if (!chosen.length) return` 的
   * 早退分支于是全都"算发动过了":点了【离间】、发现哪张牌都舍不得弃、退出来,
   * 本回合的机会就没了,而且什么都没发生。
   */
  const { game, agents } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '赵云' }, 3);
  const diao = game.players[0];
  give(game, diao, '闪');
  const lines: string[] = [];
  (game as any).log = (m: string) => lines.push(m);

  // 选牌那一步交空数组 = 取消
  agents[0].chooseCards = async () => [];
  agents[0].playAction = (acts) => acts.findIndex(a => a.kind === 'skill' && a.skill.name === '离间');
  await (game as any).playPhase(diao);

  const lijian = diao.allSkills.find(s => s.name === '离间')!;
  assert.equal(game.skillAvailable(diao, lijian), true, '取消之后本回合还能再发动');
  assert.ok(lines.some(l => l.includes('取消了【离间】')), `战报要说明取消了,实际:${lines.join(' | ')}`);
});

test('取消不能靠"把 min 调成 0"表达 —— 规则 AI 会当真', async () => {
  /*
   * 真实事故:为了给界面一颗"取消"按钮,把可取消的选牌题 min 调成 0。
   * 规则 AI 的 chooseCards 就是返回 min 张 —— 于是它每次都交空数组、每次都取消,
   * 出牌阶段空转到 guard 上限,8 人局 200 局从 1.4s 涨到 2.3s。
   * 所以旗标必须是 agent 可以**忽略**的那种。
   */
  const { game, agents } = mkGame({ 0: '孙权', 1: '关羽', 2: '赵云' }, 3);
  const sun = game.players[0];
  give(game, sun, '杀'); give(game, sun, '闪');
  let askedMin = -1;
  agents[0].chooseCards = async (_g, _s, cards, min) => { askedMin = min; return cards.slice(0, min); };
  const zhiheng = sun.allSkills.find(s => s.name === '制衡')! as any;
  await zhiheng.onUse(game, sun);
  assert.ok(askedMin >= 1, `规则 AI 拿到的下限应该还是真实下限,实际 ${askedMin}`);
  assert.equal(sun.hand.length, 2, '制衡弃几张摸几张');
});

// ————————————————— 界面收到的题面 —————————————————

test('WebAgent 不会把 ordered / cancelable 吃掉', async () => {
  /*
   * 这两个旗标要穿过 WebAgent → ChoiceAgent 两层。TypeScript 不会报错(参数是可选的),
   * 漏传就是静默失效:离间的选人顺序标不出来、取消按钮变回"放弃"。
   */
  const { game } = mkGame({ 0: '貂蝉', 1: '关羽', 2: '赵云' }, 3);
  const { WebAgent } = await import('../web/webAgent.js');
  const me = game.players[0];
  give(game, me, '杀'); give(game, me, '闪');

  const web = new WebAgent('you');
  const seen: any[] = [];
  const grab = () => new Promise(r => { const t = setInterval(() => {
    if (web.pending) { clearInterval(t); seen.push(web.pending); r(null); }
  }, 1); });

  const pl = web.choosePlayers(game, me, [game.players[1], game.players[2]], 2, 2, '选两名', { ordered: true });
  await grab();
  assert.equal(seen[0].ordered, true, 'ordered 没传到界面');
  assert.equal(seen[0].min, 2, '顺序题不是"可以不选"');
  web.submit([1, 0]);
  assert.deepEqual((await pl).map(p => p.seat), [2, 1], '玩家给的顺序要原样生效');

  const cd = web.chooseCards(game, me, [...me.hand], 1, 1, '弃一张', { cancelable: true });
  await grab();
  assert.equal(seen[1].cancel, true, 'cancelable 没传到界面');
  assert.equal(seen[1].min, 0, '可取消 = 允许交空数组');
  web.submit([]);
  assert.deepEqual(await cd, [], '空数组就是取消');
});

// ————————————————— 反馈里"待验证"的两条 —————————————————

test('借刀杀人:先选的那名对后选的那名出【杀】,不出就交武器', async () => {
  /*
   * 反馈里担心方向反了。实现上它是**两步选人**:牌本身只指定一个目标(有武器的那位),
   * 再单独问"令他杀谁" —— 所以先选后选的关系是明确的,不存在两目标排序的歧义。
   */
  const { game, agents } = mkGame({ 0: '甄姬', 1: '关羽', 2: '赵云' }, 3);
  const [me, holder, victim] = game.players;
  const weapon = give(game, holder, '青龙偃月刀', '♠', 5);
  holder.hand.pop();
  (holder.equips as any).weapon = weapon;

  const spec = (await import('../core/registry.js')).cardSpecs.get('借刀杀人')!;
  const card = give(game, me, '借刀杀人', '♣', 5);
  agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === victim)!];

  // 有武器的那位拒绝出杀 → 武器归使用者
  agents[holder.seat].respond = () => -1;
  await spec.onEffect!({ game, use: game.makeUse({ name: '借刀杀人', suit: '♣', rank: 5, cards: [card] }, me, [holder]), from: me, to: holder } as any);
  assert.equal(holder.equips.weapon, undefined, '拒绝就要交出武器');
  assert.ok(me.hand.some(c => c.id === weapon.id), '武器归【借刀杀人】的使用者');
});

test('龙胆:被要求打出【杀】时能把【闪】转过去', async () => {
  /*
   * 反馈里问"赵云是不是从来没发动过技能"。查日志那一次(南蛮入侵)他手上是
   * 闪电和防御马,确实没有杀也没有闪 —— 不是技能没接上。这里把接线钉住。
   */
  const { game } = mkGame({ 0: '赵云', 1: '关羽', 2: '甄姬' }, 3);
  const zhao = game.players[0];
  give(game, zhao, '闪', '♦', 2);
  const opts = game.enumerateResponses(zhao, { names: ['杀'] }, { mode: 'respond' });
  assert.ok(opts.some((o: any) => o.label.includes('杀') && o.label.includes('龙胆')),
    `应该能把闪当杀打出,实际:${opts.map((o: any) => o.label).join(' ')}`);
});

test('反复取消不会把出牌阶段卡死', async () => {
  /*
   * 取消不扣次数是对的,但"可以无限重选"就成了死循环:
   * 点技能 → 取消 → 技能又回到菜单 → 再点。真实事故:llm.test 里那个
   * 总是返回最少张数的假客户端每次都取消,一个文件从 29s 变成跑不完。
   * 给两次反悔的余地,超了就把它从本阶段菜单里摘掉(下回合照常)。
   */
  const { game, agents } = mkGame({ 0: '孙权', 1: '关羽', 2: '赵云' }, 3);
  const sun = game.players[0];
  give(game, sun, '闪'); give(game, sun, '闪');
  const lines: string[] = [];
  (game as any).log = (m: string) => lines.push(m);

  let picks = 0;
  agents[0].chooseCards = async () => [];                       // 永远取消
  agents[0].playAction = (acts) => {
    const i = acts.findIndex(a => a.kind === 'skill' && a.skill.name === '制衡');
    if (i >= 0) { picks++; return i; }
    return acts.length - 1;                                     // 菜单里没有了就结束
  };
  await (game as any).playPhase(sun);

  assert.equal(picks, 2, `应该只让他反悔 2 次,实际点了 ${picks} 次`);
  assert.ok(lines.some(l => l.includes('本阶段不再提示')), '摘掉时要说一声');
  const zhiheng = sun.allSkills.find(s => s.name === '制衡')!;
  assert.equal(game.skillAvailable(sun, zhiheng), true, '次数始终没有被消耗');
});
