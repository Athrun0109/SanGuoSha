/**
 * 标准版卡牌:行为定义 + 牌堆配比。
 *
 * DIY 提示:
 *  - 想改某张牌的效果 -> 改它的 onEffect
 *  - 想改牌堆配比     -> 改本文件末尾的 DECK_TABLE
 *  - 想加新牌         -> defineCard({...}) 然后在 DECK_TABLE 里加几张
 */

import {
  Card, Suit, VirtualCard, cardLabel, realCard, suitColor, viewAsCard,
} from '../core/types.js';
import type { Player } from '../core/player.js';
import type { Game } from '../core/game.js';
import type { TargetEvent, DamageEvent } from '../core/events.js';
import { defineCard, getSpec } from '../core/registry.js';
import { staticSkill, triggered, viewAs } from '../core/skill.js';

// ————————————————— 通用工具 —————————————————

/**
 * 从某角色的区域里指定一张牌(手牌为暗置,只能随机选中)。
 *
 * `judgeZone: false` 表示不含判定区 —— 【过河拆桥】【顺手牵羊】的官方文本是
 * "其**区域**里的一张牌",判定区算在内;而司马懿【反馈】写的是"伤害来源的一张牌",
 * FAQ 明确「判定区的牌不属于伤害来源的牌」,不能拿。
 */
export async function pickCardFrom(
  game: Game, chooser: Player, target: Player, prompt: string,
  opts: { judgeZone?: boolean } = {},
): Promise<Card | null> {
  const zones: { label: string; cards: Card[] }[] = [];
  if (target.hand.length) zones.push({ label: `手牌(${target.hand.length}张,随机一张)`, cards: target.hand });
  // 装备区也带花色点数 —— 对方装了两匹马时,只写牌名就分不清是哪一张。
  // (判定区早就带了,这里一直不一致)
  for (const c of target.equipCards) zones.push({ label: `装备区 ${cardLabel(c)}`, cards: [c] });
  if (opts.judgeZone !== false) {
    for (const c of target.judgeZone) zones.push({ label: `判定区 ${game.judgeLabel(target, c)}`, cards: [c] });
  }
  if (!zones.length) return null;
  const idx = await game.agentOf(chooser).chooseOption(game, chooser, zones.map(z => z.label), prompt);
  const z = zones[Math.max(0, Math.min(idx, zones.length - 1))];
  return z.cards.length === 1 ? z.cards[0] : z.cards[game.rng.int(z.cards.length)];
}

/**
 * 【借刀杀人】能逼谁去砍谁 —— 走引擎那份唯一的目标合法性判定,别自己拼条件。
 *
 * 以前这里只查了 `inAttackRange`,漏掉了 `prohibitTarget`:空城的诸葛亮、
 * 谦逊的陆逊照样会被选中。官方 FAQ(诸葛亮页)明说「触发【空城】时不可以
 * 被指定为【借刀杀人】使用【杀】的目标」。
 */
const SLASH_PROBE: VirtualCard = { name: '杀', suit: 'none', rank: 0, cards: [] };
function slashableBy(game: Game, holder: Player): Player[] {
  return game.alivePlayers.filter(v => v !== holder && game.canTarget(holder, v, SLASH_PROBE, []));
}

/** 要求打出若干张指定牌,全部打出才算成功 */
async function demandCards(
  game: Game, p: Player, name: string, count: number, purpose: string, prompt: string,
  use?: any,
): Promise<boolean> {
  for (let i = 0; i < count; i++) {
    const suffix = count > 1 ? `(第 ${i + 1}/${count} 张)` : '';
    const c = await game.askForCard(p, { names: [name] }, purpose, prompt + suffix, false, { use });
    if (!c) return false;
  }
  return true;
}

// ————————————————— 基本牌 —————————————————

