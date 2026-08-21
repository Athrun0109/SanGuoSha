/**
 * 一批从真实对局(20260819-180527)里反馈回来的规则/交互问题。
 *
 * 这些都不是"引擎崩了"那种错 —— 每一条都安安静静地跑完了一整局,只是结果不对:
 * 该回的血没回、该由玩家定的顺序被引擎替他定了、装备区里的牌明明能当素材却看不见。
 * 所以每条都得有一个能复现的最小场景钉着。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkGame, give, stackDeck } from './helpers.js';
import { KEJI_HAND_CAP } from '../content/generals.js';
import { CANCEL_LIMIT } from '../core/game.js';
import type { Player } from '../core/player.js';
import { realCard, viewAsCard } from '../core/types.js';

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
   * 给几次反悔的余地(CANCEL_LIMIT),超了就把它从本阶段菜单里摘掉(下回合照常)。
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

  assert.equal(picks, CANCEL_LIMIT, `应该只让他反悔 ${CANCEL_LIMIT} 次,实际点了 ${picks} 次`);
  assert.ok(lines.some(l => l.includes('本阶段不再提示')), '摘掉时要说一声');
  const zhiheng = sun.allSkills.find(s => s.name === '制衡')!;
  assert.equal(game.skillAvailable(sun, zhiheng), true, '次数始终没有被消耗');
});

// ————————————————— 卡牌层:对照官方效果原文查出来的 —————————————————

test('借刀杀人:不能逼人去砍空城状态的诸葛亮', async () => {
  /*
   * 官方 FAQ(诸葛亮页):「诸葛亮触发【空城】时,是否可以被指定为
   * 【借刀杀人】使用【杀】的目标?**不可以。**」
   *
   * 以前这里只查了 inAttackRange,漏了 prohibitTarget —— 空城的诸葛亮、
   * 谦逊的陆逊照样会被选中。引擎里有 canTarget() 这份唯一判定,直接用它。
   */
  const { game, agents } = mkGame({ 0: '甄姬', 1: '关羽', 2: '诸葛亮' }, 3);
  const [me, holder, kongcheng] = game.players;
  const weapon = give(game, holder, '青龙偃月刀', '♠', 5);
  holder.hand.pop();
  (holder.equips as any).weapon = weapon;
  kongcheng.hand = [];                          // 空城成立
  give(game, holder, '杀');                     // 他手上有杀,不会因为没杀而拒绝

  let asked: string[] = [];
  agents[0].choosePlayers = async (_g, _s, cands) => { asked = cands.map(p => p.name); return [cands[0]]; };

  const spec = (await import('../core/registry.js')).cardSpecs.get('借刀杀人')!;
  const card = give(game, me, '借刀杀人', '♣', 12);
  await spec.onEffect!({
    game, from: me, to: holder,
    use: game.makeUse({ name: '借刀杀人', suit: '♣', rank: 12, cards: [card] }, me, [holder]),
  } as any);

  assert.ok(!asked.includes(kongcheng.name),
    `空城的诸葛亮不该出现在候选里,实际候选:${asked.join('、')}`);

  // 反过来:他一旦有手牌,空城不成立,就该能被选
  give(game, kongcheng, '闪');
  await spec.onEffect!({
    game, from: me, to: holder,
    use: game.makeUse({ name: '借刀杀人', suit: '♣', rank: 12, cards: [card] }, me, [holder]),
  } as any);
  assert.ok(asked.includes(kongcheng.name), '不在空城状态时应该能被选中');
});

test('贯石斧:可以弃自己的装备,唯独不能弃贯石斧本身', async () => {
  // 官方 FAQ:「是否可以弃掉自己装备区里的牌?**可以,除了【贯石斧】本身。**」
  const { game, agents } = mkGame({ 0: '甄姬', 1: '关羽', 2: '赵云' }, 3);
  const me = game.players[0];
  // 必须走 equipCard —— 直接往 equips 上赋值不会注册装备技能
  await game.equipCard(me, give(game, me, '贯石斧', '♦', 5));
  await game.equipCard(me, give(game, me, '防御马', '♥', 13));
  give(game, me, '闪');

  let pool: string[] = [];
  agents[0].chooseCards = async (_g, _s, cards, min) => { pool = cards.map(c => c.name); return cards.slice(0, min); };

  const skill = me.allSkills.find(s => s.name === '贯石斧')! as any;
  await skill.effect({
    game, self: me,
    event: { use: game.makeUse({ name: '杀', suit: '♠', rank: 7, cards: [] }, me, [game.players[1]]), from: me, to: game.players[1] },
  });

  assert.ok(pool.includes('防御马'), '装备区的其他牌可以弃');
  assert.ok(!pool.includes('贯石斧'), `贯石斧本身不该在可弃列表里,实际:${pool.join('、')}`);
});

