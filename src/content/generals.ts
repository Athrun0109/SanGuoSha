/**
 * 标准包 25 名武将。
 *
 * ★ 这是你 DIY 的主战场。每个技能都是自包含的:改一个技能不会影响别的。
 *   常见改法举例:
 *     - 削弱:给技能加 limit: 'once-per-turn'
 *     - 加强:改 effect 里的数值,或放宽 filter 条件
 *     - 重做:整段替换 effect,只要用的还是 game 上那些原子操作即可
 *   改完直接 npm run sim 跑几百局看胜率变化。
 */

import { cardLabel, suitColor, viewAsCard, VirtualCard, Card } from '../core/types.js';
import type {
  AskForCardEvent, CardUseEvent, CardsMovedEvent, DamageEvent, DrawNumberEvent,
  DyingEvent, HpEvent, JudgeEvent, PhaseEvent, TargetEvent,
} from '../core/events.js';
import { defineGeneral, cardSpecs } from '../core/registry.js';
import { pickCardFrom } from './cards.js';
import { active, staticSkill, triggered, viewAs } from '../core/skill.js';
import type { Player } from '../core/player.js';
import type { Game } from '../core/game.js';

/** 从某人手牌随机抽一张(手牌暗置) */
function randomHandCard(game: Game, p: Player): Card | null {
  if (!p.hand.length) return null;
  return p.hand[game.rng.int(p.hand.length)];
}

const isRed = (c: Card) => suitColor(c.suit) === 'red';
const isBlack = (c: Card) => suitColor(c.suit) === 'black';

// ==================== 魏 ====================

defineGeneral({
  name: '曹操', kingdom: 'wei', gender: 'male', hp: 4,
  skills: [
    triggered({
      name: '奸雄', desc: '你受到伤害后,可以获得对你造成伤害的牌',
      timing: 'DamageDone',
      filter: ({ game, self, event }) => {
        const e = event as DamageEvent;
        if (e.to !== self || !e.card) return false;
        return e.card.cards.some(c => game.processing.includes(c) || game.discardPile.includes(c));
      },
      async effect({ game, self, event }) {
        const e = event as DamageEvent;
        const cards = e.card!.cards.filter(c => game.processing.includes(c) || game.discardPile.includes(c));
        await game.gainCards(self, cards, '奸雄');
        for (const c of cards) game.revealToAll(c, self); // 那张牌刚打出来过,全场可见
        game.log(`  ${self.name} 奸雄获得 ${cards.map(cardLabel).join('、')}`);
      },
    }),
    triggered({
      name: '护驾', desc: '主公技。你需要使用或打出【闪】时,其他魏势力角色可以替你打出',
      lordSkill: true,
      timing: 'AskingForCard',
      filter: ({ game, self, event }) => {
        const e = event as AskForCardEvent;
        return e.player === self && e.purpose === 'dodge' && !e.result
          && game.others(self).some(p => p.kingdom === 'wei');
      },
      async effect({ game, self, event }) {
        const e = event as AskForCardEvent;
        for (const p of game.playersFrom(self, false)) {
          if (p.kingdom !== 'wei') continue;
          const vc = await game.askForCard(p, { names: ['闪'] }, 'dodge', `护驾:是否替主公 ${self.name} 打出【闪】?`);
          if (vc) { e.result = vc; return; }
        }
      },
    }),
  ],
});

defineGeneral({
  name: '司马懿', kingdom: 'wei', gender: 'male', hp: 3,
  skills: [
    triggered({
      name: '反馈', desc: '你受到伤害后,可以获得伤害来源的一张牌',
      timing: 'DamageDone',
      filter: ({ self, event }) => {
        const e = event as DamageEvent;
        return e.to === self && !!e.from && e.from.alive && e.from.allCards.length > 0;
      },
      async effect({ game, self, event }) {
        const e = event as DamageEvent;
        // FAQ:「判定区的牌不属于伤害来源的牌」—— 反馈只能拿手牌和装备
        const c = await pickCardFrom(game, self, e.from!, `反馈:获得 ${e.from!.name} 的一张牌`,
          { judgeZone: false });
        if (c) await game.gainCards(self, [c], '反馈');
      },
    }),
    triggered({
      name: '鬼才', desc: '在一名角色的判定牌生效前,你可以打出一张手牌代替之',
      timing: 'JudgeResulting',
      filter: ({ self }) => self.hand.length > 0,
      async effect({ game, self, event }) {
        const e = event as JudgeEvent;
        const chosen = await game.agentOf(self).chooseCards(
          game, self, [...self.hand], 1, 1,
          `鬼才:选一张手牌替换 ${e.player.name} 的判定牌 ${cardLabel(e.card)}(原因:${e.reason})`,
        );
        if (!chosen.length) return;
        const old = e.card;
        await game.moveCards(chosen, null, 'processing', '鬼才');
        e.card = chosen[0];
        if (game.processing.includes(old)) await game.discardCards([old], '鬼才替换');
        // 写全:谁发动的、拿什么换、换掉了谁的哪张判定牌 —— 这一行要能独立成立,
        // 因为发给 LLM 的战报会把上面那条通用的"发动【鬼才】"删掉。
        // 改判定是推身份的强证据(肯掏牌保谁 / 肯掏牌害谁),不能被精简掉。
        game.log(`  ${self.name} 用 ${cardLabel(e.card)} 替换 ` +
          `${e.player.name} 的判定牌 ${cardLabel(old)}(鬼才)`);
      },
    }),
  ],
});