defineCard({
  name: '杀',
  type: 'basic',
  targetMin: 1,
  // 把这张【杀】本身传进查询 —— 【方天画戟】要判断的是"它是不是你最后的手牌",
  // 光看手牌数不够(见 isLastHandCard)
  targetMax: (g, from, vc) => 1 + g.sumQuery(from, 'slashExtraTargets', { card: vc }),
  range: 'attack',
  targetFilter: (g, from, to) => to !== from,
  async onEffect({ game, use, from, to }) {
    const forceKey = `force:${to.seat}`;
    let hit = use.unavoidable!.has(to);
    if (!hit) {
      const need = 1 + game.sumQuery(from, 'extraDodge', { use, to });
      const dodged = await demandCards(
        game, to, '闪', need, 'dodge', `${from.name} 对你使用【杀】,请打出【闪】`, use,
      );
      if (dodged) {
        game.log(`  ${to.name} 躲开了【杀】`);
        await game.trigger('SlashMissed', { use, from, to } as TargetEvent);
        hit = !!use.tags[forceKey];
      } else {
        hit = true;
      }
    }
    if (!hit) return;
    await game.damage({ from, to, amount: 1, card: use.card, reason: '杀' } as DamageEvent);
  },
});

defineCard({
  name: '闪',
  type: 'basic',
  targetMin: 0,
  targetMax: 0,
  canUse: () => false, // 只能用于响应
});

defineCard({
  name: '桃',
  type: 'basic',
  targetMin: 1,
  targetMax: 1,
  autoTargets: (g, from) => [from],
  canUse: (g, from) => from.isWounded,
  async onEffect({ game, from, to }) {
    const amount = 1 + game.sumQuery(to, 'peachRecover', { from, to });
    await game.recover(to, amount, from, '桃');
  },
});

// ————————————————— 非延时锦囊 —————————————————

defineCard({
  name: '过河拆桥',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  targetFilter: (g, from, to) => to !== from && to.allCards.length > 0,
  async onEffect({ game, from, to }) {
    const c = await pickCardFrom(game, from, to, `过河拆桥:弃置 ${to.name} 的一张牌`);
    if (!c) return;
    game.log(`  ${from.name} 弃置了 ${to.name} 的 ${cardLabel(c)}`);
    await game.discardCards([c], '过河拆桥');
  },
});

defineCard({
  name: '顺手牵羊',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  range: 1,
  targetFilter: (g, from, to) => to !== from && to.allCards.length > 0,
  async onEffect({ game, from, to }) {
    const c = await pickCardFrom(game, from, to, `顺手牵羊:获得 ${to.name} 的一张牌`);
    if (!c) return;
    game.log(`  ${from.name} 获得了 ${to.name} 的一张牌`);
    await game.gainCards(from, [c], '顺手牵羊');
  },
});

defineCard({
  name: '决斗',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  targetFilter: (g, from, to) => to !== from,
  async onEffect({ game, use, from, to }) {
    let responder: Player = to, other: Player = from;
    for (let guard = 0; guard < 40; guard++) {
      const need = 1 + game.sumQuery(other, 'extraSlash', { duel: use, responder });
      const ok = await demandCards(
        game, responder, '杀', need, 'slash', `决斗:与 ${other.name} 拼杀,请打出【杀】`, use,
      );
      if (!ok) {
        await game.damage({ from: other, to: responder, amount: 1, card: use.card, reason: '决斗' } as DamageEvent);
        return;
      }
      [responder, other] = [other, responder];
    }
  },
});

defineCard({
  name: '无中生有',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  autoTargets: (g, from) => [from],
  async onEffect({ game, to }) {
    await game.drawCards(to, 2, '无中生有');
  },
});

defineCard({
  name: '南蛮入侵',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  // 从使用者的下家开始按座次,跳过使用者本人。
  // 顺序不是摆设:先被点到的人先被问【杀】/【闪】,先结算伤害,
  // 也就先濒死 —— 谁先死会改变后面还有谁活着能救。
  autoTargets: (g, from) => g.playersFrom(from, false),
  async onEffect({ game, use, from, to }) {
    const ok = await demandCards(game, to, '杀', 1, 'slash', `南蛮入侵:请打出【杀】`, use);
    if (!ok) await game.damage({ from, to, amount: 1, card: use.card, reason: '南蛮入侵' } as DamageEvent);
  },
});

