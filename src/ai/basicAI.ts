/**
 * 规则型 AI。
 *
 * 设计原则:所有判断都基于"公开信息"——主公身份公开、伤害记录公开、
 * 存活/手牌数/装备公开。AI 不偷看别人的手牌和身份,靠 hostilityLog 推测阵营。
 *
 * 想让 AI 变强,主要改三处:
 *   1) attitude()   —— 身份推测(现在很粗糙,可换成贝叶斯/评分表)
 *   2) CARD_VALUE   —— 牌的价值表(影响弃牌、留牌、响应选择)
 *   3) scoreAction()—— 出牌阶段的动作评分(主决策)
 */

import type { Agent, CardOption, OptionCtx, PlayAction, ResponseCtx } from '../core/agent.js';
import { agentRng, type Game, type RNG } from '../core/game.js';
import type { Player } from '../core/player.js';
import { Card, Suit, SUITS, VirtualCard, suitColor } from '../core/types.js';
import { cardSpecs } from '../core/registry.js';
import type { JudgeEvent } from '../core/events.js';

const CARD_VALUE: Record<string, number> = {
  桃: 100, 无懈可击: 62, 闪: 55, 杀: 46,
  无中生有: 60, 五谷丰登: 42, 桃园结义: 45,
  决斗: 40, 过河拆桥: 42, 顺手牵羊: 44,
  南蛮入侵: 36, 万箭齐发: 36, 借刀杀人: 26,
  乐不思蜀: 32, 闪电: 12,
  诸葛连弩: 55, 青龙偃月刀: 45, 贯石斧: 42, 方天画戟: 38, 麒麟弓: 40,
  雌雄双股剑: 36, 青釭剑: 38, 丈八蛇矛: 40,
  八卦阵: 48, 仁王盾: 44,
  赤兔: 40, 的卢: 40, 爪黄飞电: 40, 绝影: 38, 大宛: 38, 紫骍: 38,
};

const HARMFUL = new Set(['杀', '决斗', '过河拆桥', '顺手牵羊', '南蛮入侵', '万箭齐发', '乐不思蜀', '闪电', '借刀杀人']);
const HELPFUL = new Set(['桃', '桃园结义', '五谷丰登', '无中生有']);

function cardValue(c: Card | VirtualCard): number {
  return CARD_VALUE[c.name] ?? 30;
}

function vcValue(v: VirtualCard): number {
  // 转化技用掉的实体牌才是真成本
  if (v.cards.length === 0) return 5;
  return v.cards.reduce((s, c) => s + cardValue(c), 0);
}

export class BasicAI implements Agent {
  readonly id: string;
  private pendingCard: VirtualCard | null = null;
  private pendingTargets: Player[] | null = null;

  constructor(id: string) { this.id = id; }

  // ————————————————— 身份推测 —————————————————