defineGeneral({
  name: '夏侯惇', kingdom: 'wei', gender: 'male', hp: 4,
  skills: [
    triggered({
      name: '刚烈', desc: '你受到伤害后,可以判定:若结果不为♥,伤害来源须弃两张手牌或受到你造成的1点伤害',
      timing: 'DamageDone',
      filter: ({ self, event }) => {
        const e = event as DamageEvent;
        return e.to === self && !!e.from && e.from.alive;
      },
      async effect({ game, self, event }) {
        const e = event as DamageEvent;
        const src = e.from!;
        const jr = await game.judge(self, '刚烈', c => c.suit !== '♥');
        if (!jr.success) return;
        let discarded = false;
        if (src.hand.length >= 2) {
          const idx = await game.agentOf(src).chooseOption(
            game, src, ['弃置两张手牌', `受到 ${self.name} 的1点伤害`], '刚烈发动',
          );
          if (idx === 0) discarded = (await game.askForDiscard(src, 2, '刚烈:弃置两张手牌')).length === 2;
        }
        if (!discarded) {
          await game.damage({ from: self, to: src, amount: 1, card: null, reason: '刚烈' } as DamageEvent);
        }
      },
    }),
  ],
});

defineGeneral({
  name: '张辽', kingdom: 'wei', gender: 'male', hp: 4,
  skills: [
    triggered({
      name: '突袭', desc: '摸牌阶段,你可以放弃摸牌,改为获得至多两名其他角色各一张手牌',
      timing: 'DrawNumber',
      filter: ({ game, self, event }) => {
        const e = event as DrawNumberEvent;
        return e.player === self && game.others(self).some(p => p.hand.length > 0);
      },
      async effect({ game, self, event }) {
        const e = event as DrawNumberEvent;
        const cands = game.others(self).filter(p => p.hand.length > 0);
        const chosen = await game.agentOf(self).choosePlayers(
          game, self, cands, 1, Math.min(2, cands.length), '突袭:选择至多两名角色各获得一张手牌',
        );
        if (!chosen.length) return;
        e.cancel = true;
        for (const p of chosen) {
          const c = randomHandCard(game, p);
          if (c) {
            await game.gainCards(self, [c], '突袭');
            game.log(`  ${self.name} 突袭获得了 ${p.name} 的一张手牌`);
          }
        }
      },
    }),
  ],
});

defineGeneral({
  name: '许褚', kingdom: 'wei', gender: 'male', hp: 4,
  skills: [
    triggered({
      name: '裸衣', desc: '摸牌阶段,你可以少摸一张牌,若如此做,本回合你的【杀】和【决斗】伤害+1',
      timing: 'DrawNumber',
      filter: ({ self, event }) => {
        const e = event as DrawNumberEvent;
        return e.player === self && e.num > 0;
      },
      effect({ self, event }) {
        (event as DrawNumberEvent).num -= 1;
        self.setMark('turn:裸衣', 1);
      },
    }),
    triggered({
      name: '裸衣', compulsory: true,
      timing: 'DamageInflicting',
      filter: ({ self, event }) => {
        const e = event as DamageEvent;
        return e.from === self && self.mark('turn:裸衣') > 0
          && (e.card?.name === '杀' || e.card?.name === '决斗');
      },
      effect({ event }) { (event as DamageEvent).amount += 1; },
    }),
  ],
});

