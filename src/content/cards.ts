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

/** 从某角色的区域里指定一张牌(手牌为暗置,只能随机选中) */
export async function pickCardFrom(
  game: Game, chooser: Player, target: Player, prompt: string,
): Promise<Card | null> {
  const zones: { label: string; cards: Card[] }[] = [];
  if (target.hand.length) zones.push({ label: `手牌(${target.hand.length}张,随机一张)`, cards: target.hand });
  // 装备区也带花色点数 —— 对方装了两匹马时,只写牌名就分不清是哪一张。
  // (判定区早就带了,这里一直不一致)
  for (const c of target.equipCards) zones.push({ label: `装备区 ${cardLabel(c)}`, cards: [c] });
  for (const c of target.judgeZone) zones.push({ label: `判定区 ${game.judgeLabel(target, c)}`, cards: [c] });
  if (!zones.length) return null;
  const idx = await game.agentOf(chooser).chooseOption(game, chooser, zones.map(z => z.label), prompt);
  const z = zones[Math.max(0, Math.min(idx, zones.length - 1))];
  return z.cards.length === 1 ? z.cards[0] : z.cards[game.rng.int(z.cards.length)];
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
  targetMax: (g, from) => 1 + g.sumQuery(from, 'slashExtraTargets', {}),
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
      const n = game.alivePlayers.length;
      const cards = game.drawFromDeck(n);
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
    && g.alivePlayers.some(v => v !== to && g.inAttackRange(to, v)),
  async onEffect({ game, use, from, to }) {
    const victims = game.alivePlayers.filter(v => v !== to && game.inAttackRange(to, v));
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
      await game.damage({ from: null, to: p, amount: 3, card: null, reason: '闪电' } as DamageEvent);
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

weapon('贯石斧', 3, [
  triggered({
    name: '贯石斧', desc: '【杀】被闪避后,可弃两张牌令伤害依然造成',
    timing: 'SlashMissed',
    filter: ({ self, event }) => {
      const e = event as TargetEvent;
      return e.from === self && [...self.hand, ...self.equipCards].length >= 2;
    },
    async effect({ game, self, event }) {
      const e = event as TargetEvent;
      const d = await game.askForDiscard(self, 2, '贯石斧:弃置两张牌令【杀】仍然造成伤害', { includeEquip: true });
      if (d.length === 2) e.use.tags[`force:${e.to.seat}`] = true;
    },
  }),
]);

weapon('方天画戟', 4, [
  staticSkill({
    name: '方天画戟', desc: '你的最后一张手牌当【杀】使用时,可以指定至多三个目标',
    queries: { slashExtraTargets: (g, self) => (self.hand.length <= 1 ? 2 : 0) },
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
 * 标准版牌堆(106 张)。按常见的标准版配比:基本牌 53 / 锦囊 35 / 装备 18。
 * 各版本印量略有出入,想调平衡(比如觉得桃太多、闪太少)直接改这张表就行。
 */
export const DECK_TABLE: DeckEntry[] = [
  // 【杀】30
  ...([[7], [8], [8], [9], [9], [10], [10]] as number[][]).map(([r]) => ['杀', '♠', r] as DeckEntry),
  ...([[10], [10], [11], [11]] as number[][]).map(([r]) => ['杀', '♥', r] as DeckEntry),
  ...([[2], [3], [4], [5], [6], [7], [8], [8], [9], [9], [10], [10], [11]] as number[][]).map(([r]) => ['杀', '♣', r] as DeckEntry),
  ...([[6], [7], [8], [9], [10], [11]] as number[][]).map(([r]) => ['杀', '♦', r] as DeckEntry),
  // 【闪】15
  ...([[2], [2], [13], [13]] as number[][]).map(([r]) => ['闪', '♥', r] as DeckEntry),
  ...([[2], [3], [4], [5], [6], [7], [8], [9], [10], [11], [11]] as number[][]).map(([r]) => ['闪', '♦', r] as DeckEntry),
  // 【桃】8
  ...([[3], [4], [5], [6], [7], [8], [9]] as number[][]).map(([r]) => ['桃', '♥', r] as DeckEntry),
  ['桃', '♦', 12],
  // 锦囊 35
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
  ['借刀杀人', '♣', 12], ['借刀杀人', '♣', 12],
  ['无懈可击', '♠', 11], ['无懈可击', '♣', 12], ['无懈可击', '♦', 12],
  ['乐不思蜀', '♠', 6], ['乐不思蜀', '♥', 6], ['乐不思蜀', '♣', 6],
  ['闪电', '♠', 1], ['闪电', '♥', 12],
  // 装备 18
  ['诸葛连弩', '♣', 1], ['诸葛连弩', '♦', 1],
  ['雌雄双股剑', '♠', 2],
  ['青釭剑', '♠', 6],
  ['青龙偃月刀', '♠', 5],
  ['丈八蛇矛', '♠', 12],
  ['贯石斧', '♦', 5],
  ['方天画戟', '♦', 12],
  ['麒麟弓', '♥', 5],
  ['八卦阵', '♠', 2], ['八卦阵', '♦', 2],
  ['仁王盾', '♣', 2],
  // 花色点数按官方标准版:防御马 = 的卢♣5 / 绝影♠5 / 爪黄飞电♥13
  //                      进攻马 = 赤兔♥5 / 大宛♠13 / 紫骍♦13
  ['防御马', '♣', 5], ['防御马', '♠', 5], ['防御马', '♥', 13],
  ['进攻马', '♥', 5], ['进攻马', '♠', 13], ['进攻马', '♦', 13],
];

export function buildDeck(): Card[] {
  let id = 1;
  return DECK_TABLE.map(([name, suit, rank]) => {
    if (!getSpec(name)) throw new Error(`牌堆里有未定义的牌:${name}`);
    return { id: id++, name, suit, rank };
  });
}