test('五谷丰登:亮出的张数按目标数,不是按存活人数', async () => {
  // 官方原文:「你亮出牌堆顶**等同于目标角色数**的牌」
  const { game, agents } = mkGame({ 0: '甄姬', 1: '关羽', 2: '赵云' }, 3);
  const me = game.players[0];
  for (const p of game.players) agents[p.seat].chooseCards = async (_g, _s, cards) => [cards[0]];

  const spec = (await import('../core/registry.js')).cardSpecs.get('五谷丰登')!;
  const card = give(game, me, '五谷丰登', '♥', 3);
  // 只指定两个目标(正常情况是全场,这里手动收窄以区分"目标数"和"存活人数")
  const use = game.makeUse({ name: '五谷丰登', suit: '♥', rank: 3, cards: [card] }, me, [me, game.players[1]]);
  await spec.onEffect!({ game, use, from: me, to: me } as any);

  const revealed = (use.tags.wugu as unknown[]).length + 1;   // 已经被 me 取走一张
  assert.equal(revealed, 2, `3 人存活但只有 2 个目标,应该亮 2 张,实际亮了 ${revealed} 张`);
});

test('方天画戟:条件是"这张杀是你最后的手牌",不是"手牌不多于一张"', async () => {
  /*
   * 官方 FAQ:「无手牌的刘备装备【方天画戟】,【激将】使用【杀】是否可以发动?
   * **不能**,发动【方天画戟】的技能条件必须是使用自己最后一张手牌。」
   *
   * 旧写法是 `self.hand.length <= 1 ? 2 : 0` —— 手牌 0 张时照样给两个额外目标。
   * 这条不是纸上谈兵:刘备用【仁德】把手牌全送出去(顺带回血),再靠【激将】
   * 要一张【杀】,就能几乎每回合白嫖三个目标;关羽用【武圣】把装备区的红牌
   * 当【杀】走的是同一条路。
   */
  const { game } = mkGame({ 0: '关羽', 1: '张飞', 2: '黄盖' }, 3);
  const me = game.players[0];
  await game.equipCard(me, give(game, me, '方天画戟', '♦', 12));
  const spec = (await import('../core/registry.js')).cardSpecs.get('杀')!;
  const maxOf = (vc: any) => (spec.targetMax as any)(game, me, vc);

  // ——— 手上只有这一张杀:可以多打两个 ———
  const slash = give(game, me, '杀', '♠', 7);
  assert.equal(maxOf(realCard(slash)), 3, '最后一张手牌的杀应该能指定三个目标');

  // ——— 手上还有别的牌:只能打一个 ———
  const extra = give(game, me, '闪', '♥', 2);
  assert.equal(maxOf(realCard(slash)), 1, '手牌不止一张时不该触发');
  me.hand = me.hand.filter(c => c !== extra);

  // ——— 手牌 0 张,杀来自装备区(武圣)或别人替你打出(激将):不该触发 ———
  me.hand = [];
  const equipped = me.equips.weapon!;
  assert.equal(maxOf(viewAsCard('杀', [equipped], '武圣')), 1,
    '装备区的牌当杀,不是"最后的手牌"');
  assert.equal(maxOf({ name: '杀', suit: 'none', rank: 0, cards: [] } as any), 1,
    '没有实体素材的杀(激将替打)不该触发');
});

// ————————————————— 武将层:对照官方 FAQ 查出来的 —————————————————