defineGeneral({
  name: '郭嘉', kingdom: 'wei', gender: 'male', hp: 3,
  skills: [
    triggered({
      name: '天妒', desc: '你的判定牌生效后,你可以获得之',
      timing: 'JudgeResulted',
      filter: ({ self, event }) => (event as JudgeEvent).player === self,
      async effect({ game, self, event }) {
        const e = event as JudgeEvent;
        e.taken = true;
        await game.gainCards(self, [e.card], '天妒');
        game.revealToAll(e.card, self); // 判定牌是明置的
      },
    }),
    triggered({
      name: '遗计', desc: '你受到1点伤害后,可以观看牌堆顶两张牌并任意分配',
      timing: 'DamageDone',
      filter: ({ self, event }) => (event as DamageEvent).to === self,
      async effect({ game, self, event }) {
        const e = event as DamageEvent;
        for (let i = 0; i < e.amount; i++) {
          const cards = game.drawFromDeck(2);
          game.processing.push(...cards);
          for (const c of cards) {
            const chosen = await game.agentOf(self).choosePlayers(
              game, self, game.alivePlayers, 1, 1, `遗计:将 ${cardLabel(c)} 交给哪名角色?`,
            );
            await game.gainCards(chosen[0] ?? self, [c], '遗计');
          }
        }
      },
    }),
  ],
});

defineGeneral({
  name: '甄姬', kingdom: 'wei', gender: 'female', hp: 3,
  skills: [
    viewAs({
      name: '倾国', desc: '你可以将一张黑色手牌当【闪】使用或打出',
      produces: ['闪'],
      cardCount: 1,
      cardFilter: (g, self, card) => isBlack(card),
      available: () => true,
      viewAs: (g, self, cards) => viewAsCard('闪', cards, '倾国'),
    }),
    triggered({
      name: '洛神', desc: '准备阶段,你可以判定:若为黑色,你获得之并可以重复此流程',
      timing: 'PhaseStart',
      filter: ({ self, event }) => {
        const e = event as PhaseEvent;
        return e.player === self && e.phase === 'start';
      },
      async effect({ game, self }) {
        for (let i = 0; i < 20; i++) {
          const jr = await game.judge(self, '洛神', c => isBlack(c));
          if (!jr.success) break;
          jr.taken = true;
          await game.gainCards(self, [jr.card], '洛神');
          game.revealToAll(jr.card, self); // 判定牌是明置的
          const again = await game.agentOf(self).chooseOption(
            game, self, ['继续洛神', '停止'], '洛神:是否继续?',
          );
          if (again !== 0) break;
        }
      },
    }),
  ],
});

// ==================== 蜀 ====================

defineGeneral({
  name: '刘备', kingdom: 'shu', gender: 'male', hp: 4,
  skills: [
    active({
      name: '仁德', desc: '出牌阶段,你可以将任意张手牌交给其他角色;以此法给出两张后回复1点体力(每回合限一次)',
      canUse: (g, self) => self.hand.length > 0 && g.others(self).length > 0,
      async onUse(game, self) {
        const cards = await game.agentOf(self).chooseCards(
          game, self, [...self.hand], 1, self.hand.length, '仁德:选择要交给他人的手牌',
          { cancelable: true },
        );
        if (!cards.length) return false;
        const chosen = await game.agentOf(self).choosePlayers(
          game, self, game.others(self), 1, 1, '仁德:交给哪名角色?',
        );
        if (!chosen.length) return false;
        await game.gainCards(chosen[0], cards, '仁德');
        game.log(`  ${self.name} 将 ${cards.length} 张牌交给 ${chosen[0].name}`);
        /*
         * 给满两张回 1 血,每回合限一次。
         *
         * 张数是**本回合累计**的,不是单次 —— 分两次各给一张同样算数,
         * 这也是仁德真正的用法(一张一张喂,凑够两张顺带回血)。
         */
        self.addMark('turn:仁德给出', cards.length);
        if (self.mark('turn:仁德给出') >= 2 && !self.mark('turn:仁德回血')) {
          self.setMark('turn:仁德回血', 1);
          await game.recover(self, 1, self, '仁德');
        }
      },
    }),
    triggered({
      name: '激将', desc: '主公技。你需要使用或打出【杀】时,其他蜀势力角色可以替你打出',
      lordSkill: true,
      timing: 'AskingForCard',
      filter: ({ game, self, event }) => {
        const e = event as AskForCardEvent;
        return e.player === self && e.purpose === 'slash' && !e.result
          && game.others(self).some(p => p.kingdom === 'shu');
      },
      async effect({ game, self, event }) {
        const e = event as AskForCardEvent;
        for (const p of game.playersFrom(self, false)) {
          if (p.kingdom !== 'shu') continue;
          const vc = await game.askForCard(p, { names: ['杀'] }, 'slash', `激将:是否替主公 ${self.name} 打出【杀】?`);
          if (vc) { e.result = vc; return; }
        }
      },
    }),
  ],
});

