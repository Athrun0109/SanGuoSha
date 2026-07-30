import {
  Card, CardPattern, EquipSlot, Phase, PHASE_ORDER, PHASE_NAME, Role, ROLE_NAME,
  VirtualCard, cardLabel, realCard, vcLabel, viewAsCard, Suit, KINGDOM_NAME,
} from './types.js';
import { Player } from './player.js';
import {
  AskForCardEvent, CardRespondEvent, CardUseEvent, CardsMovedEvent, DamageEvent,
  DeathEvent, DrawNumberEvent, DyingEvent, HpEvent, JudgeEvent, MovedCard,
  PhaseEvent, TargetEvent, Timing, Zone, BaseEvent,
} from './events.js';
import { Skill, ViewAsContext, limitKey } from './skill.js';
import type { Agent, CardOption, PlayAction, ResponseCtx } from './agent.js';
import { getSpec, cardSpecs } from './registry.js';

export class GameOver extends Error {
  constructor(public winners: Player[], public reason: string) {
    super(reason);
  }
}

export interface GameOptions {
  seed?: number;
  /** 日志输出 */
  log?: (msg: string) => void;
  /** 是否输出详细日志 */
  verbose?: boolean;
}

/** 简单可重现的伪随机 */
export class RNG {
  private s: number;
  constructor(seed = 20260729) { this.s = seed >>> 0 || 1; }
  next(): number {
    this.s ^= this.s << 13; this.s >>>= 0;
    this.s ^= this.s >> 17;
    this.s ^= this.s << 5; this.s >>>= 0;
    return this.s / 0x100000000;
  }
  int(n: number) { return Math.floor(this.next() * n); }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

export class Game {
  players: Player[] = [];
  agents = new Map<Player, Agent>();
  deck: Card[] = [];
  discardPile: Card[] = [];
  /** 结算中的牌(已离开区域但尚未进弃牌堆) */
  processing: Card[] = [];

  current!: Player;
  phase: Phase = 'start';
  round = 0;
  turnCount = 0;
  finished = false;
  winners: Player[] = [];

  rng: RNG;
  /** 公开信息:谁对谁造成过多少伤害(AI 用来推测身份) */
  hostilityLog = new Map<string, number>();
  /**
   * 公开进入某人手牌的牌(五谷取走的、反间展示的、天妒拿走的判定牌…)。
   * 记牌器要把这些从"未知牌池"里扣掉。牌一旦移动就自动失效。
   */
  publicHandCards = new Map<number, Player>();
  logLines: string[] = [];
  /** 每一轮开始时 logLines 的长度,用于按"轮"截取滚动战报。索引即轮次 */
  roundStartLine: number[] = [];
  private logFn: (msg: string) => void;
  verbose: boolean;

  constructor(opts: GameOptions = {}) {
    this.rng = new RNG(opts.seed);
    this.logFn = opts.log ?? (() => {});
    this.verbose = opts.verbose ?? true;
  }

  log(msg: string) {
    this.logLines.push(msg);
    this.logFn(msg);
  }

  agentOf(p: Player): Agent {
    const a = this.agents.get(p);
    if (!a) throw new Error(`角色 ${p.name} 没有绑定 agent`);
    return a;
  }

  // ————————————————— 座次 / 距离 —————————————————

  get alivePlayers(): Player[] { return this.players.filter(p => p.alive); }

  /** 从 start 开始按座次顺时针遍历所有存活角色(含 start) */
  playersFrom(start: Player, includeSelf = true): Player[] {
    const alive = this.alivePlayers;
    let i = alive.indexOf(start);
    if (i < 0) {
      // start 已阵亡:找到座次上下一个存活角色
      i = 0;
      for (let k = 0; k < alive.length; k++) {
        if (alive[k].seat > start.seat) { i = k; break; }
      }
      includeSelf = true;
    }
    const out: Player[] = [];
    for (let k = 0; k < alive.length; k++) {
      const p = alive[(i + k) % alive.length];
      if (k === 0 && !includeSelf) continue;
      out.push(p);
    }
    return out;
  }

  others(p: Player): Player[] {
    return this.alivePlayers.filter(x => x !== p);
  }

  /** a 对 b 累计造成的伤害(公开信息) */
  hostility(a: Player, b: Player): number {
    return this.hostilityLog.get(`${a.seat}->${b.seat}`) ?? 0;
  }

  distance(a: Player, b: Player): number {
    if (a === b) return 0;
    const alive = this.alivePlayers;
    const ia = alive.indexOf(a), ib = alive.indexOf(b);
    if (ia < 0 || ib < 0) return Infinity;
    const n = alive.length;
    let d = Math.min((ib - ia + n) % n, (ia - ib + n) % n);
    d += this.sumQuery(a, 'distanceDelta', { from: a, to: b });      // 马术 / -1马
    d += this.sumQuery(b, 'distanceFromDelta', { from: a, to: b });  // +1马
    return Math.max(1, d);
  }

  attackRange(p: Player): number {
    return Math.max(0, 1 + this.sumQuery(p, 'attackRange', {}));
  }