defineCard({
  name: '万箭齐发',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  // 从使用者的下家开始按座次,跳过使用者本人。
  // 顺序不是摆设:先被点到的人先被问【杀】/【闪】,先结算伤害,
  // 也就先濒死 —— 谁先死会改变后面还有谁活着能救。
  autoTargets: (g, from) => g.playersFrom(from, false),
  async onEffect({ game, use, from, to }) {
    const ok = await demandCards(game, to, '闪', 1, 'dodge', `万箭齐发:请打出【闪】`, use);
    if (!ok) await game.damage({ from, to, amount: 1, card: use.card, reason: '万箭齐发' } as DamageEvent);
  },
});

defineCard({
  name: '桃园结义',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  // 收益牌从**使用者自己**开始按座次 —— 五谷先挑走好牌是使用它的主要理由。
  // g.alivePlayers 是按座位号排的,不是按行动顺序,用它会让 0 号位永远先挑。
  //
  // **满血的角色直接跳过。**【桃】本身就有 canUse: from.isWounded(满血不能用),
  // 桃园结义没理由不一致。而且不跳的话,每个满血角色都会白开一个无懈可击窗口 ——
  // 问全场"要不要抵消一个必然什么都不会发生的效果",纯粹是浪费决策点。
  autoTargets: (g, from) => g.playersFrom(from, true).filter(p => p.isWounded),
  async onEffect({ game, from, to }) {
    await game.recover(to, 1, from, '桃园结义');
  },
});

defineCard({
  name: '五谷丰登',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  // 收益牌从**使用者自己**开始按座次 —— 五谷先挑走好牌是使用它的主要理由。
  // g.alivePlayers 是按座位号排的,不是按行动顺序,用它会让 0 号位永远先挑。
  autoTargets: (g, from) => g.playersFrom(from, true),
  async onEffect({ game, use, to }) {
    if (!use.tags.wugu) {
      // 官方原文是"亮出牌堆顶**等同于目标角色数**的牌"。和存活人数通常相等,
      // 但结算途中有人阵亡时就不一样了 —— 按原文来。
      const cards = game.drawFromDeck(use.targets.length);
      game.processing.push(...cards);
      use.tags.wugu = cards;
      game.log(`  五谷丰登亮出:${cards.map(cardLabel).join('、')}`);
    }
    const pool: Card[] = use.tags.wugu;
    if (!pool.length) return;
    // 用 chooseCards 而不是 chooseOption —— 这本来就是在选牌。
    // 换过来之后界面能把候选画成牌摊在中央,而不是一排文字按钮;
    // 模型那边也一样,选项带上了花色点数的结构信息。
    const chosen = await game.agentOf(to).chooseCards(game, to, pool, 1, 1, '五谷丰登:选择一张牌');
    const pick = chosen[0] && pool.includes(chosen[0]) ? chosen[0] : pool[0];
    pool.splice(pool.indexOf(pick), 1);
    game.log(`  ${to.name} 取走 ${cardLabel(pick)}`);
    await game.gainCards(to, [pick], '五谷丰登');
    game.revealToAll(pick, to); // 五谷是亮出来取的,全场都看得见
  },
});

defineCard({
  name: '借刀杀人',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  targetFilter: (g, from, to) => to !== from && !!to.equips.weapon
    && slashableBy(g, to).length > 0,
  async onEffect({ game, use, from, to }) {
    const victims = slashableBy(game, to);
    if (!victims.length) return;
    const chosen = await game.agentOf(from).choosePlayers(
      game, from, victims, 1, 1, `借刀杀人:令 ${to.name} 对谁使用【杀】?`,
    );
    const victim = chosen[0] ?? victims[0];
    game.log(`  ${from.name} 要求 ${to.name} 对 ${victim.name} 使用【杀】`);
    const slash = await game.askForUse(
      to, { names: ['杀'] }, 'slash', `借刀杀人:对 ${victim.name} 使用【杀】,否则交出武器`,
    );
    if (slash) {
      await game.useCard(game.makeUse(slash, to, [victim]));
    } else {
      const weapon = to.equips.weapon;
      if (weapon) {
        game.log(`  ${to.name} 拒绝,将武器交给 ${from.name}`);
        await game.gainCards(from, [weapon], '借刀杀人');
      }
    }
  },
});

defineCard({
  name: '无懈可击',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  canUse: () => false, // 只能用于响应
});

// ————————————————— 延时锦囊 —————————————————