defineGeneral({
  name: '关羽', kingdom: 'shu', gender: 'male', hp: 4,
  skills: [
    viewAs({
      name: '武圣', desc: '你可以将一张红色牌当【杀】使用或打出',
      // 「牌」不限于手牌 —— 装备区里的也算(官方裁定,见 ViewAsSkill.zone)
      zone: 'all',
      produces: ['杀'],
      cardCount: 1,
      cardFilter: (g, self, card) => isRed(card),
      available: () => true,
      viewAs: (g, self, cards) => viewAsCard('杀', cards, '武圣'),
    }),
  ],
});

defineGeneral({
  name: '张飞', kingdom: 'shu', gender: 'male', hp: 4,
  skills: [
    staticSkill({
      name: '咆哮', desc: '锁定技,你使用【杀】无次数限制',
      compulsory: true,
      queries: { noSlashLimit: () => true },
    }),
  ],
});

defineGeneral({
  name: '诸葛亮', kingdom: 'shu', gender: 'male', hp: 3,
  skills: [
    triggered({
      name: '观星', desc: '准备阶段,你可以观看牌堆顶X张牌(X为存活人数,至多5),重新排列后置于牌堆顶或底',
      timing: 'PhaseStart',
      filter: ({ self, event }) => {
        const e = event as PhaseEvent;
        return e.player === self && e.phase === 'start';
      },
      async effect({ game, self }) {
        const x = Math.min(5, game.alivePlayers.length);
        const cards = game.drawFromDeck(x);
        const { top, bottom } = await game.agentOf(self).arrangeCards(
          game, self, cards, `观星:${x} 张牌,决定哪些放牌堆顶(先放的先摸)`,
        );
        game.putOnDeckTop(top);
        game.putOnDeckBottom(bottom);
        game.log(`  ${self.name} 观星:${top.length} 张置于牌堆顶,${bottom.length} 张置于牌堆底`);
      },
    }),
    staticSkill({
      name: '空城', desc: '锁定技,若你没有手牌,你不能成为【杀】或【决斗】的目标',
      compulsory: true,
      queries: {
        prohibitTarget: (g, self, ctx) =>
          self.hand.length === 0 && (ctx.card.name === '杀' || ctx.card.name === '决斗'),
      },
    }),
  ],
});

defineGeneral({
  name: '赵云', kingdom: 'shu', gender: 'male', hp: 4,
  skills: [
    viewAs({
      name: '龙胆', desc: '你可以将【杀】当【闪】、【闪】当【杀】使用或打出',
      produces: ['杀', '闪'],
      cardCount: 1,
      cardFilter: (g, self, card) => card.name === '杀' || card.name === '闪',
      available: () => true,
      viewAs: (g, self, cards) => {
        const c = cards[0];
        if (c.name === '杀') return viewAsCard('闪', cards, '龙胆');
        if (c.name === '闪') return viewAsCard('杀', cards, '龙胆');
        return null;
      },
    }),
  ],
});

defineGeneral({
  name: '马超', kingdom: 'shu', gender: 'male', hp: 4,
  skills: [
    staticSkill({
      name: '马术', desc: '锁定技,你计算与其他角色的距离时 -1',
      compulsory: true,
      queries: { distanceDelta: () => -1 },
    }),
    triggered({
      name: '铁骑', desc: '你使用【杀】指定目标后,可以判定:若为红色,该角色不能使用【闪】',
      timing: 'TargetConfirmed',
      filter: ({ self, event }) => {
        const e = event as TargetEvent;
        return e.from === self && e.use.card.name === '杀';
      },
      async effect({ game, self, event }) {
        const e = event as TargetEvent;
        const jr = await game.judge(self, '铁骑', c => isRed(c));
        if (jr.success) {
          e.use.unavoidable!.add(e.to);
          game.log(`  铁骑生效,${e.to.name} 不能闪避`);
        }
      },
    }),
  ],
});

defineGeneral({
  name: '黄月英', kingdom: 'shu', gender: 'female', hp: 3,
  skills: [
    triggered({
      name: '集智', desc: '你每使用一张锦囊牌,可以摸一张牌',
      timing: 'CardUsed',
      filter: ({ self, event }) => {
        const e = event as CardUseEvent;
        return e.from === self && cardSpecs.get(e.card.name)?.type === 'trick';
      },
      async effect({ game, self }) { await game.drawCards(self, 1, '集智'); },
    }),
    staticSkill({
      name: '奇才', desc: '锁定技,你使用锦囊牌无距离限制',
      compulsory: true,
      queries: {
        ignoreDistance: (g, self, ctx) => cardSpecs.get(ctx.card.name)?.type === 'trick',
      },
    }),
  ],
});