test('流离:先弃牌再算攻击范围,弃掉的马不能算进射程', async () => {
  /*
   * FAQ:「大乔发动【流离】时,是否可以弃置装备区里的装备牌?**可以,但是计算
   * 其他角色是否在攻击范围内时,不可以将弃置的牌算入。**」
   *
   * 以前是先算候选再问弃哪张 —— 弃掉进攻马之后射程缩短了,候选却还是按弃牌前算的。
   */
  // 用 5 人局:3 人局里 0 号到 2 号本来就是距离 1,进攻马根本看不出效果
  const { game, agents } = mkGame({ 0: '大乔', 1: '关羽' }, 5);
  const [qiao, attacker, far] = game.players;
  assert.equal(game.distance(qiao, far), 2, '2 号位在 5 人局里距离 2');
  await game.equipCard(qiao, give(game, qiao, '进攻马', '♦', 13));   // -1 之后才够得着
  assert.ok(game.inAttackRange(qiao, far), '装着马时够得着');
  give(game, qiao, '闪');

  let offered: string[] = [];
  agents[0].chooseCards = async (_g, _s, cards) => [cards.find(c => c.name === '进攻马')!];
  agents[0].choosePlayers = async (_g, _s, cands) => { offered = cands.map(p => p.name); return [cands[0]]; };

  const liuli = qiao.allSkills.find(s => s.name === '流离')! as any;
  const use = game.makeUse({ name: '杀', suit: '♠', rank: 7, cards: [] }, attacker, [qiao]);
  await liuli.effect({ game, self: qiao, event: { use, from: attacker, to: qiao } });

  assert.ok(!offered.includes(far.name),
    `弃掉进攻马之后 2 号位应该已经够不着,实际候选:${offered.join('、') || '(空)'}`);
});

test('青龙偃月刀:第二张杀要重新过一遍目标合法性', async () => {
  /*
   * FAQ(诸葛亮页):「发动【青龙偃月刀】效果时,如果在过程中诸葛亮触发【空城】,
   * 装备【青龙偃月刀】的角色是否可以对其使用【杀】?**不可以。**」
   */
  const { game } = mkGame({ 0: '关羽', 1: '诸葛亮', 2: '赵云' }, 3);
  const [me, kongcheng] = game.players;
  await game.equipCard(me, give(game, me, '青龙偃月刀', '♠', 5));
  give(game, me, '杀', '♣', 4);
  const skill = me.allSkills.find(s => s.name === '青龙偃月刀')! as any;
  const ev = { use: game.makeUse({ name: '杀', suit: '♠', rank: 7, cards: [] }, me, [kongcheng]), from: me, to: kongcheng };

  give(game, kongcheng, '闪');
  assert.equal(skill.filter({ game, self: me, event: ev, timing: 'SlashMissed' } as any), true,
    '对方还有手牌时应该能追第二张');
  kongcheng.hand = [];                                     // 手牌打空 -> 空城成立
  assert.equal(skill.filter({ game, self: me, event: ev, timing: 'SlashMissed' } as any), false,
    '对方进入空城后就不该再能追第二张');
});

test('离间:空城的诸葛亮只能当决斗的发起方', async () => {
  /*
   * FAQ:「貂蝉能否指定空城状态下的诸葛亮为【离间】的对象之一?**可以,但是必须
   * 指定诸葛亮为决斗的发起方(即对方先出杀)。**」
   *
   * 按我们的约定"先选的先出【杀】",先选的那名就是决斗的目标 —— 而空城的诸葛亮
   * 不能成为【决斗】的目标,所以他只能排在后面。
   */
  const { game, agents } = mkGame({ 0: '貂蝉', 1: '诸葛亮', 2: '赵云' }, 3);
  const [diao, kongcheng, zhao] = game.players;
  give(game, diao, '闪');
  kongcheng.hand = [];                                     // 空城成立
  for (const p of game.players) agents[p.seat].respond = () => -1;
  // 故意把空城的诸葛亮排在先选(= 决斗目标)
  agents[0].choosePlayers = async (_g, _s, cands) => [
    cands.find(p => p === kongcheng)!, cands.find(p => p === zhao)!,
  ];

  const lijian = diao.allSkills.find(s => s.name === '离间')! as any;
  await lijian.onUse(game, diao);

  assert.equal(kongcheng.hp, kongcheng.maxHp, '空城的诸葛亮不该被当成决斗目标而先出杀');
  assert.ok(zhao.hp < zhao.maxHp, '顺序应该被倒过来:赵云先出杀、接不上就掉血');
});