defineCard({
  name: '乐不思蜀',
  type: 'trick',
  targetMin: 1,
  targetMax: 1,
  targetFilter: (g, from, to) =>
    to !== from && !to.judgeZone.some(c => g.judgeName(to, c) === '乐不思蜀'),
  async onEffect({ game, use, to }) {
    await game.placeDelayed(to, use.card.cards[0], '乐不思蜀');
  },
  async delayed(game, p, card) {
    const ev = await game.judge(p, '乐不思蜀', c => c.suit !== '♥');
    if (ev.success) {
      game.log(`  ${p.name} 被【乐不思蜀】跳过出牌阶段`);
      p.setMark('turn:skip:play', 1);
    }
  },
});

defineCard({
  name: '闪电',
  type: 'trick',
  targetMin: 0,
  targetMax: 0,
  autoTargets: (g, from) => [from],
  canUse: (g, from) => !from.judgeZone.some(c => g.judgeName(from, c) === '闪电'),
  async onEffect({ game, use, to }) {
    await game.placeDelayed(to, use.card.cards[0], '闪电');
  },
  async delayed(game, p, card) {
    const ev = await game.judge(p, '闪电', c => c.suit === '♠' && c.rank >= 2 && c.rank <= 9);
    if (ev.success) {
      // 伤害要带上【闪电】这张牌本身 —— 曹操【奸雄】靠它才收得到
      // (FAQ:「曹操判定【闪电】受到伤害,可以将【闪电】收入手牌」)。
      // judgePhase 结算前已经把它挪进 processing,奸雄的位置检查过得去。
      await game.damage({ from: null, to: p, amount: 3, card: realCard(card), reason: '闪电' } as DamageEvent);
    } else {
      await passLightning(game, p, card);
    }
  },
  // 被无懈抵消 ≠ 这张牌就没了。闪电只是这一次不生效,牌本身继续传给下家。
  onNullified: passLightning,
});

/** 把闪电挪到下一个判定区里还没有闪电的角色;绕一圈都有就只能弃掉 */
async function passLightning(game: Game, from: Player, card: Card) {
  const next = game.playersFrom(from, false).find(
    q => !q.judgeZone.some(c => game.judgeName(q, c) === '闪电'),
  );
  if (next) await game.placeDelayed(next, card, '闪电');
  else await game.discardCards([card], '闪电无处可传');
}

// ————————————————— 装备:武器 —————————————————

function weapon(name: string, range: number, extra: any[] = []) {
  return defineCard({
    name, type: 'equip', slot: 'weapon',
    targetMin: 0, targetMax: 0,
    autoTargets: (g, from) => [from],
    equipSkills: [
      staticSkill({ name: `${name}·射程`, queries: { attackRange: () => range - 1 } }),
      ...extra,
    ],
  });
}

weapon('诸葛连弩', 1, [
  staticSkill({
    name: '诸葛连弩', desc: '出牌阶段使用【杀】无次数限制',
    queries: { noSlashLimit: () => true },
  }),
]);

weapon('雌雄双股剑', 2, [
  triggered({
    name: '雌雄双股剑', desc: '使用【杀】指定异性目标后,可令其弃一张手牌,否则你摸一张牌',
    timing: 'TargetConfirmed',
    filter: ({ game, self, event }) => {
      const e = event as TargetEvent;
      return e.from === self && e.use.card.name === '杀' && e.to.gender !== self.gender;
    },
    async effect({ game, self, event }) {
      const e = event as TargetEvent;
      const discarded = await game.askForDiscard(e.to, 1, `雌雄双股剑:弃置一张手牌,否则 ${self.name} 摸一张牌`);
      if (!discarded.length) await game.drawCards(self, 1, '雌雄双股剑');
    },
  }),
]);

weapon('青釭剑', 2, [
  staticSkill({
    name: '青釭剑', desc: '锁定技,你使用【杀】无视目标防具',
    compulsory: true,
    queries: { ignoreArmor: () => true },
  }),
]);