// ==================== 吴 ====================

defineGeneral({
  name: '孙权', kingdom: 'wu', gender: 'male', hp: 4,
  skills: [
    active({
      name: '制衡', desc: '出牌阶段限一次,你可以弃置任意张牌,然后摸等量的牌',
      limit: 'once-per-turn',
      canUse: (g, self) => self.hand.length + self.equipCards.length > 0,
      async onUse(game, self) {
        const pool = [...self.hand, ...self.equipCards];
        const cards = await game.agentOf(self).chooseCards(
          game, self, pool, 1, pool.length, '制衡:弃置任意张牌', { cancelable: true },
        );
        if (!cards.length) return false;
        await game.discardCards(cards, '制衡');
        await game.drawCards(self, cards.length, '制衡');
      },
    }),
    triggered({
      name: '救援', desc: '主公技。其他吴势力角色对你使用【桃】时,你多回复1点体力(每轮每人限一次)',
      lordSkill: true, compulsory: true,
      timing: 'HpRecovered',
      filter: ({ self, event }) => {
        const e = event as HpEvent;
        return e.player === self && e.reason === '桃' && !!e.source && e.source !== self
          && e.source.kingdom === 'wu' && self.mark(`round:救援:${e.source.seat}`) === 0;
      },
      async effect({ game, self, event }) {
        const e = event as HpEvent;
        self.addMark(`round:救援:${e.source!.seat}`);
        await game.recover(self, 1, e.source, '救援');
      },
    }),
  ],
});

defineGeneral({
  name: '甘宁', kingdom: 'wu', gender: 'male', hp: 4,
  skills: [
    viewAs({
      name: '奇袭', desc: '你可以将一张黑色牌当【过河拆桥】使用',
      // 「牌」不限于手牌 —— 装备区里的也算(官方裁定,见 ViewAsSkill.zone)
      zone: 'all',
      produces: ['过河拆桥'],
      cardCount: 1,
      cardFilter: (g, self, card) => isBlack(card),
      available: (g, self, ctx) => ctx.mode === 'play',
      viewAs: (g, self, cards) => viewAsCard('过河拆桥', cards, '奇袭'),
    }),
  ],
});

/**
 * 【克己】的屯牌上限 —— **房规,不是官方规则**。
 *
 * 官方【克己】是"跳过弃牌阶段",手牌可以无限涨。实测(规则 AI 互打 3000 局 8 人局):
 * 全场手牌峰值中位 8、p90 11,**但最大出现过 66 张**,而那 66 张就是吕蒙。
 *
 * 屯到那个量级有三个问题:
 *   界面   自己的手牌一行约放 12 张,40 张就开始挤压战报区,100 张直接压垮布局
 *   token  104 张手牌时 L2 局面 1149 字、出牌阶段 **77 个选项**、题面 981 字,
 *          比正常手牌每次决策多烧约 1500 字 —— 而且是每一次决策都多
 *   体验   那种局面对其他人基本就是垃圾时间
 *
 * 所以把【克己】从"跳过弃牌阶段"改成"**本回合手牌上限视为 32**":
 * 32 张以内和原来完全一样(p90 才 11,九成对局根本碰不到这条),
 * 超过了才开始弃 —— 只在真的失控时才咬。
 *
 * 强度上不需要为此削他:3000 局登场胜率 44.4%,和华佗 45.6%、张飞 43.4% 并列
 * 第一梯队,在噪声范围内,不是超模。
 */
export const KEJI_HAND_CAP = 32;

defineGeneral({
  name: '吕蒙', kingdom: 'wu', gender: 'male', hp: 4,
  skills: [
    triggered({
      name: '克己',
      desc: `若你未于出牌阶段内使用或打出过【杀】,你可以令本回合手牌上限视为 ${KEJI_HAND_CAP}(房规上限)`,
      timing: 'PhaseStart',
      filter: ({ game, self, event }) => {
        const e = event as PhaseEvent;
        // 上限用 game.maxHand 而不是 self.hp —— 以后有技能改手牌上限时才不会错
        return e.player === self && e.phase === 'discard' && self.mark('turn:playedSlash') === 0
          && self.handCount > game.maxHand(self);
      },
      effect({ self }) { self.setMark('turn:克己', 1); },
    }),
    staticSkill({
      name: '克己·上限',
      // 发动了克己的回合,手牌上限抬到 KEJI_HAND_CAP。走的是引擎现成的 maxHand 杠杆,
      // 弃牌阶段自然会按新的上限来弃(超过 32 张才弃,弃到 32 为止)
      queries: {
        maxHand: (g, self) =>
          (self.mark('turn:克己') ? Math.max(0, KEJI_HAND_CAP - self.hp) : 0),
      },
    }),
  ],
});

