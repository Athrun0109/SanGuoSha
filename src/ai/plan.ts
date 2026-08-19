/**
 * 计划执行器 —— 让模型一次写好接下来几步,本地按计划走,不用每一步都问一遍。
 *
 * 实测动机:出牌阶段平均每回合 2 次决策(最多 3 次),每次 12~28 秒。一个典型回合
 * 「装青釭剑 → 拆桥 → 杀」要问三遍,而这三件事在模型看到局面的那一刻就已经想好了。
 * 按同一批日志重算,批量能把出牌阶段的调用次数从 20 次降到 12 次。
 *
 * ——————————————— 三条设计原则 ———————————————
 *
 * **一、模型抄标签,不拼标签。**
 * `act` 字段填的是引擎刚打印给它的原文(`杀[♣10]`、`装备区 进攻马[♦K]`)。
 * 自定义文本格式要模型按语法组装,花色写全角还是半角、点数写 10 还是 J,
 * 每一处都是静默失败点;抄原文没有这个问题 —— 要么完全对上,要么完全对不上。
 *
 * **二、对不上就作废,绝不猜。**
 * 匹配要求唯一命中,命中不到一个或多于一个都丢弃整份计划、回退到逐步询问。
 * 最坏情况是"白写了一份计划",而不是"做了一件模型没打算做的事"。
 *
 * **三、摸到新牌就作废。**
 * 新牌会改变计划的前提。而"什么动作会摸牌"**不是牌的静态属性**:
 *   黄月英【集智】—— 用任何锦囊都摸一张
 *   陆逊【连营】 —— 打光手牌摸一张
 *   孙尚香【枭姬】—— 换装备摸两张
 *   曹操【奸雄】/夏侯惇【反馈】—— 受伤害后摸
 * 所以不去分类"安全的牌",而是**每步之后看一眼手牌有没有变多**。这条能自动覆盖
 * 上面全部情况,以后 DIY 加新技能也不用维护清单。
 */

import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';

export interface PlanStep {
  /** 照抄选项里的动作文本,如 `杀[♣10]`、`青釭剑[♠6]` */
  act: string;
  /** 目标座位号;不需要目标时为 -1 */
  target: number;
  /** 拆/顺要拿的区域,照抄选项文本;不需要时为空串 */
  zone: string;
}

/** 计划被丢弃的原因,进日志用 */
export type DropReason =
  | '摸到新牌' | '换了回合' | '对不上选项' | '模型给的计划为空'
  | '牌被无懈可击抵消' | '中途掉血' | '出了计划外的状况';

export const PLAN_SCHEMA = {
  type: 'array',
  description:
    '接下来几步的计划(可以为空数组)。只写你现在就能确定的动作;' +
    '一旦你摸到新牌,计划会自动作废并重新问你,所以别把摸牌之后的打算写进来。',
  items: {
    type: 'object',
    properties: {
      act: { type: 'string', description: '照抄选项里的动作文本,例如 杀[♣10]' },
      target: { type: 'integer', description: '目标座位号;不需要指定目标时填 -1' },
      zone: {
        type: 'string',
        description:
          '过河拆桥/顺手牵羊要拿哪个区域:填 手牌 / 装备区 / 判定区。' +
          '对方装备区或判定区有多张时,再带上牌名(如「装备区 仁王盾」)。不需要时填空字符串',
      },
    },
    // strict 模式下所有字段都必须列进 required,所以用 -1 / '' 当"没有"
    required: ['act', 'target', 'zone'],
    additionalProperties: false,
  },
} as const;

/** 出牌阶段那道题的固定措辞(ChoiceAgent 里写死的) */
const PLAY_QUESTION = '出牌阶段,选一个动作';

export const isPlayAction = (q: string) => q === PLAY_QUESTION;
/** 选项全是角色标签 → 这是在问目标 */
const looksLikePlayers = (o: string[]) => o.length > 0 && o.every(x => /^P\d+/.test(x));
/** 选项里有区域名 → 这是在问拆/顺哪个区域 */
const looksLikeZones = (o: string[]) =>
  o.some(x => x.startsWith('装备区') || x.startsWith('判定区') || x.startsWith('手牌('));

