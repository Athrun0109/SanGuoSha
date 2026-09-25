/**
 * 从对局记录里算**行为指标** —— 用来回答"改了提示词之后,它打法变了没有"。
 *
 * ## 为什么不直接看胜率
 *
 * 胜率又贵又噪:单个席位跑 1000 局,95% 置信区间还有 ±3 个百分点,
 * 想分辨"提升了 2 个点"得跑上万局。而多数提示词改动想验证的假设其实是
 * **行为层面**的("它会不会多存牌""会不会先削弱再进攻"),那种东西
 * 二十来局就有信号 —— 因为每局有几十个决策点,样本量根本不是局数。
 *
 * 所以这里量的是**打法**,不是输赢。胜率留给最后确认用。
 *
 * ## 指标是怎么选的
 *
 * 每一条都对应一个**能证伪的假设**,不是"看着有用就记一下":
 *
 *   还有牌可用却收手   —— 假设"它有行动偏好,菜单里全是动词就一定要动一个"
 *   回合末手牌         —— 假设"它不会为回合外的防御留牌"
 *   削弱是否排在进攻前 —— 直接对应甘宁那个观察:先【杀】后【拆】,顺序反了
 *   技能被端上来就发动 —— 假设"技能一可用就无脑发动,不挑时机"
 *
 * 读法:这些数字**本身没有好坏**。它们只在 A/B 对比里有意义 ——
 * 同一个模型、同一批 seed,改动前后各跑一组,看哪一条动了。
 */

import * as fs from 'node:fs';

/** 削弱对手手牌/装备的牌。奇袭转化出来的也是【过河拆桥】,标签里认得出 */
const WEAKEN = ['过河拆桥', '顺手牵羊'];
/** 直接造成伤害的牌 */
const ATTACK = ['杀', '决斗', '南蛮入侵', '万箭齐发'];

/**
 * **要自己挑目标**的敌对牌 —— 算"集火"用这一份。
 *
 * 拆掉目标的闪、再由队友补刀,和两个人轮流砍同一个人一样是配合,所以削弱牌也算数。
 * 南蛮/万箭不在里面:它们打全场,目标不是选出来的,算进去只会把集火率稀释成噪声。
 */
const TARGETED_HOSTILE = ['杀', '决斗', '过河拆桥', '顺手牵羊', '乐不思蜀'];

/**
 * 指向队友就**明确是失误**的牌 —— 算"误伤"只用这一份,比上面窄。
 *
 * 【过河拆桥】【顺手牵羊】被排除在外:拆掉队友判定区里的【乐不思蜀】是**帮忙**,
 * 而日志行只写了目标是谁、没写动的是哪个区,分不出来。宁可漏报也不能误报 ——
 * 这个数字将来要用来判断留言功能有没有用,虚高一次就把结论带偏了。
 *
 * 已知的漏报:故意打队友【郭嘉】让他掉血摸两张,那其实是配合。真出现了会被算成误伤,
 * 但那正好说明配合水平不低,读数时留意一下。
 */
const FRIENDLY_FIRE = ['杀', '决斗', '乐不思蜀'];