  /** > 0 友好,< 0 敌对,绝对值表示确信程度 */
  attitude(game: Game, self: Player, other: Player): number {
    if (other === self) return 100;
    const lord = game.players.find(p => p.role === 'lord')!;
    const myRole = self.role;

    if (other === lord) {
      if (myRole === 'lord' || myRole === 'loyalist') return 100;
      if (myRole === 'rebel') return -100;
      // 内奸:主公是最后才动的人,在那之前甚至要保他
      return game.alivePlayers.length > 2 ? 60 : -100;
    }
    if (other.dead) return 0;

    // 场上只剩两个人时,对方必然是敌人 —— 这是从人数和身份配置就能推出的公开信息。
    // (1v1 单挑局从第一回合起就适用,否则主公方会一直观望到被打为止。)
    if (game.alivePlayers.length === 2) return -100;

    // —— 公开信息推断 ——
    // 打过主公的人,大概率是反贼(或内奸)
    const suspects = game.alivePlayers.filter(p => p !== lord && game.hostility(p, lord) > 0);
    const isSuspect = suspects.includes(other);
    // 打过"已暴露的反贼"的人,大概率是主忠
    const helpedLord = suspects.reduce(
      (s, r) => s + (r === other ? 0 : game.hostility(other, r)), 0);
    const toLord = game.hostility(other, lord);
    const toMe = game.hostility(other, self);
    const fromMe = game.hostility(self, other);
    // 已阵亡角色的身份是公开的,同样计入
    const deadRebels = game.players.filter(p => p.dead && p.role === 'rebel');
    const killedRebel = deadRebels.reduce((s, r) => s + game.hostility(other, r), 0);

    let s: number;
    if (myRole === 'lord' || myRole === 'loyalist') {
      if (isSuspect) s = -70 - toLord * 12;
      else if (helpedLord + killedRebel > 0) s = 55 + (helpedLord + killedRebel) * 8;
      // 还没露头的人一律先当自己人对待 —— 主忠方最怕的就是打错人。
      // 实测:这一条把主忠胜率从 26% 拉到 33%。
      else s = 5;
      s -= toMe * 25;
    } else if (myRole === 'rebel') {
      if (isSuspect) s = 60 + toLord * 8;                    // 同伙
      else if (helpedLord + killedRebel > 0) s = -65;        // 保皇党
      else s = -10;
      s -= toMe * 30;
    } else {
      // 内奸:压制人多的一方,留主公到最后
      const rebelsAlive = suspects.length;
      const lordSide = Math.max(0, game.alivePlayers.length - rebelsAlive - 1);
      if (isSuspect) s = rebelsAlive >= lordSide ? -60 : 25;
      else s = rebelsAlive >= lordSide ? 15 : -45;
      s -= toMe * 25;
    }
    // 我打过他,他多半已经把我当敌人了
    s -= fromMe * 10;
    // 拖太久了就别继续观望 —— 否则双方都"看谁都像自己人",局面会僵住
    if (game.round > 12 && s > 0 && s < 50) s = -20;
    return Math.max(-100, Math.min(100, s));
  }

  private enemies(game: Game, self: Player): Player[] {
    return game.others(self).filter(p => this.attitude(game, self, p) < 0);
  }

  /** 目标威胁度:血少、手牌少的敌人优先打 */
  private threat(game: Game, self: Player, t: Player): number {
    const att = this.attitude(game, self, t);
    if (att >= 0) return -1000;
    let s = -att;
    s += (5 - t.hp) * 12;
    s += (5 - Math.min(5, t.handCount)) * 4;
    if (t.hp === 1) s += 40;
    if (t.role === 'lord') s += 25;
    return s;
  }

  private bestTarget(game: Game, self: Player, cands: Player[]): Player | null {
    let best: Player | null = null, bs = -Infinity;
    for (const t of cands) {
      const s = this.threat(game, self, t);
      if (s > bs) { bs = s; best = t; }
    }
    return best;
  }