defineGeneral({
  name: '黄盖', kingdom: 'wu', gender: 'male', hp: 4,
  skills: [
    active({
      name: '苦肉', desc: '出牌阶段,你可以失去1点体力,然后摸两张牌',
      canUse: (g, self) => self.alive,
      async onUse(game, self) {
        await game.loseHp(self, 1, '苦肉');
        if (self.alive) await game.drawCards(self, 2, '苦肉');
      },
    }),
  ],
});

defineGeneral({
  name: '周瑜', kingdom: 'wu', gender: 'male', hp: 3,
  skills: [
    triggered({
      name: '英姿', desc: '锁定技,摸牌阶段,你多摸一张牌',
      compulsory: true,
      timing: 'DrawNumber',
      filter: ({ self, event }) => (event as DrawNumberEvent).player === self,
      effect({ event }) { (event as DrawNumberEvent).num += 1; },
    }),
    active({
      name: '反间', desc: '出牌阶段限一次,令一名其他角色选择一种花色,然后其获得你的一张手牌并展示;若花色不符,该角色受到你的1点伤害',
      limit: 'once-per-turn',
      canUse: (g, self) => self.hand.length > 0 && g.others(self).length > 0,
      async onUse(game, self) {
        const chosen = await game.agentOf(self).choosePlayers(
          game, self, game.others(self), 1, 1, '反间:选择目标',
        );
        const target = chosen[0];
        if (!target) return;
        const suit = await game.agentOf(target).chooseSuit(game, target, '反间:请选择一种花色');
        // FAQ:「如果有多张手牌,牌的放置顺序**由周瑜决定**」—— 给哪张是反间的技术含量
        // 所在(给一张你希望对方猜错花色的牌),以前这里是随机抽,等于把技能废掉一半
        const picked = await game.agentOf(self).chooseCards(
          game, self, [...self.hand], 1, 1, `反间:选择一张手牌交给 ${target.name}`,
        );
        const card = picked[0] ?? randomHandCard(game, self);
        if (!card) return;
        game.log(`  ${target.name} 选择了 ${suit},展示的牌是 ${cardLabel(card)}`);
        await game.gainCards(target, [card], '反间');
        game.revealToAll(card, target); // 反间要展示这张牌
        if (card.suit !== suit) {
          await game.damage({ from: self, to: target, amount: 1, card: null, reason: '反间' } as DamageEvent);
        }
      },
    }),
  ],
});

defineGeneral({
  name: '大乔', kingdom: 'wu', gender: 'female', hp: 3,
  skills: [
    viewAs({
      name: '国色', desc: '你可以将一张♦牌当【乐不思蜀】使用',
      // 「牌」不限于手牌 —— 装备区里的也算(官方裁定,见 ViewAsSkill.zone)
      zone: 'all',
      produces: ['乐不思蜀'],
      cardCount: 1,
      cardFilter: (g, self, card) => card.suit === '♦',
      available: (g, self, ctx) => ctx.mode === 'play',
      viewAs: (g, self, cards) => viewAsCard('乐不思蜀', cards, '国色'),
    }),
    triggered({
      name: '流离', desc: '当你成为【杀】的目标时,你可以弃置一张牌,将此【杀】转移给你攻击范围内的一名其他角色',
      timing: 'TargetConfirming',
      filter: ({ game, self, event }) => {
        const e = event as TargetEvent;
        if (e.to !== self || e.use.card.name !== '杀') return false;
        if (self.allCards.length === 0) return false;
        return game.alivePlayers.some(p =>
          p !== self && p !== e.from && game.inAttackRange(self, p) && !e.use.targets.includes(p));
      },
      async effect({ game, self, event }) {
        const e = event as TargetEvent;
        /*
         * **先弃牌,再算攻击范围。**
         *
         * FAQ:「可以弃置装备区里的装备牌,但是计算其他角色是否在攻击范围内时,
         * 不可以将弃置的牌算入。」—— 弃掉进攻马之后射程会缩短,按弃牌前的范围
         * 给候选就等于凭空多了一格。以前这里顺序是反的。
         */
        const reachable = () => game.alivePlayers.filter(p =>
          p !== self && p !== e.from && game.inAttackRange(self, p) && !e.use.targets.includes(p));
        if (!reachable().length) return;
        const d = await game.askForDiscard(self, 1, '流离:弃置一张牌以转移【杀】', { includeEquip: true });
        if (!d.length) return;
        const cands = reachable();
        if (!cands.length) {
          game.log(`  ${self.name} 弃牌后已无人在攻击范围内,【流离】未能转移`);
          return;
        }
        const chosen = await game.agentOf(self).choosePlayers(game, self, cands, 1, 1, '流离:转移给谁?');
        if (chosen[0]) {
          e.to = chosen[0];
          game.log(`  【杀】被【流离】转移给 ${chosen[0].name}`);
        }
      },
    }),
  ],
});