  inAttackRange(from: Player, to: Player): boolean {
    return from !== to && this.distance(from, to) <= this.attackRange(from);
  }

  // ————————————————— 查询系统 —————————————————

  private statics(p: Player) {
    return p.allSkills.filter(s => s.kind === 'static' && this.skillEnabled(p, s));
  }

  sumQuery(owner: Player, name: string, ctx: any): number {
    let total = 0;
    for (const s of this.statics(owner)) {
      const fn = (s as any).queries[name];
      if (!fn) continue;
      const v = fn(this, owner, ctx);
      if (typeof v === 'number') total += v;
    }
    return total;
  }

  anyQuery(owner: Player, name: string, ctx: any): boolean {
    for (const s of this.statics(owner)) {
      const fn = (s as any).queries[name];
      if (!fn) continue;
      if (fn(this, owner, ctx) === true) return true;
    }
    return false;
  }

  /** 技能是否生效(主公技需身份为主公) */
  skillEnabled(p: Player, s: Skill): boolean {
    if (!p.alive) return false;
    if (s.lordSkill && p.role !== 'lord') return false;
    return true;
  }

  /** 技能是否还能发动(次数限制) */
  skillAvailable(p: Player, s: Skill): boolean {
    if (!this.skillEnabled(p, s)) return false;
    const k = limitKey(s);
    if (k && p.mark(k) > 0) return false;
    return true;
  }

  private consumeLimit(p: Player, s: Skill) {
    const k = limitKey(s);
    if (k) p.addMark(k);
  }

  // ————————————————— 时机触发 —————————————————

  async trigger(timing: Timing, event: BaseEvent): Promise<void> {
    event.timing = timing;
    if (!event._fired) event._fired = new Set();
    for (let guard = 0; guard < 200; guard++) {
      const cands: Array<{ p: Player; s: Skill }> = [];
      const order = this.current ? this.playersFrom(this.current) : this.alivePlayers;
      for (const p of order) {
        for (const s of p.allSkills) {
          if (s.kind !== 'triggered') continue;
          const key = `${p.seat}:${s.name}`;
          if (event._fired.has(key)) continue;
          if (!this.skillAvailable(p, s)) continue;
          const timings = Array.isArray(s.timing) ? s.timing : [s.timing];
          if (!timings.includes(timing)) continue;
          let ok = false;
          try { ok = s.filter({ game: this, self: p, event, timing }); } catch { ok = false; }
          if (ok) cands.push({ p, s });
        }
      }
      if (!cands.length) return;
      cands.sort((a, b) => (b.s.priority ?? 0) - (a.s.priority ?? 0));
      const { p, s } = cands[0];
      event._fired.add(`${p.seat}:${s.name}`);
      let go = !!s.compulsory;
      if (!go) {
        const idx = await this.agentOf(p).chooseOption(
          this, p, ['发动', '放弃'], `是否发动【${s.name}】?`, false,
          { skill: s.name, event, timing },
        );
        go = idx === 0;
      }
      if (go) {
        this.consumeLimit(p, s);
        if (this.verbose) this.log(`  ${p.name} 发动【${s.name}】`);
        await (s as any).effect({ game: this, self: p, event, timing });
      }
    }
  }

  // ————————————————— 牌堆 / 区域移动 —————————————————

  private reshuffle() {
    if (!this.discardPile.length) throw new GameOver([], '牌堆和弃牌堆都空了 —— 平局');
    this.deck.push(...this.rng.shuffle(this.discardPile));
    this.discardPile = [];
    this.log('※ 牌堆用尽,洗牌重来');
  }

  drawFromDeck(n: number): Card[] {
    const out: Card[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.deck.length) this.reshuffle();
      out.push(this.deck.shift()!);
    }
    return out;
  }

  /** 把牌放回牌堆顶(用于观星) */
  putOnDeckTop(cards: Card[]) { this.deck.unshift(...cards); }
  putOnDeckBottom(cards: Card[]) { this.deck.push(...cards); }

  /** 定位一张牌当前所在的区域 */
  locate(card: Card): { owner: Player | null; zone: Zone } | null {
    for (const p of this.players) {
      if (p.hand.includes(card)) return { owner: p, zone: 'hand' };
      if (p.judgeZone.includes(card)) return { owner: p, zone: 'judge' };
      for (const slot of Object.keys(p.equips) as EquipSlot[]) {
        if (p.equips[slot] === card) return { owner: p, zone: 'equip' };
      }
    }
    if (this.processing.includes(card)) return { owner: null, zone: 'processing' };
    if (this.discardPile.includes(card)) return { owner: null, zone: 'discard' };
    if (this.deck.includes(card)) return { owner: null, zone: 'deck' };
    return null;
  }