  // ————————————————— 出牌阶段 —————————————————

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]): Promise<number> {
    let bestIdx = actions.length - 1, bestScore = 1, bestTargets: Player[] | null = null;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (a.kind === 'end') continue;
      const { score, targets } = this.scoreAction(game, self, a);
      if (score > bestScore) { bestScore = score; bestIdx = i; bestTargets = targets; }
    }
    const chosen = actions[bestIdx];
    this.pendingCard = chosen.kind === 'card' ? chosen.card : null;
    this.pendingTargets = bestTargets;
    return bestIdx;
  }

  private scoreAction(
    game: Game, self: Player, a: PlayAction,
  ): { score: number; targets: Player[] | null } {
    if (a.kind === 'skill') return { score: this.scoreSkill(game, self, a.skill.name), targets: null };
    if (a.kind !== 'card') return { score: 0, targets: null };

    const vc = a.card;
    const spec = cardSpecs.get(vc.name)!;
    const cost = vc.skill ? vcValue(vc) : 0; // 转化技消耗了别的牌,要打折
    const others = game.others(self);

    const withTarget = (base: number, cands: Player[]) => {
      const t = this.bestTarget(game, self, cands);
      if (!t) return { score: -1, targets: null };
      return { score: base + this.threat(game, self, t) * 0.35 - cost * 0.35, targets: [t] };
    };

    switch (vc.name) {
      case '桃': {
        const miss = self.maxHp - self.hp;
        if (miss <= 0) return { score: -1, targets: null };
        if (self.hp <= 1) return { score: 300, targets: [self] };
        if (miss >= 2) return { score: 58, targets: [self] };
        return { score: 0, targets: [self] };
      }
      case '无中生有':
        return { score: 95, targets: [self] };
      case '五谷丰登': {
        // 人越多越亏,但自己先选
        const bad = others.filter(p => this.attitude(game, self, p) < 0).length;
        return { score: 60 - bad * 6, targets: null };
      }
      case '桃园结义': {
        let s = self.isWounded ? 35 : 0;
        for (const p of others) {
          if (!p.isWounded) continue;
          s += this.attitude(game, self, p) > 0 ? 14 : -16;
        }
        return { score: s, targets: null };
      }
      case '南蛮入侵':
      case '万箭齐发': {
        let s = 8;
        for (const p of others) s += this.attitude(game, self, p) < 0 ? 17 : -20;
        return { score: s - cost * 0.3, targets: null };
      }
      case '杀': {
        const cands = game.alivePlayers.filter(t => game.canTarget(self, t, vc, []));
        return withTarget(62, cands);
      }
      case '决斗': {
        const cands = game.alivePlayers.filter(t => game.canTarget(self, t, vc, []));
        const mySlash = game.enumerateResponses(self, { names: ['杀'] }, { mode: 'respond', purpose: 'slash' }).length;
        return withTarget(38 + Math.min(mySlash, 3) * 8, cands);
      }
      case '顺手牵羊':
        return withTarget(58, game.alivePlayers.filter(t => game.canTarget(self, t, vc, [])));
      case '过河拆桥':
        return withTarget(52, game.alivePlayers.filter(t => game.canTarget(self, t, vc, [])));
      case '乐不思蜀':
        return withTarget(50, game.alivePlayers.filter(t => game.canTarget(self, t, vc, [])));
      case '借刀杀人':
        return withTarget(30, game.alivePlayers.filter(t => game.canTarget(self, t, vc, [])));
      case '闪电':
        return { score: -1, targets: null }; // 基础 AI 不玩闪电
      case '闪':
      case '无懈可击':
        return { score: -1, targets: null };
      default:
        break;
    }

    // 装备牌
    if (spec.type === 'equip') {
      const slot = spec.slot!;
      const cur = self.equips[slot];
      if (!cur) return { score: 70, targets: [self] };
      const better = cardValue({ name: vc.name } as Card) > cardValue(cur);
      return { score: better ? 40 : -1, targets: [self] };
    }
    return { score: 5, targets: null };
  }

  private scoreSkill(game: Game, self: Player, name: string): number {
    const wounded = game.alivePlayers.filter(p => p.isWounded && this.attitude(game, self, p) > 0);
    switch (name) {
      case '制衡': {
        const junk = [...self.hand].filter(c => cardValue(c) < 42).length;
        return junk >= 2 ? 55 + junk * 4 : -1;
      }
      case '苦肉':
        return self.hp >= 3 ? 52 : -1;
      case '仁德': {
        const excess = self.handCount - Math.max(self.hp, 2);
        const friends = game.others(self).filter(p => this.attitude(game, self, p) > 20);
        return excess > 0 && friends.length ? 30 + excess * 5 : -1;
      }
      case '青囊':
        return wounded.length ? 66 : -1;
      case '结姻':
        return self.handCount >= 3 && wounded.some(p => p !== self && p.gender === 'male') ? 55 : -1;
      case '反间':
        return this.enemies(game, self).length ? 48 : -1;
      case '离间': {
        const males = game.others(self).filter(p => p.gender === 'male');
        return males.length >= 2 ? 56 : -1;
      }
      default:
        return 20;
    }
  }

  // ————————————————— 目标选择 —————————————————

  async choosePlayers(
    game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string,
  ): Promise<Player[]> {
    // 出牌阶段已经算好目标了
    if (this.pendingTargets && this.pendingTargets.length >= min) {
      const t = this.pendingTargets.filter(p => cands.includes(p)).slice(0, max);
      this.pendingTargets = null;
      if (t.length >= min) return t;
    }
    const friendly = /遗计|仁德|青囊|结姻|交给|回复/.test(prompt);
    const sorted = [...cands].sort((a, b) => friendly
      ? this.attitude(game, self, b) - this.attitude(game, self, a)
      : this.threat(game, self, b) - this.threat(game, self, a));
    return sorted.slice(0, Math.max(min, Math.min(max, min)));
  }

  // ————————————————— 响应 —————————————————

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean,
    ctx: ResponseCtx = {},
  ): Promise<number> {
    const cheapest = () => {
      let bi = 0, bv = Infinity;
      options.forEach((o, i) => { const v = vcValue(o.card); if (v < bv) { bv = v; bi = i; } });
      return bi;
    };

    // 替主公出牌(护驾 / 激将)
    if (/护驾|激将/.test(prompt)) {
      const lord = game.players.find(p => p.role === 'lord')!;
      return this.attitude(game, self, lord) > 30 ? cheapest() : -1;
    }

    switch (ctx.purpose) {
      case 'dodge':
        return cheapest();
      case 'slash': {
        // 决斗/南蛮:血少必须接,血多且手牌吃紧可以硬吃
        if (self.hp <= 2) return cheapest();
        const best = options[cheapest()];
        if (vcValue(best.card) > 90) return -1; // 别拿桃换命
        return cheapest();
      }
      case 'peach': {
        const dying = ctx.dying;
        if (!dying) return -1;
        if (dying === self) return cheapest();
        return this.attitude(game, self, dying) >= 40 ? cheapest() : -1;
      }
      case 'nullify': {
        const use = ctx.use;
        if (!use) return -1;
        const target = ctx.target ?? null;
        const name = use.card.name;
        let good: boolean;
        if (HARMFUL.has(name)) {
          good = target ? this.attitude(game, self, target) > 20 : false;
        } else if (HELPFUL.has(name)) {
          good = target ? this.attitude(game, self, target) < -20 : false;
        } else return -1;
        if (ctx.negated) good = !good; // 别人已经无懈过了,我再无懈是"恢复效果"
        if (!good) return -1;
        // 只为要紧的事花无懈
        const worth = target === self
          || (target && (target.hp <= 1 || name === '决斗' || name === '乐不思蜀' || name === '闪电'));
        return worth ? cheapest() : -1;
      }
      default:
        return forced ? cheapest() : -1;
    }
  }

  // ————————————————— 选牌 —————————————————

  async chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
  ): Promise<Card[]> {
    // 鬼才:挑一张能翻转判定结果的牌
    if (prompt.startsWith('鬼才')) {
      const ev = this.lastJudge;
      if (ev) {
        const want = this.desiredJudge(game, self, ev);
        const flip = cards.filter(c => ev.check(c) === want).sort((a, b) => cardValue(a) - cardValue(b));
        if (flip.length) return flip.slice(0, 1);
      }
      return [];
    }
    const sorted = [...cards].sort((a, b) => cardValue(a) - cardValue(b));
    // 仁德送牌:送最没用的
    const n = Math.max(min, Math.min(max, min));
    return sorted.slice(0, n);
  }

  // ————————————————— 选项 —————————————————

  private lastJudge: JudgeEvent | null = null;

  private desiredJudge(game: Game, self: Player, ev: JudgeEvent): boolean {
    const att = this.attitude(game, self, ev.player);
    switch (ev.reason) {
      case '闪电':
      case '乐不思蜀':
        return att < 0;     // 希望敌人中招
      default:
        return att > 0;     // 八卦阵/铁骑/刚烈/洛神/天妒:希望自己人成功
    }
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean,
    ctx: OptionCtx = {},
  ): Promise<number> {
    if (ctx.skill) return this.decideSkill(game, self, ctx);

    // 五谷丰登:拿最值钱的
    if (prompt.startsWith('五谷丰登')) {
      let bi = 0, bv = -1;
      options.forEach((label, i) => {
        const name = label.replace(/\[.*$/, '');
        const v = CARD_VALUE[name] ?? 30;
        if (v > bv) { bv = v; bi = i; }
      });
      return bi;
    }
    // 拆牌/顺牌:优先武器和防具,其次手牌
    if (/过河拆桥|顺手牵羊|反馈|麒麟弓/.test(prompt)) {
      const pri = (l: string) => {
        if (/装备区/.test(l)) return /八卦阵|仁王盾|诸葛连弩|青龙|贯石|方天|麒麟|丈八|青釭|雌雄/.test(l) ? 3 : 2;
        if (/手牌/.test(l)) return 1;
        return 0; // 判定区:一般不动
      };
      let bi = 0, bv = -1;
      options.forEach((l, i) => { const v = pri(l); if (v > bv) { bv = v; bi = i; } });
      return bi;
    }
    // 刚烈:血少就弃牌,血多就吃伤害
    if (prompt.startsWith('刚烈')) {
      return self.hp <= 2 || self.handCount >= 4 ? 0 : 1;
    }
    if (prompt.startsWith('洛神')) return 0; // 一直摸
    return 0;
  }

  private decideSkill(game: Game, self: Player, ctx: OptionCtx): number {
    const YES = 0, NO = 1;
    const ev: any = ctx.event;
    switch (ctx.skill) {
      case '鬼才': {
        this.lastJudge = ev as JudgeEvent;
        const want = this.desiredJudge(game, self, ev);
        if (ev.check(ev.card) === want) return NO;         // 结果已经如我所愿
        const canFlip = self.hand.some(c => ev.check(c) === want);
        return canFlip ? YES : NO;
      }
      case '裸衣':
        return self.hand.some(c => c.name === '杀') || self.hp >= 3 ? YES : NO;
      case '急救':
        return this.attitude(game, self, ev.player) >= 40 ? YES : NO;
      case '青龙偃月刀':
        return this.attitude(game, self, ev.to) < 0 ? YES : NO;
      case '贯石斧':
        return ev.to.hp <= 1 ? YES : NO;
      case '流离':
        return self.allCards.length >= 2 ? YES : NO;
      case '突袭':
        return YES;
      case '连营':
      case '枭姬':
      case '闭月':
      case '集智':
      case '天妒':
      case '洛神':
      case '奸雄':
      case '反馈':
      case '遗计':
      case '刚烈':
      case '铁骑':
      case '克己':
      case '八卦阵':
      case '雌雄双股剑':
      case '观星':
      case '护驾':
      case '激将':
      case '麒麟弓':
        return YES;
      default:
        return YES;
    }
  }

  /**
   * 走自己的随机流,而不是 game.rng。
   * 用 game.rng 的话,"AI 随手选了个花色"这一下会把牌堆的洗牌序列也拨走一格 ——
   * 换个 AI 就等于换了副牌,重放记录也会从这里开始对不上。
   */
  private rand: RNG | null = null;
  private rng(game: Game): RNG {
    return (this.rand ??= agentRng(game.seed, this.id));
  }

  async chooseSuit(game: Game, self: Player, prompt: string): Promise<Suit> {
    return this.rng(game).pick(SUITS);
  }

  async arrangeCards(
    game: Game, self: Player, cards: Card[], prompt: string,
  ): Promise<{ top: Card[]; bottom: Card[] }> {
    const sorted = [...cards].sort((a, b) => cardValue(b) - cardValue(a));
    // 自己马上就要摸牌,好牌放顶上,剩下的塞底
    const keep = Math.min(2, sorted.length);
    return { top: sorted.slice(0, keep), bottom: sorted.slice(keep) };
  }
}