/**
 * 区域按**语义**匹配,不按文本照抄。
 *
 * 这里踩过一次:schema 里写的是"照抄区域文本",可**写计划的时候区域选项根本还不存在** ——
 * 模型没见过 `手牌(4张,随机一张)` 这行字,只能瞎猜,结果写了"手牌区",对不上。
 * 让模型抄一个它没见过的东西,是设计错了。
 *
 * 区域只有三种,是个封闭集合,所以按关键词认类别是安全的。真正可能有歧义的是
 * "装备区有两件,拆哪件" —— 那个仍然要求牌名精确命中,对不上就交回模型。
 */
function matchZone(options: string[], zone: string): number {
  const want = zone.includes('判定') ? '判定区'
    : zone.includes('装备') ? '装备区'
      : zone.includes('手牌') ? '手牌(' : '';
  if (!want) return -1;
  const hits: number[] = [];
  options.forEach((o, i) => { if (o.startsWith(want)) hits.push(i); });
  if (hits.length === 1) return hits[0];
  if (!hits.length) return -1;
  // 同一类别里有多个(装备区两件、判定区两张):靠牌名区分,认不出就别猜
  const named = hits.filter(i => {
    const body = options[i].slice(want.length).trim();
    const name = body.split('[')[0].trim();
    return name && zone.includes(name);
  });
  return named.length === 1 ? named[0] : -1;
}

/**
 * 命中要么唯一、要么等价,否则作废 —— 宁可白写一份计划,也不猜一个"差不多"的。
 *
 * 有一种命中多个是**不该算歧义**的:牌堆里真的存在同名同花色同点数的重复牌
 * (杀♥J 有两张、闪♥2 有两张…),它们的选项标签一模一样、互相可替代,取第一个就行。
 * 实测吃过这个亏:模型规划了「杀[♥J] → 杀[♥J]」,而选项里正好躺着两张,
 * 被判成歧义、整份计划作废,白白多问了两次。
 *
 * 真歧义是**标签不同**却都被命中 —— 比如只写了"杀",而场上有 杀[♥J] 和 杀[♠3]。
 * 那种必须作废。
 */
function uniqueMatch(options: string[], needle: string): number {
  if (!needle) return -1;
  const hits: number[] = [];
  options.forEach((o, i) => { if (o.includes(needle)) hits.push(i); });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1 && new Set(hits.map(i => options[i])).size === 1) return hits[0];
  return -1;
}

export class PlanRunner {
  private steps: PlanStep[] = [];
  /** 正在执行的那一步 —— 它的 target/zone 要留给紧接着的子问题 */
  private active: PlanStep | null = null;
  /** 计划成立时的手牌 id;多出任何一张就作废 */
  private hand = new Set<number>();
  private turn = -1;
  /** 计划成立时的体力和"被无懈次数",变了说明前提已经不成立 */
  private hp = 0;
  private nullified = 0;

  /** 这一步是从计划里取的(统计用) */
  used = 0;
  /** 计划被丢弃的次数 */
  dropped = 0;

  get pending(): number { return this.steps.length; }

  /** 收下模型给的新计划。第一步已经由 choice 执行了,所以这里只存后续步骤 */
  adopt(game: Game, self: Player, steps: unknown, onDrop?: (why: string) => void): void {
    this.steps = [];
    this.active = null;
    if (!Array.isArray(steps) || !steps.length) return;
    const ok: PlanStep[] = [];
    for (const s of steps) {
      if (!s || typeof s !== 'object') continue;
      const act = typeof (s as any).act === 'string' ? (s as any).act.trim() : '';
      if (!act) continue;
      ok.push({
        act,
        target: Number.isInteger((s as any).target) ? (s as any).target : -1,
        zone: typeof (s as any).zone === 'string' ? (s as any).zone.trim() : '',
      });
    }
    // 模型给的第一步就是它这次选的动作,已经执行过了,别再重复一次
    ok.shift();
    if (!ok.length) { onDrop?.('模型给的计划为空'); return; }
    this.steps = ok;
    this.snapshot(game, self);
  }