  private removeFrom(card: Card): { owner: Player | null; zone: Zone } | null {
    const loc = this.locate(card);
    if (!loc) return null;
    const { owner, zone } = loc;
    if (zone === 'hand') owner!.hand.splice(owner!.hand.indexOf(card), 1);
    else if (zone === 'judge') owner!.judgeZone.splice(owner!.judgeZone.indexOf(card), 1);
    else if (zone === 'equip') {
      for (const slot of Object.keys(owner!.equips) as EquipSlot[]) {
        if (owner!.equips[slot] === card) { this.unequip(owner!, slot); break; }
      }
    } else if (zone === 'processing') this.processing.splice(this.processing.indexOf(card), 1);
    else if (zone === 'discard') this.discardPile.splice(this.discardPile.indexOf(card), 1);
    else if (zone === 'deck') this.deck.splice(this.deck.indexOf(card), 1);
    return loc;
  }

  /** 统一的移牌入口;会触发 CardsMoved */
  async moveCards(
    cards: Card[], to: Player | null, toZone: Zone, reason: string,
  ): Promise<void> {
    if (!cards.length) return;
    const moves: MovedCard[] = [];
    for (const c of cards) {
      this.publicHandCards.delete(c.id); // 牌一动,之前的"已公开"就不再成立
      const loc = this.removeFrom(c);
      moves.push({
        card: c,
        from: loc?.owner ?? null,
        fromZone: loc?.zone ?? 'processing',
        to, toZone,
      });
      if (toZone === 'hand') to!.hand.push(c);
      else if (toZone === 'judge') to!.judgeZone.push(c);
      else if (toZone === 'processing') this.processing.push(c);
      else if (toZone === 'discard') this.discardPile.push(c);
      else if (toZone === 'deck') this.deck.unshift(c);
    }
    const ev: CardsMovedEvent = { moves, reason };
    await this.trigger('CardsMoved', ev);
  }

  /** 声明某张牌是当着所有人的面进入该角色手牌的(供记牌器使用),需在移动完成后调用 */
  revealToAll(card: Card, owner: Player) {
    if (owner.hand.includes(card)) this.publicHandCards.set(card.id, owner);
  }

  async discardCards(cards: Card[], reason: string) {
    if (!cards.length) return;
    await this.moveCards(cards, null, 'discard', reason);
  }

  async gainCards(p: Player, cards: Card[], reason: string) {
    if (!cards.length) return;
    await this.moveCards(cards, p, 'hand', reason);
  }

  async drawCards(p: Player, n: number, reason = '摸牌'): Promise<Card[]> {
    if (n <= 0 || !p.alive) return [];
    const cards = this.drawFromDeck(n);
    p.hand.push(...cards);
    if (this.verbose) this.log(`  ${p.name} ${reason} ${n} 张 (手牌 ${p.handCount})`);
    const ev: CardsMovedEvent = {
      moves: cards.map(c => ({ card: c, from: null, fromZone: 'deck' as Zone, to: p, toZone: 'hand' as Zone })),
      reason,
    };
    await this.trigger('CardsMoved', ev);
    return cards;
  }

  // ————————————————— 装备 —————————————————

  async equipCard(p: Player, card: Card) {
    const spec = getSpec(card.name);
    const slot = spec.slot!;
    const old = p.equips[slot];
    // 牌必须先离开原区域(通常是手牌),否则它会同时留在手牌和装备栏里。
    // 走 moveCards 是为了触发 CardsMoved —— 用掉最后一张手牌时【连营】要能响应。
    if (this.locate(card)?.zone !== 'processing') {
      await this.moveCards([card], null, 'processing', '装备');
    }
    if (old) await this.moveCards([old], null, 'discard', '更换装备');
    this.processing = this.processing.filter(c => c !== card);
    p.equips[slot] = card;
    if (spec.equipSkills?.length) p.equipSkills.set(slot, spec.equipSkills);
    this.log(`  ${p.name} 装备 ${cardLabel(card)}`);
    const ev: CardsMovedEvent = {
      moves: [{ card, from: null, fromZone: 'processing', to: p, toZone: 'equip' }],
      reason: '装备',
    };
    await this.trigger('CardsMoved', ev);
  }

  /** 只做数据层卸下,不移动牌(移动由 removeFrom 的调用方负责) */
  private unequip(p: Player, slot: EquipSlot) {
    delete p.equips[slot];
    p.equipSkills.delete(slot);
  }

  // ————————————————— 求牌 / 响应 —————————————————

  matchPattern(v: VirtualCard, pat: CardPattern): boolean {
    if (pat.names && !pat.names.includes(v.name)) return false;
    if (pat.types) {
      const spec = cardSpecs.get(v.name);
      if (!spec || !pat.types.includes(spec.type)) return false;
    }
    if (pat.suits && !pat.suits.includes(v.suit)) return false;
    if (pat.colors) {
      const c = v.suit === '♥' || v.suit === '♦' ? 'red' : v.suit === 'none' ? 'none' : 'black';
      if (!pat.colors.includes(c as any)) return false;
    }
    if (pat.extra && !pat.extra(v)) return false;
    return true;
  }