weapon('青龙偃月刀', 3, [
  triggered({
    name: '青龙偃月刀', desc: '【杀】被闪避后,可以对其再使用一张【杀】',
    timing: 'SlashMissed',
    filter: ({ game, self, event }) => {
      const e = event as TargetEvent;
      if (e.from !== self || !e.to.alive) return false;
      // 官方 FAQ(诸葛亮页):第一张【杀】把对方手牌打空、途中触发【空城】之后,
      // 就**不能**再对他使用第二张。所以这里要重新过一遍目标合法性,
      // 不能因为"他刚才是目标"就默认现在还能打
      if (!game.canTarget(self, e.to, SLASH_PROBE, [])) return false;
      return game.enumerateResponses(self, { names: ['杀'] }, { mode: 'respond', purpose: 'slash' }).length > 0;
    },
    async effect({ game, self, event }) {
      const e = event as TargetEvent;
      const vc = await game.askForUse(self, { names: ['杀'] }, 'slash', `青龙偃月刀:对 ${e.to.name} 再使用一张【杀】`);
      if (vc) await game.useCard(game.makeUse(vc, self, [e.to]));
    },
  }),
]);

weapon('丈八蛇矛', 3, [
  viewAs({
    name: '丈八蛇矛', desc: '你可以将两张手牌当【杀】使用或打出',
    produces: ['杀'],
    cardCount: 2,
    cardFilter: (g, self, card) => true,
    available: () => true,
    viewAs: (g, self, cards) => viewAsCard('杀', cards, '丈八蛇矛'),
  }),
]);

/** 发动【贯石斧】时能拿来弃的牌:手牌 + 装备,但不含贯石斧自己 */
function discardable(self: Player): Card[] {
  const axe = self.equips.weapon;
  return [...self.hand, ...self.equipCards].filter(c => c !== axe);
}

weapon('贯石斧', 3, [
  triggered({
    name: '贯石斧', desc: '【杀】被闪避后,可弃两张牌令伤害依然造成',
    timing: 'SlashMissed',
    filter: ({ self, event }) => {
      const e = event as TargetEvent;
      // 官方 FAQ:可以弃自己装备区的牌,**唯独不能弃【贯石斧】本身** ——
      // 所以数够不够两张的时候也得把它排除掉
      return e.from === self && discardable(self).length >= 2;
    },
    async effect({ game, self, event }) {
      const e = event as TargetEvent;
      const d = await game.askForDiscard(self, 2, '贯石斧:弃置两张牌令【杀】仍然造成伤害', {
        includeEquip: true, exclude: self.equips.weapon ? [self.equips.weapon] : [],
      });
      if (d.length === 2) e.use.tags[`force:${e.to.seat}`] = true;
    },
  }),
]);

/**
 * 【方天画戟】的条件是「使用的这张【杀】**是你最后的手牌**」,不是「手牌不多于一张」。
 *
 * 差别在两头:
 *  - **手牌 0 张**时旧写法照样给两个额外目标,而官方 FAQ 明说不行 ——
 *    「无手牌的刘备装备【方天画戟】,【激将】使用【杀】是否可以发动?**不能**」。
 *    这不是纸上谈兵:刘备用【仁德】把手牌全送出去(顺带回血),再靠【激将】要一张
 *    【杀】,就能几乎每回合白嫖三个目标;关羽用【武圣】把装备区的红牌当【杀】
 *    也是同一条路。
 *  - 反过来,**素材必须来自手牌且刚好用光** —— 装备区的牌、别人替你打出的牌都不算。
 */
function isLastHandCard(self: Player, vc?: VirtualCard): boolean {
  if (!vc?.cards.length) return false;                       // 不消耗实体牌的转化
  return self.hand.length === vc.cards.length && vc.cards.every(c => self.hand.includes(c));
}

weapon('方天画戟', 4, [
  staticSkill({
    name: '方天画戟', desc: '锁定技,若你使用的【杀】是你最后的手牌,则此【杀】可以多指定两个目标',
    compulsory: true,
    queries: { slashExtraTargets: (g, self, ctx) => (isLastHandCard(self, ctx?.card) ? 2 : 0) },
  }),
]);