test('反间:由周瑜自己挑给哪张手牌,不是随机抽', async () => {
  // FAQ:「周瑜发动【反间】时,如果有多张手牌,牌的放置顺序由谁决定?**由周瑜决定。**」
  const { game, agents } = mkGame({ 0: '周瑜', 1: '关羽', 2: '赵云' }, 3);
  const [yu, target] = game.players;
  give(game, yu, '杀', '♠', 7);
  const peach = give(game, yu, '桃', '♥', 3);
  give(game, yu, '闪', '♦', 2);

  agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === target)!];
  agents[0].chooseCards = async (_g, _s, cards) => [cards.find(c => c.id === peach.id)!];
  agents[target.seat].chooseSuit = async () => '♠' as const;

  const fanjian = yu.allSkills.find(s => s.name === '反间')! as any;
  await fanjian.onUse(game, yu);

  assert.ok(target.hand.some(c => c.id === peach.id), '给出去的应该是周瑜挑的那张【桃】');
});

test('反馈:拿不到伤害来源判定区里的牌', async () => {
  // FAQ:「司马懿发动反馈时,是否可以获得来源判定区里的牌?**不可以**,判定区的牌不属于伤害来源的牌。」
  const { game, agents } = mkGame({ 0: '司马懿', 1: '关羽', 2: '赵云' }, 3);
  const [yi, src] = game.players;
  await game.placeDelayed(src, give(game, src, '乐不思蜀', '♠', 6), '乐不思蜀');
  src.hand = [];
  await game.equipCard(src, give(game, src, '防御马', '♥', 13));

  let zones: string[] = [];
  agents[0].option = (opts) => { zones = [...opts]; return 0; };
  const skill = yi.allSkills.find(s => s.name === '反馈')!;
  await (skill as any).effect({
    game, self: yi,
    event: { to: yi, from: src, amount: 1, card: null, reason: '杀' },
  });

  assert.ok(zones.some(z => z.includes('装备区')), '装备区可以拿');
  assert.ok(!zones.some(z => z.includes('判定区')),
    `判定区不该出现在候选里,实际:${zones.join(' / ')}`);
});

test('奸雄:劈自己的那张【闪电】要收得到', async () => {
  // FAQ:「当锦囊牌对曹操造成伤害时,曹操获得哪张牌?**只获得相应的锦囊**,
  //       例如曹操判定【闪电】受到伤害,可以将【闪电】收入手牌。」
  const { game, agents } = mkGame({ 0: '曹操', 1: '关羽', 2: '赵云' }, 3);
  const cao = game.players[0];
  const bolt = give(game, cao, '闪电', '♠', 1);
  cao.hand.pop();
  await game.placeDelayed(cao, bolt, '闪电');
  stackDeck(game, [['杀', '♠', 5]]);                       // ♠5 落在 2~9,闪电必中
  for (const p of game.players) agents[p.seat].option = () => 0;   // 一律"发动"

  await (game as any).runPhase(cao, 'judge');

  assert.ok(cao.hp < cao.maxHp, '闪电应该劈中了');
  assert.ok(cao.hand.some(c => c.id === bolt.id),
    `曹操应该用【奸雄】收走那张闪电,实际手牌:${cao.hand.map(c => c.name).join('、') || '(空)'}`);
});