/** `  1号位·赵云 使用 杀[♦8] → 2号位·周瑜` —— 牌名到第一个 `[` 或 `(` 为止 */
const USE_LINE = /(\d+)号位·\S* 使用 ([^\s[(]+)\S* → (.+)$/;
const SEAT_REF = /(\d+)号位·/g;

/**
 * 谁和谁是一队。
 *
 * 2v2 的 role 直接就是 blue/red。身份局里主忠算一队、反贼算一队,
 * **内奸没有队友**(它的目标和谁都不一致),所以单独归一档、不参与集火统计。
 */
function teamOf(role: string): string {
  if (role === 'blue' || role === 'red') return role;
  if (role === 'lord' || role === 'loyalist') return 'lord';
  if (role === 'rebel') return 'rebel';
  return `solo`;
}

const END_ACTION = '结束出牌阶段';

/** 从选项文本里抠出牌名:`过河拆桥[♣10](奇袭:杀)` -> `过河拆桥` */
function cardNameOf(label: string): string {
  return label.split('[')[0].split('(')[0].trim();
}

/**
 * 这个选项是不是技能带来的。**两种形态都要认**:
 *   主动技  `【离间】` `【仁德】`
 *   转化技  `过河拆桥[♠7](奇袭:杀)` `杀[♥K](武圣:桃)` `杀(丈八蛇矛:…)`
 * 只认前者的话,甘宁、关羽、赵云、大乔这些转化技武将会整个漏掉 ——
 * 而甘宁恰恰是最初那个观察的主角。普通牌是 `杀[♠7]`,不带括号,区分得开。
 */
const isSkill = (label: string) => label.startsWith('【') || label.includes('(');

export interface SeatMetrics {
  seat: number;
  general: string;
  /** 'llm' / 'rule' / 'human';记录里没写就是 '?' */
  control: string;
  turns: number;

  /**
   * 打了几局 / 赢了几局。
   *
   * 平时没什么用(胜率又贵又噪,见文件头),但明牌这类**同局内对照**的实验里
   * 它是唯一的结果测量:治疗组和对照组在同一副牌、同一批武将下对打,
   * 胜率直接就是效果,而且天然配对。
   */
  games: number;
  wins: number;

  /** 出牌阶段被问了多少次 */
  playAsks: number;
  /** 其中"除了收手还有别的选项、但选了收手"的次数 */
  endedEarly: number;
  /** 分母:出牌阶段里确实有别的选项可选的次数 */
  couldAct: number;

  /** 自己回合开始时的手牌数 */
  handStart: number[];
  /** 自己回合结束时(下一张快照)的手牌数 */
  handEnd: number[];

  /** 一个出牌阶段里既用了削弱牌又用了进攻牌的次数 */
  bothKinds: number;
  /** 其中削弱排在进攻前面的次数 */
  weakenFirst: number;

  /** 菜单里出现过技能选项(含转化技)的次数 */
  skillOffered: number;
  /** 其中真的选了技能的次数 */
  skillTaken: number;

  // ————— 配合 —————
  /** 主动指定目标的敌对牌使用次数(见 FRIENDLY_FIRE,分母) */
  hostileUses: number;
  /** 其中指向队友的次数 —— 赵云连打队友两张【杀】就是这个 */
  friendlyFire: number;
  /**
   * 集火的分母:本轮队友也对敌人下过手时,我打过的**不同**敌人个数。
   * 按"不同目标"而不是"出手次数"计,免得诸葛连弩连出三张杀就把比例顶上去。
   */
  coAttacks: number;
  /** 其中队友本轮也下过手的那些目标 —— 除以 coAttacks 就是集火率 */
  coFocus: number;
  /**
   * 同样这些出手,**完全瞎打**的话期望能重合多少个(小数)。
   *
   * 这一项不是锦上添花,是让集火率能读的前提。2v2 里敌人只有两个,瞎打也有 50%;
   * 更要命的是敌人**死剩一个**之后集火率必然是 100% —— 不减掉这部分,
   * "打到后期"会被读成"配合变好了"。所以按每次出手当时的存活敌人数逐笔折算:
   * 存活 E 个敌人、队友打过其中 m 个、我打了 k 个不同目标,瞎打的期望重合是 k·m/E。
   */
  coExpected: number;
  /**
   * 长得像出牌、却没被 USE_LINE 认出来的日志行数。
   * **不是统计量,是警报器**:战报措辞一改,上面几个数会安静地变成 0,
   * 而 0 和"从不误伤"看起来一模一样。这个数一旦不为 0 就说明解析漏了东西。
   */
  unparsedUses: number;

  /** 以下仅 LLM 席位有 */
  llmCalls: number;
  fromPlan: number;
  reasoningTokens: number;
  /**
   * 模型没给出可用答案、这一手交给规则 AI 兜底的次数。
   *
   * **做 A/B 时这一列必须先看。**兜底的那些决策是规则 AI 打的,却和 LLM 的决策
   * 混在同一个席位里。如果两组的兜底率差得远,"打法变了"完全可能只是
   * "更多决策掉进了兜底" —— 那就不是提示词/思考深度的效果,是可用性的差异。
   */
  fallbacks: number;
  /** 真实发出去的请求次数(含重试)与总耗时 —— effort 调高首先反映在这里 */
  apiCalls: number;
  apiMs: number;
}

function blank(seat: number): SeatMetrics {
  return {
    seat, general: '?', control: '?', turns: 0, games: 0, wins: 0,
    playAsks: 0, endedEarly: 0, couldAct: 0,
    handStart: [], handEnd: [],
    bothKinds: 0, weakenFirst: 0,
    skillOffered: 0, skillTaken: 0,
    hostileUses: 0, friendlyFire: 0, coAttacks: 0, coFocus: 0, coExpected: 0, unparsedUses: 0,
    llmCalls: 0, fromPlan: 0, reasoningTokens: 0,
    fallbacks: 0, apiCalls: 0, apiMs: 0,
  };
}

type Row = Record<string, any>;

/** 读一份对局记录,按席位算指标 */
export function metricsOfLog(file: string): Map<number, SeatMetrics> {
  const rows: Row[] = fs.readFileSync(file, 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l));

  const out = new Map<number, SeatMetrics>();
  const seat = (n: number) => {
    if (!out.has(n)) out.set(n, blank(n));
    return out.get(n)!;
  };

  // ——— 席位基本信息 ———
  for (const r of rows) {
    if (r.type === 'setup') {
      for (const p of r.players ?? []) seat(p.seat).general = p.general;
    }
    if (r.type === 'meta') {
      (r.seats ?? []).forEach((s: Row, i: number) => { seat(i).control = s.control ?? '?'; });
    }
  }

  /*
   * 手牌快照。记录器在**换回合时**补一张全场快照(见 Recorder.event),所以:
   *   自己回合开始的手牌 = 本回合那张快照
   *   自己回合结束的手牌 = 下一回合那张快照(弃牌阶段已经结算完)
   * 这个近似对所有席位一视同仁,拿来做 A/B 对比是公平的。
   */
  const snaps = rows.filter(r => r.type === 'state' && r.players);
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i].cur;
    if (typeof cur !== 'number') continue;
    const me = snaps[i].players[cur];
    if (!me?.alive) continue;
    seat(cur).turns++;
    seat(cur).handStart.push(me.hand.length);
    const next = snaps[i + 1];
    if (next?.players?.[cur]?.alive) seat(cur).handEnd.push(next.players[cur].hand.length);
  }

  // ——— 出牌阶段的动作序列 ———
  const answerOf = new Map<number, Row>();
  for (const r of rows) if (r.type === 'answer') answerOf.set(r.of, r);

  // 按 (回合, 席位) 把一个出牌阶段里的动作攒起来
  const phaseActions = new Map<string, string[]>();

  for (const r of rows) {
    if (r.type !== 'ask' || r.kind !== 'playAction') continue;
    const m = seat(r.seat);
    const ans = answerOf.get(r.i);
    const picked: string | undefined = ans?.choice?.length ? r.options[ans.choice[0]] : undefined;

    m.playAsks++;
    const others = (r.options as string[]).filter(o => o !== END_ACTION);
    if (others.length > 0) {
      m.couldAct++;
      if (picked === END_ACTION) m.endedEarly++;
    }
    if (others.some(isSkill)) {
      m.skillOffered++;
      if (picked && isSkill(picked)) m.skillTaken++;
    }
    if (picked && picked !== END_ACTION) {
      const key = `${r.turn}:${r.seat}`;
      if (!phaseActions.has(key)) phaseActions.set(key, []);
      phaseActions.get(key)!.push(cardNameOf(picked));
    }
  }

  for (const [key, names] of phaseActions) {
    const s = seat(Number(key.split(':')[1]));
    const wi = names.findIndex(n => WEAKEN.includes(n));
    const ai = names.findIndex(n => ATTACK.includes(n));
    if (wi >= 0 && ai >= 0) {
      s.bothKinds++;
      if (wi < ai) s.weakenFirst++;
    }
  }

  /*
   * ——— 配合:误伤队友 + 集火 ———
   *
   * 走**战报文本**而不是 ask/answer,是因为 ask 会漏掉最要命的那一类:
   * 合法目标只剩一个时引擎直接替玩家选掉,根本不产生 ask 事件 ——
   * 20260821-202633 里赵云连打队友两张【杀】就是这么来的。日志行照样有。
   */
  const team = new Map<number, string>();
  for (const r of rows) {
    if (r.type !== 'setup') continue;
    for (const p of r.players ?? []) if (p.role) team.set(p.seat, teamOf(p.role));
  }
  const mates = (s: number) => {
    const t = team.get(s);
    if (!t || t === 'solo') return [];      // 内奸没有队友,不参与集火统计
    return [...team.keys()].filter(x => x !== s && team.get(x) === t);
  };

  /** 轮次 -> 席位 -> {打过哪些敌人, 当时还有几个敌人活着} */
  const byRound = new Map<number, Map<number, { hit: Set<number>; enemies: number }>>();

  // 存活情况随快照滚动更新 —— 算随机基线要知道"当时还有几个敌人可选"
  const alive = new Set<number>(team.keys());

  for (const r of rows) {
    if (r.type === 'state' && Array.isArray(r.players)) {
      for (const p of r.players) if (p.alive === false) alive.delete(p.seat);
      continue;
    }
    if (r.type !== 'log' || typeof r.line !== 'string') continue;
    const line: string = r.line;
    const m = USE_LINE.exec(line);
    if (!m) {
      // 像出牌却没解析出来 —— 报警,别让它安静地漏过去
      if (line.includes(' 使用 ') && line.includes('→')) seat(-1).unparsedUses++;
      continue;
    }
    const from = Number(m[1]);
    const card = m[2];
    const targets = [...m[3].matchAll(SEAT_REF)].map(x => Number(x[1]));
    const mine = team.get(from);

    for (const to of targets) {
      if (to === from) continue;                       // 装备、无中生有之类打给自己的
      const friendly = !!mine && team.get(to) === mine && mine !== 'solo';
      if (FRIENDLY_FIRE.includes(card)) {
        seat(from).hostileUses++;
        if (friendly) seat(from).friendlyFire++;
      }
      if (TARGETED_HOSTILE.includes(card) && !friendly) {
        const rd = r.round ?? 0;
        if (!byRound.has(rd)) byRound.set(rd, new Map());
        const per = byRound.get(rd)!;
        const foes = [...alive].filter(x => mine && team.get(x) !== mine).length;
        // 存活敌人数取本轮**第一次出手**时的值:出手之后可能有人当场阵亡,
        // 用事后的数会把"选的时候其实有两个人可选"记成"只有一个",基线就虚高了
        if (!per.has(from)) per.set(from, { hit: new Set(), enemies: Math.max(1, foes) });
        per.get(from)!.hit.add(to);
      }
    }
  }

  for (const per of byRound.values()) {
    for (const [s, mine] of per) {
      const mateHits = new Set<number>();
      for (const mate of mates(s)) for (const t of per.get(mate)?.hit ?? []) mateHits.add(t);
      if (!mateHits.size) continue;          // 队友本轮没出手 -> 谈不上集不集火
      const me = seat(s);
      me.coAttacks += mine.hit.size;
      for (const t of mine.hit) if (mateHits.has(t)) me.coFocus++;
      // 瞎打的期望重合数 —— 敌人只剩一个时这一项等于 coAttacks,自动抵消
      me.coExpected += mine.hit.size * Math.min(mateHits.size, mine.enemies) / mine.enemies;
    }
  }

  /*
   * ——— 胜负 ———
   *
   * **一局只能贡献一个观测。**一支队伍的两个席位同赢同输 —— 按席位数就把
   * 60 局数成了 120 个"独立"样本,标准误被低估 √2 倍,p 值跟着虚小。
   * 明牌实验第一版就踩了这个:显示 68/120 p=0.039(看着显著),
   * 实际是 34/60 p=0.30(完全不显著)。
   *
   * 所以按 (队伍 × 控制方式) 分组,每组每局只记一次。用"控制方式"再切一刀是因为
   * 同一支队伍里可能一个 LLM 一个规则 AI —— 那时两边各自都该拿到这一局。
   */
  const end = rows.find(r => r.type === 'end' && Array.isArray(r.winners));
  const setupRow = rows.find(r => r.type === 'setup');
  if (end && setupRow) {
    const won = new Set<number>(end.winners);
    const groups = new Map<string, number>();       // 队伍|控制方式 -> 代表席位
    for (const p of setupRow.players ?? []) {
      const key = `${p.role ?? '?'}|${seat(p.seat).control}`;
      // 代表取席位号最小的那个,和读取顺序无关,重跑结果一致
      if (!groups.has(key) || p.seat < groups.get(key)!) groups.set(key, p.seat);
    }
    for (const rep of groups.values()) {
      seat(rep).games++;
      // 同队同赢同输,拿代表席位判就够了
      if (won.has(rep)) seat(rep).wins++;
    }
  }

  // ——— LLM 成本 ———
  for (const r of rows) {
    if (r.type !== 'llm') continue;
    /*
     * 优先用显式的 seat 字段。尾号解析只是为了读得懂旧日志 ——
     * 蜂群的 agentId 是 `llm-blue`,没有尾号,靠猜的话整组决策会静默丢失。
     */
    const n = typeof r.seat === 'number'
      ? r.seat
      : Number(String(r.agentId).match(/(\d+)$/)?.[1]);
    if (!Number.isInteger(n)) continue;
    const m = seat(n);
    m.llmCalls++;
    if (r.fromPlan) m.fromPlan++;
    if (r.usedFallback) m.fallbacks++;
    for (const a of r.attempts ?? []) {
      m.reasoningTokens += a.usage?.reasoning_tokens ?? 0;
      m.apiCalls++;
      m.apiMs += a.ms ?? 0;
    }
  }

  return out;
}