weapon('麒麟弓', 5, [
  triggered({
    name: '麒麟弓', desc: '【杀】造成伤害时,可弃置目标的一匹坐骑',
    timing: 'DamageDealt',
    filter: ({ self, event }) => {
      const e = event as DamageEvent;
      return e.from === self && e.card?.name === '杀'
        && (!!e.to.equips['horse+1'] || !!e.to.equips['horse-1']);
    },
    async effect({ game, self, event }) {
      const e = event as DamageEvent;
      const horses = [e.to.equips['horse+1'], e.to.equips['horse-1']].filter(Boolean) as Card[];
      const idx = horses.length === 1 ? 0 : await game.agentOf(self).chooseOption(
        game, self, horses.map(cardLabel), '麒麟弓:弃置哪匹坐骑?',
      );
      await game.discardCards([horses[Math.max(0, Math.min(idx, horses.length - 1))]], '麒麟弓');
    },
  }),
]);

// ————————————————— 装备:防具 / 坐骑 —————————————————

defineCard({
  name: '八卦阵', type: 'equip', slot: 'armor',
  targetMin: 0, targetMax: 0,
  autoTargets: (g, from) => [from],
  equipSkills: [
    triggered({
      name: '八卦阵', desc: '需要使用或打出【闪】时,可以判定,红色则视为你使用/打出了【闪】',
      timing: 'AskingForCard',
      filter: ({ self, event }) => {
        const e = event as any;
        return e.player === self && e.purpose === 'dodge' && !e.result;
      },
      async effect({ game, self, event }) {
        const e = event as any;
        const ev = await game.judge(self, '八卦阵', c => suitColor(c.suit) === 'red');
        if (ev.success) {
          e.result = { name: '闪', suit: 'none', rank: 0, cards: [], skill: '八卦阵' } as VirtualCard;
          game.log(`  ${self.name} 的八卦阵生效,视为打出【闪】`);
        }
      },
    }),
  ],
});

defineCard({
  name: '仁王盾', type: 'equip', slot: 'armor',
  targetMin: 0, targetMax: 0,
  autoTargets: (g, from) => [from],
  equipSkills: [
    staticSkill({
      name: '仁王盾', desc: '锁定技,黑色的【杀】对你无效',
      compulsory: true,
      queries: {
        invalidToTarget: (g, self, ctx) => {
          const use = ctx.use;
          if (use.card.name !== '杀') return false;
          if (suitColor(use.card.suit) !== 'black') return false;
          return !g.anyQuery(use.from, 'ignoreArmor', { use, to: self });
        },
      },
    }),
  ],
});

function horse(name: string, kind: 'horse+1' | 'horse-1') {
  return defineCard({
    name, type: 'equip', slot: kind,
    targetMin: 0, targetMax: 0,
    autoTargets: (g, from) => [from],
    equipSkills: [
      staticSkill({
        name,
        desc: kind === 'horse-1' ? '你计算与其他角色的距离 -1' : '其他角色计算与你的距离 +1',
        queries: kind === 'horse-1'
          ? { distanceDelta: () => -1 }
          : { distanceFromDelta: () => 1 },
      }),
    ],
  });
}

// 六匹马在标准版里功能完全一样,名字纯属风味。合并成两张牌:
// 牌名直接就是效果,少三个词汇要教给 LLM,前端也不用再解释"的卢是哪种马"。
// 花色点数保留 —— 判定、拆牌、顺手牵羊都要用。
horse('进攻马', 'horse-1');
horse('防御马', 'horse+1');

// ————————————————— 牌堆 —————————————————

type DeckEntry = [name: string, suit: Suit, rank: number];

/**
 * 标准版牌堆:**104 张**,基本牌 53 / 锦囊 34 / 装备 17。
 *
 * 花色点数逐格照抄官方的《标准版游戏牌列表》,不是随手编的。这件事很要紧 ——
 * 判定看的就是花色点数:【闪电】判 ♠2~♠9、【乐不思蜀】判 ♥、【八卦阵】判红色;
 * 转化技看的也是花色:武圣要红牌、倾国要黑牌、国色要 ♦ 牌。牌堆里每种花色分布
 * 错一点,这些概率就全跟着错,而且**跑一整局都不会报错**,只是结果不对。
 *
 * 记牌器(ai/cardCounter.ts)整个概率模型也建立在这张表上。
 *
 * 校验不变量:官方牌堆相当于两副扑克,**每个花色点数正好两张**,四种花色各 26 张。
 * 改完这张表跑一遍 engine.test.ts 里那条会自动查。
 *
 * 修过一次(20260820):原表是 106 张,混进了两张军争篇的牌(【仁王盾】♣2、
 * 第二张【闪电】♥Q),【无懈可击】用了 EX 版的 ♦Q,另外 7 张牌的花色点数放错了位置。
 * 想开军争包的话,【仁王盾】的实现留着没删(见上面 armor('仁王盾')),把它加回这张表即可。
 */