test('克己:32 张以内照旧不弃牌,超过了才弃到 32(房规上限)', async () => {
  /*
   * 官方【克己】是"跳过弃牌阶段",手牌可以无限涨。实测 3000 局 8 人局里
   * 出现过 66 张的吕蒙 —— 界面一行只放得下约 12 张,而 104 张手牌时
   * 出牌阶段有 77 个选项、每次决策多烧约 1500 字。所以加了 32 张的房规上限。
   *
   * 关键是它**只在失控时才咬**:全场手牌峰值 p90 才 11,九成对局碰不到。
   */
  const { game, agents } = mkGame({ 0: '吕蒙', 1: '关羽', 2: '赵云' }, 3);
  const me = game.players[0];
  agents[0].option = () => 0;                                  // 一律"发动"
  agents[0].chooseCards = async (_g, _s, cards, min) => cards.slice(0, min);

  // ——— 手牌 10 张(远低于上限):一张都不该弃 ———
  me.hand = [];
  for (let i = 0; i < 10; i++) give(game, me, '闪', '♦', 2);
  await game.runPhase(me, 'discard');
  assert.equal(me.handCount, 10, `${me.hp} 点体力、10 张手牌时不该弃牌`);

  // ——— 手牌 40 张:弃到 32 ———
  me.clearMarks('turn:');
  for (let i = 0; i < 30; i++) give(game, me, '闪', '♦', 2);
  assert.equal(me.handCount, 40);
  await game.runPhase(me, 'discard');
  assert.equal(me.handCount, KEJI_HAND_CAP, `超过上限就该弃到 ${KEJI_HAND_CAP} 张`);

  // ——— 本回合出过【杀】:克己不发动,按体力弃 ———
  me.clearMarks('turn:');
  me.addMark('turn:playedSlash');
  await game.runPhase(me, 'discard');
  assert.equal(me.handCount, me.hp, '出过杀就没有克己,老老实实弃到体力值');
});

test('濒死结算插在两个伤害时机中间', async () => {
  /*
   * 四个武将的 FAQ 是同一句话:「进入濒死状态时不可以发动,**除非被救回**」——
   * 曹操【奸雄】、司马懿【反馈】、夏侯惇【刚烈】、郭嘉【遗计】。
   *
   * 以前 DamageDone 排在 enterDying 前面,于是郭嘉会先摸两张【遗计】牌分给队友、
   * **然后**才死(那两张不随死亡弃置,等于凭空送人),夏侯惇会先用【刚烈】
   * 让来源弃牌或掉血再自己死。这是实打实的强度差,不是表现差异。
   *
   * 但**不能**把两个时机都挪到濒死之后:【麒麟弓】挂的是 DamageDealt,
   * 它的 FAQ 要求恰好相反 —— 先弃坐骑(可触发【枭姬】)、然后才濒死。
   */
  // ——— 没被救回:不触发【遗计】 ———
  {
    const { game, agents } = mkGame({ 0: '郭嘉', 1: '关羽', 2: '赵云' }, 3);
    const [jia, src, ally] = game.players;
    jia.hp = 1;
    for (const p of game.players) agents[p.seat].respond = () => -1;   // 没人出桃
    agents[0].option = () => 0;                                        // 一律"发动"
    const before = ally.handCount;
    // 主公阵亡会抛 GameOver(胜负判定),这里只关心技能有没有发动
    await game.damage({ from: src, to: jia, amount: 1, card: null, reason: '杀' } as any)
      .catch(() => {});
    assert.equal(jia.alive, false, '没人救就该死');
    assert.equal(ally.handCount, before, '死掉的郭嘉不该还把【遗计】牌分出去');
  }

  // ——— 被救回:照常触发 ———
  {
    const { game, agents } = mkGame({ 0: '郭嘉', 1: '关羽', 2: '赵云' }, 3);
    const [jia, src, ally] = game.players;
    jia.hp = 1;
    // 桃要给郭嘉自己 —— enterDying 会跳过伤害来源,不问"要不要救你刚砍的人"
    give(game, jia, '桃', '♥', 3);
    for (const p of game.players) agents[p.seat].respond = () => 0;    // 有桃就出
    agents[0].option = () => 0;
    agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === ally)!];
    const before = ally.handCount;
    await game.damage({ from: src, to: jia, amount: 1, card: null, reason: '杀' } as any).catch(() => { /* 阵亡可能触发胜负判定 */ });
    assert.equal(jia.alive, true, '有桃应该被救回');
    assert.equal(ally.handCount, before + 2, '救回之后【遗计】照常发动,两张牌分出去');
  }

  // ——— 麒麟弓仍然在濒死之前:先弃马、枭姬摸牌,再濒死 ———
  {
    const { game, agents } = mkGame({ 0: '关羽', 1: '孙尚香', 2: '赵云' }, 3);
    const [me, xiang] = game.players;
    await game.equipCard(me, give(game, me, '麒麟弓', '♥', 5));
    await game.equipCard(xiang, give(game, xiang, '防御马', '♥', 13));
    xiang.hp = 1;
    stackDeck(game, [['桃', '♥', 3], ['闪', '♦', 2]]);                // 枭姬会摸到一张桃
    for (const p of game.players) agents[p.seat].option = () => 0;
    agents[xiang.seat].respond = () => 0;                              // 濒死时用摸到的桃自救

    await game.damage({ from: me, to: xiang, amount: 1, card: { name: '杀', suit: '♠', rank: 7, cards: [] } as any, reason: '杀' } as any).catch(() => { /* 阵亡可能触发胜负判定 */ });
    assert.equal(xiang.equips['horse+1'], undefined, '麒麟弓应该已经弃掉了坐骑');
    assert.equal(xiang.alive, true, '枭姬先摸到桃,所以濒死时救得回来');
  }
});