/** 把 b 累加进 a。所有"归并"都走这里,免得加了字段忘了在某一处累加 */
function accInto(acc: SeatMetrics, m: SeatMetrics): SeatMetrics {
  acc.turns += m.turns;
  acc.games += m.games; acc.wins += m.wins;
  acc.playAsks += m.playAsks; acc.endedEarly += m.endedEarly; acc.couldAct += m.couldAct;
  acc.handStart = acc.handStart.concat(m.handStart);
  acc.handEnd = acc.handEnd.concat(m.handEnd);
  acc.bothKinds += m.bothKinds; acc.weakenFirst += m.weakenFirst;
  acc.skillOffered += m.skillOffered; acc.skillTaken += m.skillTaken;
  acc.hostileUses += m.hostileUses; acc.friendlyFire += m.friendlyFire;
  acc.coAttacks += m.coAttacks; acc.coFocus += m.coFocus; acc.coExpected += m.coExpected;
  acc.unparsedUses += m.unparsedUses;
  acc.llmCalls += m.llmCalls; acc.fromPlan += m.fromPlan;
  acc.reasoningTokens += m.reasoningTokens;
  acc.fallbacks += m.fallbacks;
  acc.apiCalls += m.apiCalls; acc.apiMs += m.apiMs;
  return acc;
}