defineGeneral({
  name: '陆逊', kingdom: 'wu', gender: 'male', hp: 3,
  skills: [
    staticSkill({
      name: '谦逊', desc: '锁定技,你不能成为【顺手牵羊】和【乐不思蜀】的目标',
      compulsory: true,
      queries: {
        prohibitTarget: (g, self, ctx) =>
          ctx.card.name === '顺手牵羊' || ctx.card.name === '乐不思蜀',
      },
    }),
    triggered({
      name: '连营', desc: '当你失去最后的手牌时,你可以摸一张牌',
      timing: 'CardsMoved',
      filter: ({ self, event }) => {
        const e = event as CardsMovedEvent;
        return self.hand.length === 0
          && e.moves.some(m => m.from === self && m.fromZone === 'hand');
      },
      async effect({ game, self }) { await game.drawCards(self, 1, '连营'); },
    }),
  ],
});

defineGeneral({
  name: '孙尚香', kingdom: 'wu', gender: 'female', hp: 3,
  skills: [
    active({
      name: '结姻', desc: '出牌阶段限一次,你可以弃置两张手牌,令一名已受伤的男性角色与你各回复1点体力',
      limit: 'once-per-turn',
      canUse: (g, self) => self.hand.length >= 2
        && g.others(self).some(p => p.gender === 'male' && p.isWounded),
      async onUse(game, self) {
        const cands = game.others(self).filter(p => p.gender === 'male' && p.isWounded);
        if (!cands.length) return false;
        const d = await game.askForDiscard(self, 2, '结姻:弃置两张手牌', { cancelable: true });
        if (d.length < 2) return false;
        const chosen = await game.agentOf(self).choosePlayers(game, self, cands, 1, 1, '结姻:选择一名已受伤的男性角色');
        if (!chosen[0]) return false;
        await game.recover(chosen[0], 1, self, '结姻');
        await game.recover(self, 1, self, '结姻');
      },
    }),
    triggered({
      name: '枭姬', desc: '当你失去装备区里的一张牌时,你可以摸两张牌',
      timing: 'CardsMoved',
      filter: ({ self, event }) => {
        const e = event as CardsMovedEvent;
        return e.moves.some(m => m.from === self && m.fromZone === 'equip');
      },
      async effect({ game, self, event }) {
        const e = event as CardsMovedEvent;
        const n = e.moves.filter(m => m.from === self && m.fromZone === 'equip').length;
        await game.drawCards(self, 2 * n, '枭姬');
      },
    }),
  ],
});

// ==================== 群 ====================

defineGeneral({
  name: '华佗', kingdom: 'qun', gender: 'male', hp: 3,
  skills: [
    active({
      name: '青囊', desc: '出牌阶段限一次,你可以弃置一张手牌,令一名已受伤的角色回复1点体力',
      limit: 'once-per-turn',
      canUse: (g, self) => self.hand.length > 0 && g.alivePlayers.some(p => p.isWounded),
      async onUse(game, self) {
        const cands = game.alivePlayers.filter(p => p.isWounded);
        if (!cands.length) return false;
        const d = await game.askForDiscard(self, 1, '青囊:弃置一张手牌', { cancelable: true });
        if (!d.length) return false;
        const chosen = await game.agentOf(self).choosePlayers(game, self, cands, 1, 1, '青囊:令谁回复1点体力?');
        if (chosen[0]) await game.recover(chosen[0], 1, self, '青囊');
      },
    }),
    triggered({
      name: '急救', desc: '你的回合外,你可以弃置一张红色牌,令一名处于濒死状态的角色回复1点体力',
      timing: 'Dying',
      filter: ({ game, self, event }) => {
        const e = event as DyingEvent;
        return game.current !== self && e.player.hp <= 0
          && [...self.hand, ...self.equipCards].some(isRed);
      },
      async effect({ game, self, event }) {
        const e = event as DyingEvent;
        const pool = [...self.hand, ...self.equipCards].filter(isRed);
        const chosen = await game.agentOf(self).chooseCards(game, self, pool, 1, 1, '急救:弃置一张红色牌');
        if (!chosen.length) return;
        await game.discardCards(chosen, '急救');
        await game.recover(e.player, 1, self, '急救');
      },
    }),
  ],
});