export const DECK_TABLE: DeckEntry[] = [
  // ——— 基本牌 53 ———
  // 【杀】30
  ...([7, 8, 8, 9, 9, 10, 10]).map(r => ['杀', '♠', r] as DeckEntry),
  ...([10, 10, 11]).map(r => ['杀', '♥', r] as DeckEntry),
  ...([2, 3, 4, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11]).map(r => ['杀', '♣', r] as DeckEntry),
  ...([6, 7, 8, 9, 10, 13]).map(r => ['杀', '♦', r] as DeckEntry),
  // 【闪】15
  ...([2, 2, 13]).map(r => ['闪', '♥', r] as DeckEntry),
  ...([2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 11]).map(r => ['闪', '♦', r] as DeckEntry),
  // 【桃】8 —— 七张♥加一张♦Q
  ...([3, 4, 6, 7, 8, 9, 12]).map(r => ['桃', '♥', r] as DeckEntry),
  ['桃', '♦', 12],

  // ——— 锦囊 34 ———
  ['过河拆桥', '♠', 3], ['过河拆桥', '♠', 4], ['过河拆桥', '♠', 12],
  ['过河拆桥', '♣', 3], ['过河拆桥', '♣', 4], ['过河拆桥', '♥', 12],
  ['顺手牵羊', '♠', 3], ['顺手牵羊', '♠', 4], ['顺手牵羊', '♠', 11],
  ['顺手牵羊', '♦', 3], ['顺手牵羊', '♦', 4],
  ['决斗', '♠', 1], ['决斗', '♣', 1], ['决斗', '♦', 1],
  ['无中生有', '♥', 7], ['无中生有', '♥', 8], ['无中生有', '♥', 9], ['无中生有', '♥', 11],
  ['南蛮入侵', '♠', 7], ['南蛮入侵', '♠', 13], ['南蛮入侵', '♣', 7],
  ['万箭齐发', '♥', 1],
  ['桃园结义', '♥', 1],
  ['五谷丰登', '♥', 3], ['五谷丰登', '♥', 4],
  ['借刀杀人', '♣', 12], ['借刀杀人', '♣', 13],
  ['无懈可击', '♠', 11], ['无懈可击', '♣', 12], ['无懈可击', '♣', 13],
  ['乐不思蜀', '♠', 6], ['乐不思蜀', '♥', 6], ['乐不思蜀', '♣', 6],
  ['闪电', '♠', 1],

  // ——— 装备 17 ———
  ['诸葛连弩', '♣', 1], ['诸葛连弩', '♦', 1],
  ['雌雄双股剑', '♠', 2],
  ['青釭剑', '♠', 6],
  ['青龙偃月刀', '♠', 5],
  ['丈八蛇矛', '♠', 12],
  ['贯石斧', '♦', 5],
  ['方天画戟', '♦', 12],
  ['麒麟弓', '♥', 5],
  ['八卦阵', '♠', 2], ['八卦阵', '♣', 2],
  // 花色点数按官方标准版:防御马 = 绝影♠5 / 的卢♣5 / 爪黄飞电♥K
  //                      进攻马 = 大宛♠K / 赤兔♥5 / 紫骍♦K
  ['防御马', '♠', 5], ['防御马', '♣', 5], ['防御马', '♥', 13],
  ['进攻马', '♠', 13], ['进攻马', '♥', 5], ['进攻马', '♦', 13],
];

export function buildDeck(): Card[] {
  let id = 1;
  return DECK_TABLE.map(([name, suit, rank]) => {
    if (!getSpec(name)) throw new Error(`牌堆里有未定义的牌:${name}`);
    return { id: id++, name, suit, rank };
  });
}