/** 把多份记录的指标按席位归并 —— A/B 对比时一组一组地喂 */
export function merge(all: Array<Map<number, SeatMetrics>>): Map<string, SeatMetrics> {
  const out = new Map<string, SeatMetrics>();
  for (const one of all) {
    for (const m of one.values()) {
      // 按"武将 + 控制方式"归并,而不是按座位号 —— 换一局座位就变了
      const key = `${m.control}/${m.general}`;
      const acc = out.get(key) ?? { ...blank(-1), general: m.general, control: m.control };
      out.set(key, accInto(acc, m));
    }
  }
  return out;
}

/**
 * 再往上收一层:**把同一种控制方式的所有武将合成一行**。
 *
 * 为什么必须有这个 —— 一批十几局会摸到二十来个不同武将,按武将分组后每行只剩
 * 一两个样本,`3/4 (75%)` 这种数字纯粹是噪声,两组摆一起也读不出东西。
 * 而"改 effort 有没有让它打法变了"问的本来就是**整体倾向**,不是"它玩甘宁怎么样"。
 * 想看单个武将,得专门用 --generals 把那个武将钉住,再跑够局数。
 */
export function pool(m: Map<string, SeatMetrics>): Map<string, SeatMetrics> {
  const out = new Map<string, SeatMetrics>();
  for (const one of m.values()) {
    const acc = out.get(one.control)
      ?? { ...blank(-1), general: '合计', control: one.control };
    out.set(one.control, accInto(acc, one));
  }
  return out;
}

export const avg = (xs: number[]) =>
  (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** `x/y` 显示成 `x/y (p%)`;分母为 0 时显示 `—`,别拿 0 冒充"从不" */
export function ratio(x: number, y: number): string {
  return y === 0 ? '—' : `${x}/${y} (${Math.round(x * 100 / y)}%)`;
}