test('武圣拿装备当【杀】时,那张装备的效果已经不算数了', async () => {
  /*
   * 官方 FAQ:「关羽是否可以将装备区里的红色的牌当作【杀】使用或打出?**可以,
   * 但是需要装备提供的距离或攻击范围或武器技能时,不能将该装备打出。**
   * 例如关羽装备了方块【诸葛连弩】使用过【杀】之后,就不能再把这张【诸葛连弩】
   * 当【杀】使用了。」
   *
   * 机制上是"转化在前、出牌在后":装备变成【杀】的那一刻就离开装备区了,
   * 所以判合法性时得当它不在(engine 侧是 game.asIfGone)。
   */
  // ——— 例一:♦诸葛连弩,本回合已经出过杀 -> 不能再把连弩当杀 ———
  {
    const { game } = mkGame({ 0: '关羽', 1: '张飞', 2: '黄盖' }, 3);
    const me = game.players[0];
    game.current = me;
    await game.equipCard(me, give(game, me, '诸葛连弩', '♦', 1));
    const labels = () => ((game as any).enumerateUsable(me) as Array<{ label: string }>)
      .map(o => o.label);

    assert.ok(labels().some(l => l.includes('杀') && l.includes('武圣')),
      '还没出过杀时,连弩可以当杀用');
    me.addMark('turn:slashUsed');                       // 本回合出过一张杀了
    assert.ok(!labels().some(l => l.includes('杀') && l.includes('武圣')),
      '连弩一旦被当成素材,"无次数限制"就没了,这张杀超次数、不该出现在菜单里');
  }

  // ——— 例二:贯石斧(射程3)打距离 3 的目标 -> 不能拿贯石斧当杀 ———
  {
    const { game } = mkGame({ 0: '关羽' }, 7);           // 7 人局,0 号到 3 号距离 3
    const me = game.players[0];
    const far = game.players[3];
    game.current = me;
    await game.equipCard(me, give(game, me, '贯石斧', '♦', 5));
    assert.equal(game.distance(me, far), 3);
    assert.ok(game.inAttackRange(me, far), '带着贯石斧时够得着');

    const vc = viewAsCard('杀', [me.equips.weapon!], '武圣');
    const reach = game.asIfGone(vc.cards, () => game.canTarget(me, far, vc, []));
    assert.equal(reach, false, '把贯石斧当杀打出去之后射程掉回 1,够不着距离 3 的人');
    // 手上另有一张红牌时,贯石斧还在,就够得着
    const red = give(game, me, '桃', '♥', 3);
    const vc2 = viewAsCard('杀', [red], '武圣');
    assert.equal(game.asIfGone(vc2.cards, () => game.canTarget(me, far, vc2, [])), true,
      '素材是手牌时,贯石斧还在装备区,射程照旧');
  }
});