  /** 列出该角色所有能满足 pattern 的出牌方式(含转化技) */
  enumerateResponses(p: Player, pat: CardPattern, ctx: ViewAsContext): CardOption[] {
    const out: CardOption[] = [];
    const seen = new Set<string>();
    const push = (vc: VirtualCard) => {
      const key = `${vc.name}|${vc.skill ?? ''}|${vc.cards.map(c => c.id).sort().join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ card: vc, label: vcLabel(vc) });
    };
    for (const c of p.hand) {
      const vc = realCard(c);
      if (this.matchPattern(vc, pat)) push(vc);
    }
    for (const s of p.allSkills) {
      if (s.kind !== 'viewAs') continue;
      if (!this.skillAvailable(p, s)) continue;
      if (!s.produces.some(n => !pat.names || pat.names.includes(n))) continue;
      if (!s.available(this, p, ctx)) continue;
      const pool = p.hand.filter(c => s.cardFilter(this, p, c, [], ctx));
      if (s.cardCount === 0) {
        const vc = s.viewAs(this, p, [], ctx);
        if (vc && this.matchPattern(vc, pat)) push(vc);
      } else if (s.cardCount === 1) {
        for (const c of pool) {
          const vc = s.viewAs(this, p, [c], ctx);
          if (vc && this.matchPattern(vc, pat)) push(vc);
        }
      } else if (s.cardCount === 2) {
        for (let i = 0; i < pool.length; i++) {
          for (let j = i + 1; j < pool.length; j++) {
            if (!s.cardFilter(this, p, pool[j], [pool[i]], ctx)) continue;
            const vc = s.viewAs(this, p, [pool[i], pool[j]], ctx);
            if (vc && this.matchPattern(vc, pat)) push(vc);
          }
        }
      }
    }
    return out;
  }

  /**
   * 要求角色【打出】一张牌(闪、杀…)。牌会离开手牌进入结算区。
   * 返回 null 表示没有打出。
   */
  async askForCard(
    p: Player, pat: CardPattern, purpose: string, prompt: string, forced = false,
    ctx: ResponseCtx = {},
  ): Promise<VirtualCard | null> {
    if (!p.alive) return null;
    const ask: AskForCardEvent = { player: p, purpose, prompt };
    await this.trigger('AskingForCard', ask);
    if (ask.result) {
      await this.trigger('CardResponded', { card: ask.result, player: p, purpose } as CardRespondEvent);
      return ask.result;
    }
    const opts = this.enumerateResponses(p, pat, { mode: 'respond', pattern: pat, purpose });
    if (!opts.length) return null;
    const idx = await this.agentOf(p).chooseResponse(this, p, opts, prompt, forced, { purpose, ...ctx });
    if (idx < 0 || idx >= opts.length) return null;
    const vc = opts[idx].card;
    await this.moveCards(vc.cards, null, 'processing', `打出${vc.name}`);
    this.log(`  ${p.name} 打出 ${vcLabel(vc)}`);
    if (vc.name === '杀' && this.phase === 'play' && p === this.current) p.addMark('turn:playedSlash');
    await this.trigger('CardResponded', { card: vc, player: p, purpose } as CardRespondEvent);
    await this.discardCards(vc.cards.filter(c => this.processing.includes(c)), '响应完毕');
    return vc;
  }

  /** 要求角色【使用】一张牌(桃、无懈可击…);只负责选,实际消耗由 useCard 完成 */
  async askForUse(
    p: Player, pat: CardPattern, purpose: string, prompt: string, ctx: ResponseCtx = {},
  ): Promise<VirtualCard | null> {
    if (!p.alive) return null;
    const opts = this.enumerateResponses(p, pat, { mode: 'respond', pattern: pat, purpose });
    if (!opts.length) return null;
    const idx = await this.agentOf(p).chooseResponse(this, p, opts, prompt, false, { purpose, ...ctx });
    if (idx < 0 || idx >= opts.length) return null;
    return opts[idx].card;
  }

  /** 要求弃牌 */
  async askForDiscard(
    p: Player, n: number, prompt: string, opts: { includeEquip?: boolean; min?: number } = {},
  ): Promise<Card[]> {
    const pool = opts.includeEquip ? [...p.hand, ...p.equipCards] : [...p.hand];
    const min = opts.min ?? n;
    if (pool.length < min) return [];
    const chosen = await this.agentOf(p).chooseCards(this, p, pool, min, n, prompt);
    if (chosen.length < min) return [];
    await this.discardCards(chosen, '弃牌');
    this.log(`  ${p.name} 弃置 ${chosen.map(cardLabel).join('、')}`);
    return chosen;
  }

  // ————————————————— 使用牌 —————————————————

  makeUse(card: VirtualCard, from: Player, targets: Player[]): CardUseEvent {
    return { card, from, targets, tags: {}, unavoidable: new Set() };
  }

  async useCard(use: CardUseEvent): Promise<void> {
    const spec = getSpec(use.card.name);
    if (!use.tags) use.tags = {};
    if (!use.unavoidable) use.unavoidable = new Set();

    await this.trigger('CardUsing', use);
    if (use.cancel) return;

    const tgtText = use.targets.length ? ` → ${use.targets.map(t => t.name).join('、')}` : '';
    this.log(`${use.from.name} 使用 ${vcLabel(use.card)}${tgtText}`);
    // 供【克己】等技能判断"本回合出牌阶段是否使用/打出过杀"
    if (use.card.name === '杀' && this.phase === 'play' && use.from === this.current) {
      use.from.addMark('turn:playedSlash');
    }

    if (spec.type === 'equip') {
      await this.trigger('CardUsed', use);
      await this.equipCard(use.from, use.card.cards[0]);
      return;
    }

    const beforeProcessing = new Set(this.processing);
    await this.moveCards(use.card.cards, null, 'processing', `使用${use.card.name}`);
    await this.trigger('CardUsed', use);

    // 目标确认(流离可改目标)
    const confirmed: Player[] = [];
    for (const t of [...use.targets]) {
      const tev: TargetEvent = { use, from: use.from, to: t };
      await this.trigger('TargetConfirming', tev);
      if (tev.cancel || !tev.to.alive) continue;
      confirmed.push(tev.to);
      const tev2: TargetEvent = { use, from: use.from, to: tev.to };
      await this.trigger('TargetConfirmed', tev2);
    }
    use.targets = confirmed;

    for (const t of use.targets) {
      if (!t.alive) continue;
      // 无懈可击窗口
      if (spec.type === 'trick' && spec.nullifiable !== false) {
        if (await this.askForNullification(use, t)) {
          this.log(`  ${vcLabel(use.card)} 对 ${t.name} 的效果被【无懈可击】抵消`);
          continue;
        }
      }
      // 目标免疫(仁王盾等)
      if (this.anyQuery(t, 'invalidToTarget', { use, to: t })) {
        this.log(`  ${vcLabel(use.card)} 对 ${t.name} 无效`);
        continue;
      }
      const cev: TargetEvent = { use, from: use.from, to: t };
      await this.trigger('CardEffecting', cev);
      if (cev.cancel) continue;
      await spec.onEffect?.({ game: this, use, from: use.from, to: t });
      await this.trigger('CardEffected', cev);
    }

    // 无目标的牌(无懈可击等)
    if (!use.targets.length && !spec.autoTargets && this.resolveNum(spec.targetMin, use.from, use.card) === 0) {
      await spec.onEffect?.({ game: this, use, from: use.from, to: use.from });
    }

    // 本次使用期间进入结算区、且仍未归属的牌统一进弃牌堆
    const leftover = this.processing.filter(c => !beforeProcessing.has(c));
    await this.discardCards(leftover, '结算完毕');
  }

  /** 无懈可击响应链;返回 true 表示效果最终被抵消 */
  async askForNullification(use: CardUseEvent, target: Player | null): Promise<boolean> {
    let negated = false;
    const desc = `${vcLabel(use.card)}${target ? ` 对 ${target.name}` : ''}`;
    for (let guard = 0; guard < 30; guard++) {
      let acted = false;
      for (const p of this.playersFrom(this.current)) {
        const pat: CardPattern = { names: ['无懈可击'] };
        const opts = this.enumerateResponses(p, pat, { mode: 'respond', pattern: pat, purpose: 'nullify' });
        if (!opts.length) continue;
        const prompt = negated
          ? `${desc} 已被无懈,是否再使用【无懈可击】使其恢复效果?`
          : `是否对 ${desc} 使用【无懈可击】?`;
        const idx = await this.agentOf(p).chooseResponse(
          this, p, opts, prompt, false, { purpose: 'nullify', use, target, negated },
        );
        if (idx < 0) continue;
        const vc = opts[idx].card;
        await this.useCard(this.makeUse(vc, p, []));
        negated = !negated;
        acted = true;
        break;
      }
      if (!acted) break;
    }
    return negated;
  }

  // ————————————————— 体力 / 伤害 —————————————————

  async damage(ev: DamageEvent): Promise<void> {
    if (!ev.to.alive || ev.amount <= 0) return;
    await this.trigger('DamageInflicting', ev);
    if (ev.cancel || ev.amount <= 0) return;
    ev.to.hp -= ev.amount;
    if (ev.from && ev.from !== ev.to) {
      const k = `${ev.from.seat}->${ev.to.seat}`;
      this.hostilityLog.set(k, (this.hostilityLog.get(k) ?? 0) + ev.amount);
    }
    this.log(`  ${ev.from ? ev.from.name + ' 对 ' : ''}${ev.to.name} 造成 ${ev.amount} 点伤害 (${ev.to.name} ${ev.to.hp}/${ev.to.maxHp})`);
    await this.trigger('DamageDone', ev);
    await this.trigger('DamageDealt', ev);
    if (ev.to.hp <= 0) await this.enterDying(ev.to, ev.from ?? null);
  }

  async loseHp(p: Player, amount: number, reason = ''): Promise<void> {
    if (!p.alive || amount <= 0) return;
    p.hp -= amount;
    this.log(`  ${p.name} 失去 ${amount} 点体力${reason ? `(${reason})` : ''} (${p.hp}/${p.maxHp})`);
    await this.trigger('HpLost', { player: p, amount, reason } as HpEvent);
    if (p.hp <= 0) await this.enterDying(p, null);
  }

  async recover(p: Player, amount: number, source: Player | null = null, reason = ''): Promise<void> {
    if (!p.alive || amount <= 0) return;
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    if (p.hp === before) return;
    this.log(`  ${p.name} 回复 ${p.hp - before} 点体力 (${p.hp}/${p.maxHp})`);
    await this.trigger('HpRecovered', { player: p, amount: p.hp - before, source, reason } as HpEvent);
  }

  async enterDying(p: Player, source: Player | null): Promise<void> {
    if (!p.alive || p.hp > 0) return;
    this.log(`※ ${p.name} 濒死!`);
    const ev: DyingEvent = { player: p, source };
    await this.trigger('Dying', ev);
    if (p.hp > 0) { this.log(`  ${p.name} 被救回`); return; }

    for (const rescuer of this.playersFrom(this.current)) {
      while (p.hp <= 0 && rescuer.alive) {
        const vc = await this.askForUse(
          rescuer, { names: ['桃'] }, 'peach',
          `${p.name} 濒死(${p.hp}/${p.maxHp}),是否使用【桃】?`,
          { dying: p },
        );
        if (!vc) break;
        await this.useCard(this.makeUse(vc, rescuer, [p]));
      }
      if (p.hp > 0) { this.log(`  ${p.name} 被救回`); return; }
    }
    await this.kill(p, source);
  }

  async kill(p: Player, killer: Player | null): Promise<void> {
    if (!p.alive) return;
    p.alive = false;
    p.revealed = true;
    this.log(`☠ ${p.name}(${p.general.name} / ${ROLE_NAME[p.role]}) 阵亡` + (killer ? `,由 ${killer.name} 击杀` : ''));
    const ev: DeathEvent = { player: p, killer };
    await this.trigger('Died', ev);

    const cards = [...p.hand, ...p.equipCards, ...p.judgeZone];
    await this.discardCards(cards, '阵亡弃牌');
    p.dead = true;

    // 奖惩
    if (killer && killer.alive) {
      if (p.role === 'rebel') {
        this.log(`  ${killer.name} 击杀反贼,摸三张牌`);
        await this.drawCards(killer, 3, '击杀奖励');
      } else if (p.role === 'loyalist' && killer.role === 'lord') {
        this.log(`  主公误杀忠臣,弃置所有牌`);
        await this.discardCards([...killer.hand, ...killer.equipCards], '误杀惩罚');
      }
    }
    this.checkGameOver();
  }

  checkGameOver() {
    const alive = this.alivePlayers;
    const lord = this.players.find(p => p.role === 'lord')!;
    if (!lord.alive) {
      // 内奸单独存活 -> 内奸胜;否则反贼胜
      if (alive.length === 1 && alive[0].role === 'renegade') {
        throw new GameOver([alive[0]], '内奸获胜');
      }
      throw new GameOver(this.players.filter(p => p.role === 'rebel'), '反贼获胜');
    }
    const hasEnemy = alive.some(p => p.role === 'rebel' || p.role === 'renegade');
    if (!hasEnemy) {
      throw new GameOver(this.players.filter(p => p.role === 'lord' || p.role === 'loyalist'), '主忠获胜');
    }
  }

  // ————————————————— 判定 —————————————————

  async judge(p: Player, reason: string, check: (c: Card) => boolean): Promise<JudgeEvent> {
    const card = this.drawFromDeck(1)[0];
    this.processing.push(card);
    const ev: JudgeEvent = { player: p, reason, card, check };
    this.log(`  ${p.name} 判定[${reason}]:${cardLabel(card)}`);
    await this.trigger('JudgeResulting', ev);
    ev.success = check(ev.card);
    this.log(`  判定结果:${cardLabel(ev.card)} → ${ev.success ? '生效' : '不生效'}`);
    await this.trigger('JudgeResulted', ev);
    if (!ev.taken && this.processing.includes(ev.card)) {
      await this.discardCards([ev.card], '判定牌');
    }
    return ev;
  }

  // ————————————————— 回合流程 —————————————————

  async setupAndRun(): Promise<{ winners: Player[]; reason: string }> {
    try {
      await this.trigger('GameStart', {});
      let idx = 0;
      const lord = this.players.find(p => p.role === 'lord')!;
      idx = this.players.indexOf(lord);
      let guard = 0;
      while (!this.finished && guard++ < 500) {
        const p = this.players[idx % this.players.length];
        if (p === lord) {
          this.round++;
          this.roundStartLine[this.round] = this.logLines.length;
          for (const q of this.players) q.clearMarks('round:');
          this.log(`\n========== 第 ${this.round} 轮 ==========`);
        }
        if (p.alive) await this.runTurn(p);
        idx++;
      }
      throw new GameOver([], '回合数超限 —— 平局');
    } catch (e) {
      if (e instanceof GameOver) {
        this.finished = true;
        this.winners = e.winners;
        this.log(`\n★ 游戏结束:${e.reason}`);
        this.log(`  胜者:${e.winners.map(w => `${w.name}(${ROLE_NAME[w.role]})`).join('、') || '无'}`);
        return { winners: e.winners, reason: e.reason };
      }
      throw e;
    }
  }

  async runTurn(p: Player) {
    this.current = p;
    this.turnCount++;
    this.log(`\n--- 回合 ${this.turnCount}:${p.name}(${p.general.name}) ${p.hp}/${p.maxHp} 手牌${p.handCount} ---`);
    await this.trigger('TurnStart', { player: p, phase: 'start' } as PhaseEvent);
    for (const ph of PHASE_ORDER) {
      if (!p.alive) break;
      await this.runPhase(p, ph);
      p.clearMarks('phase:');
    }
    if (p.alive) await this.trigger('TurnEnd', { player: p, phase: 'end' } as PhaseEvent);
    p.clearMarks('turn:');
    p.clearMarks('phase:');
  }

  async runPhase(p: Player, phase: Phase) {
    this.phase = phase;
    const ev: PhaseEvent = { player: p, phase };
    // 乐不思蜀等效果直接打标记跳过阶段
    if (p.mark(`turn:skip:${phase}`) > 0) ev.skipped = true;
    await this.trigger('PhaseStart', ev);
    if (!ev.skipped && p.alive) {
      switch (phase) {
        case 'judge': await this.judgePhase(p); break;
        case 'draw': await this.drawPhase(p); break;
        case 'play': await this.playPhase(p); break;
        case 'discard': await this.discardPhase(p); break;
        default: break;
      }
    } else if (ev.skipped) {
      this.log(`  ${p.name} 跳过${PHASE_NAME[phase]}`);
    }
    if (p.alive) await this.trigger('PhaseEnd', { player: p, phase } as PhaseEvent);
  }

  /** 判定区里一张牌的实际牌名(可能被转化技改写) */
  judgeName(p: Player, card: Card): string {
    return p.judgeAs[card.id] ?? card.name;
  }

  /** 把一张牌作为延时锦囊放入判定区 */
  async placeDelayed(target: Player, card: Card, asName: string) {
    await this.moveCards([card], target, 'judge', asName);
    target.judgeAs[card.id] = asName;
    this.log(`  ${cardLabel(card)} 作为【${asName}】置于 ${target.name} 的判定区`);
  }

  private async judgePhase(p: Player) {
    // 判定区从上到下(后放的先判定)
    while (p.judgeZone.length && p.alive) {
      const card = p.judgeZone[p.judgeZone.length - 1];
      const name = this.judgeName(p, card);
      const spec = getSpec(name);
      const vc: VirtualCard = { name, suit: card.suit, rank: card.rank, cards: [card] };
      const use = this.makeUse(vc, p, [p]);
      // 延时锦囊也可以被无懈
      if (await this.askForNullification(use, p)) {
        this.log(`  ${cardLabel(card)} 被【无懈可击】抵消`);
        // 抵消之后这张牌的去向由牌本身决定:乐不思蜀弃掉,闪电要继续传给下家
        if (spec.onNullified) await spec.onNullified(this, p, card);
        else await this.discardCards([card], '延时锦囊被无懈');
        continue;
      }
      await this.moveCards([card], null, 'processing', '延时锦囊结算');
      await spec.delayed!(this, p, card);
      if (this.processing.includes(card)) await this.discardCards([card], '延时锦囊结算完毕');
    }
  }

  private async drawPhase(p: Player) {
    const ev: DrawNumberEvent = { player: p, num: 2 };
    await this.trigger('DrawNumber', ev);
    if (ev.cancel) return;
    await this.drawCards(p, ev.num, '摸牌');
  }

  /** 出牌阶段可以使用的牌 */
  enumerateUsable(p: Player): CardOption[] {
    const ctx: ViewAsContext = { mode: 'play' };
    const out: CardOption[] = [];
    const seen = new Set<string>();
    const consider = (vc: VirtualCard) => {
      if (!cardSpecs.has(vc.name)) return;
      const key = `${vc.name}|${vc.skill ?? ''}|${vc.cards.map(c => c.id).sort().join(',')}`;
      if (seen.has(key)) return;
      if (!this.canUseNow(p, vc)) return;
      seen.add(key);
      out.push({ card: vc, label: vcLabel(vc) });
    };
    for (const c of p.hand) consider(realCard(c));
    for (const s of p.allSkills) {
      if (s.kind !== 'viewAs') continue;
      if (!this.skillAvailable(p, s)) continue;
      if (!s.available(this, p, ctx)) continue;
      const pool = p.hand.filter(c => s.cardFilter(this, p, c, [], ctx));
      if (s.cardCount === 0) {
        const vc = s.viewAs(this, p, [], ctx); if (vc) consider(vc);
      } else if (s.cardCount === 1) {
        for (const c of pool) { const vc = s.viewAs(this, p, [c], ctx); if (vc) consider(vc); }
      } else if (s.cardCount === 2) {
        for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
          if (!s.cardFilter(this, p, pool[j], [pool[i]], ctx)) continue;
          const vc = s.viewAs(this, p, [pool[i], pool[j]], ctx); if (vc) consider(vc);
        }
      }
    }
    return out;
  }

  slashLimit(p: Player): number {
    if (this.anyQuery(p, 'noSlashLimit', {})) return Infinity;
    return 1 + this.sumQuery(p, 'slashLimit', {});
  }

  canUseNow(p: Player, vc: VirtualCard): boolean {
    const spec = cardSpecs.get(vc.name);
    if (!spec) return false;
    if (spec.canUse && !spec.canUse(this, p, vc)) return false;
    if (vc.name === '杀' && p.mark('turn:slashUsed') >= this.slashLimit(p)) return false;
    if (spec.autoTargets) return spec.autoTargets(this, p, vc).length > 0 || this.resolveNum(spec.targetMin, p, vc) === 0;
    const min = this.resolveNum(spec.targetMin, p, vc);
    if (min === 0) return true;
    return this.alivePlayers.some(t => this.canTarget(p, t, vc, []));
  }

  private resolveNum(v: number | ((g: Game, p: Player, c: VirtualCard) => number), p: Player, c: VirtualCard): number {
    return typeof v === 'function' ? v(this, p, c) : v;
  }

  canTarget(from: Player, to: Player, vc: VirtualCard, selected: Player[]): boolean {
    const spec = cardSpecs.get(vc.name);
    if (!spec || !to.alive) return false;
    if (spec.targetFilter && !spec.targetFilter(this, from, to, vc, selected)) return false;
    if (this.anyQuery(to, 'prohibitTarget', { card: vc, from, to })) return false;
    // 距离
    if (spec.range !== undefined && !this.anyQuery(from, 'ignoreDistance', { card: vc, from, to })) {
      if (spec.range === 'attack') {
        if (!this.inAttackRange(from, to)) return false;
      } else if (this.distance(from, to) > spec.range) return false;
    }
    return true;
  }

  async selectTargets(p: Player, vc: VirtualCard): Promise<Player[] | null> {
    const spec = getSpec(vc.name);
    if (spec.autoTargets) return spec.autoTargets(this, p, vc);
    const min = this.resolveNum(spec.targetMin, p, vc);
    const max = this.resolveNum(spec.targetMax, p, vc);
    if (max === 0) return [];
    const cands = this.alivePlayers.filter(t => this.canTarget(p, t, vc, []));
    if (cands.length < min) return null;
    const chosen = await this.agentOf(p).choosePlayers(
      this, p, cands, min, Math.min(max, cands.length), `为 ${vcLabel(vc)} 选择目标`,
    );
    if (chosen.length < min) return null;
    return chosen;
  }

  private async playPhase(p: Player) {
    for (let guard = 0; guard < 100 && p.alive; guard++) {
      const actions: PlayAction[] = [];
      for (const o of this.enumerateUsable(p)) actions.push({ kind: 'card', card: o.card, label: o.label });
      for (const s of p.allSkills) {
        if (s.kind !== 'active') continue;
        if (!this.skillAvailable(p, s)) continue;
        if (!s.canUse(this, p)) continue;
        actions.push({ kind: 'skill', skill: s, label: `【${s.name}】` });
      }
      actions.push({ kind: 'end', label: '结束出牌阶段' });
      const idx = await this.agentOf(p).choosePlayAction(this, p, actions);
      const act = actions[Math.max(0, Math.min(idx, actions.length - 1))];
      if (act.kind === 'end') return;
      if (act.kind === 'skill') {
        this.consumeLimit(p, act.skill);
        this.log(`${p.name} 发动【${act.skill.name}】`);
        await act.skill.onUse(this, p);
        continue;
      }
      const targets = await this.selectTargets(p, act.card);
      if (targets === null) continue;
      if (act.card.name === '杀') p.addMark('turn:slashUsed');
      await this.useCard(this.makeUse(act.card, p, targets));
    }
  }

  maxHand(p: Player): number {
    return Math.max(0, p.hp + this.sumQuery(p, 'maxHand', {}));
  }

  private async discardPhase(p: Player) {
    if (this.anyQuery(p, 'skipDiscard', {})) {
      this.log(`  ${p.name} 无需弃牌`);
      return;
    }
    const limit = this.maxHand(p);
    const excess = p.handCount - limit;
    if (excess <= 0) return;
    this.log(`  ${p.name} 手牌上限 ${limit},需弃置 ${excess} 张`);
    const chosen = await this.agentOf(p).chooseCards(
      this, p, [...p.hand], excess, excess, `弃牌阶段:请弃置 ${excess} 张手牌`,
    );
    await this.discardCards(chosen, '弃牌阶段');
  }

  // ————————————————— 展示 —————————————————

  describePlayer(p: Player, reveal = false): string {
    const role = p.revealed || reveal ? ROLE_NAME[p.role] : '??';
    const eq = p.equipCards.map(c => c.name).join(',') || '-';
    const jd = p.judgeZone.map(c => c.name).join(',');
    const hp = p.alive ? '♥'.repeat(Math.max(0, p.hp)) + '♡'.repeat(Math.max(0, p.maxHp - p.hp)) : '阵亡';
    return `[${p.seat}] ${p.name}(${p.general.name}·${KINGDOM_NAME[p.kingdom]}·${role}) ${hp} 手牌${p.handCount} 装备:${eq}${jd ? ` 判定:${jd}` : ''}`;
  }

  board(reveal = false): string {
    return this.players.map(p => this.describePlayer(p, reveal)).join('\n');
  }
}