  private snapshot(game: Game, self: Player) {
    this.hand = new Set(self.hand.map(c => c.id));
    this.turn = game.turnCount;
    this.hp = self.hp;
    this.nullified = game.nullified;
  }

  private drop(why: DropReason, onDrop?: (why: string) => void) {
    if (this.steps.length || this.active) { this.dropped++; onDrop?.(why); }
    this.steps = [];
    this.active = null;
  }

  /**
   * 试着从计划里回答这道题。返回 null 表示答不了,交回给模型。
   *
   * 顺序很重要:先查作废条件,再按题型匹配。
   */
  answer(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
    onDrop?: (why: string) => void,
  ): number[] | null {
    if (!this.steps.length && !this.active) return null;

    /*
     * —— 作废条件 ——
     *
     * 统一的判据是「**计划没预料到的事发生了**」,具体有四种:
     *
     *  1. 摸到新牌     —— 新牌改变前提(集智/连营/枭姬/无中生有…)
     *  2. 牌被无懈抵消 —— "拆掉仁王盾再用黑杀",拆桥被无懈之后那张杀的价值就变了
     *  3. 中途掉血     —— 决斗输了、闪电劈了,后面的进攻计划得重算
     *  4. 出了计划外的状况 —— 见下面 fallthrough:任何一次"计划答不上来、
     *     必须问模型"的场合(刚烈让你选掉血还是弃牌、要不要反无懈…),
     *     都说明局面偏离了计划,剩下的步骤不能闭着眼睛走完
     */
    if (game.turnCount !== this.turn) { this.drop('换了回合', onDrop); return null; }
    if (self.hand.some(c => !this.hand.has(c.id))) { this.drop('摸到新牌', onDrop); return null; }
    if (game.nullified !== this.nullified) { this.drop('牌被无懈可击抵消', onDrop); return null; }
    if (self.hp < this.hp) { this.drop('中途掉血', onDrop); return null; }

    // —— 子问题:目标 / 区域,用当前这一步里写好的 ——
    // 注意要先排除"出牌阶段"那道题:新动作一开始,上一步的子问题就结束了。
    // (漏了这条会把计划的最后一步吞掉 —— 它会被当成上一步的子问题然后返回 null。)
    if (this.active && !isPlayAction(question)) {
      if (looksLikePlayers(options) && this.active.target >= 0) {
        const i = uniqueMatch(options, `P${this.active.target}`);
        if (i >= 0 && min <= 1 && max >= 1) { this.used++; return [i]; }
      }
      if (looksLikeZones(options) && this.active.zone) {
        const i = matchZone(options, this.active.zone);
        if (i >= 0 && min <= 1 && max >= 1) { this.used++; return [i]; }
      }
      this.drop('出了计划外的状况', onDrop);
      return null;
    }

    // 计划还在,却冒出一道它管不着的题(反无懈、刚烈二选一…) —— 局面偏离了,重新规划
    if (!isPlayAction(question)) { this.drop('出了计划外的状况', onDrop); return null; }

    // —— 主问题:下一个出牌动作 ——
    if (min !== 1 || max !== 1) { this.drop('出了计划外的状况', onDrop); return null; }
    this.active = null;                    // 上一步到此为止
    if (!this.steps.length) return null;
    const step = this.steps[0];
    const i = uniqueMatch(options, step.act);
    if (i < 0) { this.drop('对不上选项', onDrop); return null; }

    this.steps.shift();
    this.active = step;
    this.used++;
    // 这一步会消耗掉一张手牌,所以基线要跟着走,否则下一步会误判成"摸到新牌"
    this.hand = new Set(self.hand.map(c => c.id));
    if (!this.steps.length) { /* 用完了,active 还留着答子问题 */ }
    return [i];
  }

  /** 换回合时主动清一次,避免把上一回合的计划带过来 */
  reset() { this.steps = []; this.active = null; }
}