test('激将:刘备可以在出牌阶段主动发起,由蜀将提供【杀】', async () => {
  /*
   * 官方文本是"你需要**使用或打出**【杀】时",两个动词各是一条路。以前只实现了
   * "打出"(被要求响应时),刘备没法主动起一张杀 —— 10 条 FAQ 里大半落空。
   */
  const { game, agents } = mkGame({ 0: '刘备', 1: '关羽', 2: '黄盖' }, 3);
  const [liu, guan, victim] = game.players;
  game.current = liu;
  liu.hand = [];                                       // 刘备自己一张牌都没有
  give(game, guan, '杀', '♠', 7);

  const jijiang = liu.allSkills.find(s => s.kind === 'active' && s.name === '激将')! as any;
  assert.equal(jijiang.canUse(game, liu), true, '有蜀将、有合法目标时应该能发动');

  agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === victim)!];
  agents[guan.seat].respond = () => 0;                 // 关羽愿意提供
  agents[victim.seat].respond = () => -1;              // 黄盖没有闪
  const before = victim.hp;
  await jijiang.onUse(game, liu);

  assert.equal(victim.hp, before - 1, '这张【杀】应该真的打出去并造成伤害');
  assert.equal(liu.mark('turn:slashUsed'), 1, '要占刘备本回合的出杀次数');
  assert.equal(jijiang.canUse(game, liu), false, '次数用完就不能再发动了');
});

test('激将提供的【杀】视为刘备使用 —— 一串裁定跟着自动成立', async () => {
  /*
   * FAQ 里这几条都靠 `use.from` 是刘备来保证:
   *   - 响应方的【铁骑】不触发(「不能发动影响这张杀效果的武将技」)
   *   - 刘备是伤害来源,承担一切反馈和奖惩
   *   - 【方天画戟】不能发动(「必须是使用自己最后一张手牌」)
   */
  const { game, agents } = mkGame({ 0: '刘备', 1: '马超', 2: '黄盖' }, 3);
  const [liu, machao, victim] = game.players;
  game.current = liu;
  liu.hand = [];
  await game.equipCard(liu, give(game, liu, '方天画戟', '♦', 12));
  give(game, machao, '杀', '♠', 7);

  const jijiang = liu.allSkills.find(s => s.kind === 'active' && s.name === '激将')! as any;
  // 方天画戟:刘备手牌 0 张,但这张杀不是他的手牌 -> 只能选一个目标
  const spec = (await import('../core/registry.js')).cardSpecs.get('杀')!;
  assert.equal((spec.targetMax as any)(game, liu, { name: '杀', suit: 'none', rank: 0, cards: [] }), 1,
    '【方天画戟】不该因为"手牌 0 张"就给额外目标');

  let tieqiFired = false;
  const origJudge = game.judge.bind(game);
  (game as any).judge = async (p: any, reason: string, ...rest: any[]) => {
    if (reason === '铁骑') tieqiFired = true;
    return origJudge(p, reason, ...(rest as [any]));
  };
  agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === victim)!];
  agents[machao.seat].respond = () => 0;
  agents[victim.seat].respond = () => -1;
  agents[machao.seat].option = () => 0;                // 马超若被问就"发动"

  const before = victim.hp;
  await jijiang.onUse(game, liu);

  assert.equal(tieqiFired, false, '响应方马超的【铁骑】不该触发 —— 这张杀是刘备使用的');
  assert.equal(victim.hp, before - 1);
  assert.equal(game.hostility(liu, victim), 1, '伤害来源应该记在刘备头上');
});

test('激将没人响应时:什么都没发生,次数不消耗', async () => {
  // FAQ:「刘备发动【激将】没有角色响应后,是否可以自己出【杀】?**可以。**
  //       …是否可以更换【杀】的目标继续发动?**可以。**」
  const { game, agents } = mkGame({ 0: '刘备', 1: '关羽', 2: '黄盖' }, 3);
  const [liu, , victim] = game.players;
  game.current = liu;
  liu.hand = [];
  agents[0].choosePlayers = async (_g, _s, cands) => [cands.find(p => p === victim)!];
  for (const p of game.players) agents[p.seat].respond = () => -1;   // 没人给

  const jijiang = liu.allSkills.find(s => s.kind === 'active' && s.name === '激将')! as any;
  const r = await jijiang.onUse(game, liu);

  assert.equal(r, false, '没人响应要报"没发动",这样次数才不会被吃掉');
  assert.equal(liu.mark('turn:slashUsed'), 0, '不该占出杀次数');
  assert.equal(victim.hp, victim.maxHp);
  assert.equal(jijiang.canUse(game, liu), true, '还能再来一次(换个目标)');
});