defineGeneral({
  name: '吕布', kingdom: 'qun', gender: 'male', hp: 4,
  skills: [
    staticSkill({
      name: '无双', desc: '锁定技。你使用【杀】时目标需连续打出两张【闪】;与你决斗的角色每次需打出两张【杀】',
      compulsory: true,
      queries: {
        extraDodge: () => 1,
        extraSlash: () => 1,
      },
    }),
  ],
});

defineGeneral({
  name: '貂蝉', kingdom: 'qun', gender: 'female', hp: 3,
  skills: [
    active({
      name: '离间', desc: '出牌阶段限一次,你可以弃置一张牌,令两名男性角色决斗(先选的先出【杀】,不可被【无懈可击】)',
      limit: 'once-per-turn',
      canUse: (g, self) => self.allCards.length > 0
        && g.others(self).filter(p => p.gender === 'male').length >= 2,
      async onUse(game, self) {
        const males = game.others(self).filter(p => p.gender === 'male');
        if (males.length < 2) return;
        // 弃牌这一步可以反悔:交空数组就等于点了"取消",本回合的机会不会被吃掉
        const d = await game.askForDiscard(self, 1, '离间:弃置一张牌', {
          includeEquip: true, cancelable: true,
        });
        if (!d.length) return false;
        const chosen = await game.agentOf(self).choosePlayers(
          game, self, males, 2, 2, '离间:选择两名男性角色(先选的那名先出【杀】)', { ordered: true });
        if (chosen.length < 2) return false;
        const vc: VirtualCard = { name: '决斗', suit: 'none', rank: 0, cards: [], skill: '离间' };
        /*
         * **先选的那名要当【决斗】的目标,所以他必须能成为目标。**
         *
         * FAQ:「貂蝉能否指定空城状态下的诸葛亮为【离间】的对象之一?**可以,但是
         * 必须指定诸葛亮为决斗的发起方(即对方先出杀)。**」
         *
         * 空城的诸葛亮不能成为【决斗】的目标,换句话说他只能排在后面。官方那句话
         * 其实只留下了一种合法排布,所以这里发现顺序不合法就自动倒过来 ——
         * 但要在战报里说清楚,别让人以为自己点的顺序被无声改掉了。
         */
        let [first, second] = chosen;
        if (!game.canTarget(second, first, vc, [])) {
          if (game.canTarget(first, second, vc, [])) {
            game.log(`  ${first.name} 不能成为【决斗】的目标,改由他先出【杀】`);
            [first, second] = [second, first];
          } else {
            game.log(`  两名角色都不能成为【决斗】的目标,【离间】未能生效`);
            return false;
          }
        }
        chosen[0] = first;
        chosen[1] = second;
        /*
         * **方向:后选的那名视为对先选的那名使用【决斗】。**
         *
         * 决斗是"目标先出杀,双方轮流",所以谁当目标谁就先出 —— 想让**先选的先出杀**,
         * 就得让他当目标。选人的顺序因此是有意义的,不能被引擎替玩家定
         * (那道题两个候选、要选两个,以前会被"只有一个合法解"直接跳过,
         *  于是永远按座位号排,先手优势稳定送给座位靠前的那个人)。
         */
        game.log(`  ${self.name} 离间:${chosen[1].name} 对 ${chosen[0].name} 使用【决斗】` +
          `(${chosen[0].name} 先出【杀】)`);
        const use = game.makeUse(vc, chosen[1], [chosen[0]]);
        // 离间本身不是锦囊牌,视为使用的这张决斗按基础版规则不可被【无懈可击】
        use.nullifiable = false;
        await game.useCard(use);
      },
    }),
    triggered({
      name: '闭月', desc: '结束阶段,你可以摸一张牌',
      timing: 'PhaseStart',
      filter: ({ self, event }) => {
        const e = event as PhaseEvent;
        return e.player === self && e.phase === 'end';
      },
      async effect({ game, self }) { await game.drawCards(self, 1, '闭月'); },
    }),
  ],
});

export const STANDARD_GENERALS = [
  '曹操', '司马懿', '夏侯惇', '张辽', '许褚', '郭嘉', '甄姬',
  '刘备', '关羽', '张飞', '诸葛亮', '赵云', '马超', '黄月英',
  '孙权', '甘宁', '吕蒙', '黄盖', '周瑜', '大乔', '陆逊', '孙尚香',
  '华佗', '吕布', '貂蝉',
];

/** 可以当主公的武将(有主公技的优先) */
export const LORD_GENERALS = ['曹操', '刘备', '孙权'];
