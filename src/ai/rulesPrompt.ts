/**
 * 发给 LLM 的提示词,分四层:
 *
 *   L0 规则      永不变        → system[0]
 *   L1 本局常量  一局不变      → system[1](缓存断点)
 *   L2 局面      每次决策重建  ┐
 *   L3 近期战报  滚动窗口      ├→ 每次决策的 user 消息
 *   L4 问题+选项 每次决策      ┘
 *
 * 两条设计原则:
 *  1. **规则里不写合法性**。引擎已经算好合法动作集,选项列表就是合法动作全集,
 *     模型不可能出非法牌。所以"杀每回合限一次""顺手牵羊距离1""空城不能被指定"
 *     这类规则一律删掉,只留后果和数值 —— 模型需要的是"打出去会怎样",不是"能不能打"。
 *  2. **L2 必须自足**。只看 L2 就能做出不离谱的决策,L3 只用来推测意图。
 *     这样滚动窗口把旧战报丢掉也不会让模型失能。
 */

import { ROLE_NAME } from '../core/types.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import type { Codec } from './codec.js';
import { countCards, type CardCount } from './cardCounter.js';

// ————————————————— L0 规则 —————————————————

export function buildRules(c: Codec): string {
  const n = (x: string) => c.cardName(x);
  // anon 模式下连游戏名都不能出现 —— 说出"三国杀"三个字,
  // 模型就会把整套原版规则从预训练记忆里调出来,代号化就白做了。
  const title = c.usesCodes ? '一个多人卡牌对战游戏' : '三国杀标准版';
  return `${title}。你会被反复问一个个具体决策,只需从给出的编号选项中挑。
引擎已经过滤掉所有非法动作 —— 选项里出现的都合法,不必判断"能不能",只需判断"该不该"。

胜负 lord:击败所有 rebel 和 renegade | rebel:击败 lord(任一 rebel 存活即算赢)| renegade:成为唯一存活者
奖惩 击败 rebel → 摸3张 | lord 击败 loyalist → lord 弃光所有牌
回合 准备→判定→摸2张→出牌→弃牌(上限=当前hp)→结束

牌的效果
${n('杀')}   目标须打出 ${n('闪')},否则 -1hp
${n('闪')}   仅用于响应 ${n('杀')} / ${n('万箭齐发')}
${n('桃')}   自己 hp+1;有人濒死时可对其使用,救回 hp+1
${n('决斗')}  目标先出 ${n('杀')},双方轮流,先接不上的一方 -1hp
${n('过河拆桥')}  弃置目标一张牌(对方手牌是暗的,只能随机命中)
${n('顺手牵羊')}  获得目标一张牌(同上)
${n('无中生有')}  自己摸2张
${n('南蛮入侵')}  其他所有人须出 ${n('杀')},否则各 -1hp
${n('万箭齐发')}  其他所有人须出 ${n('闪')},否则各 -1hp
${n('桃园结义')}  所有人 hp+1(敌人也回)
${n('五谷丰登')}  亮出等同存活人数的牌,从使用者起各取一张
${n('借刀杀人')}  令一名有武器的角色对其射程内某人出 ${n('杀')},不从则把武器给你
${n('无懈可击')}  抵消一个锦囊;可对 ${n('无懈可击')} 再用 ${n('无懈可击')},逐层反转
${n('乐不思蜀')}  置于目标判定区,其判定阶段判定非♥则跳过其出牌阶段
${n('闪电')}  置于自己判定区,判定 ♠2~♠9 则 -3hp,否则移到下家

装备(括号内为射程)
${n('诸葛连弩')}(1) ${n('杀')}无次数限制 | ${n('雌雄双股剑')}(2) 对异性出${n('杀')}时其弃1手牌否则你摸1
${n('青釭剑')}(2) 无视防具 | ${n('青龙偃月刀')}(3) ${n('杀')}被抵消后可再出一张${n('杀')}
${n('丈八蛇矛')}(3) 两张手牌当${n('杀')} | ${n('贯石斧')}(3) 弃两张牌使被抵消的${n('杀')}仍造成伤害
${n('方天画戟')}(4) 最后手牌的${n('杀')}可指定至多3目标 | ${n('麒麟弓')}(5) ${n('杀')}造成伤害时弃对方一匹马
${n('八卦阵')} 需${n('闪')}时判定红色则视为${n('闪')} | ${n('仁王盾')} 黑色${n('杀')}对你无效
${n('防御马')} 他人算与你的距离+1(更难被够到)| ${n('进攻马')} 你算与他人的距离-1(够得更远)

要点 手牌上限=当前hp,残血留不住牌。${n('桃')}稀缺,一般留到濒死。濒死时全场按座次依次问${n('桃')},敌人通常不救。

输出 只回一个 JSON:{"thinking":"简短中文推理","choice":[编号]}
放弃/不选用 []。编号必须来自当次选项。`;
}

// ————————————————— L1 本局常量 —————————————————

export function identityBlock(game: Game, self: Player, c: Codec): string {
  const rows = game.players.map(p => {
    const who = p === self ? `${c.player(p)} 你` : c.player(p);
    const g = c.mode === 'verbose' ? ` ${p.general.name}` : '';
    const sex = p.gender === 'male' ? '男' : '女';
    return `${who}${g} ${p.kingdom} ${sex} hp上限${p.maxHp}\n  技能 ${c.skills(p)}`;
  });
  return `本局 ${game.players.length} 人。你是 ${c.player(self)},身份 ${self.role}(${ROLE_NAME[self.role]}),只有你自己知道。
武将和技能是公开信息,身份不是。

${rows.join('\n')}`;
}

// ————————————————— L2 局面 —————————————————

export function situationBlock(game: Game, self: Player, c: Codec): string {
  const count = countCards(game, self);
  const lines: string[] = [`R${game.round} turn=${c.player(game.current)}`];

  lines.push('角色 hp 手牌 装备 判定区 身份 距你');
  for (const p of game.players) {
    if (!p.alive) { lines.push(`${c.player(p, self)} 阵亡 身份${p.role}`); continue; }
    const eq = p.equipCards.map(x => c.cardName(x.name)).join(',') || '-';
    // 判定区明置:算什么 + 实际是什么都给。顺手牵羊拿走的是实体牌,
    // 只说"乐不思蜀"的话模型不知道自己会拿到一张【闪】
    const jd = p.judgeZone.map(x => {
      const as = c.cardName(game.judgeName(p, x));
      return game.judgeName(p, x) === x.name ? as : `${as}(${c.card(x)})`;
    }).join(',') || '-';
    const role = p.revealed ? p.role : (p === self ? p.role : '?');
    const dist = p === self ? '-' : String(game.distance(self, p));
    lines.push(`${c.player(p, self)} ${p.hp}/${p.maxHp} ${p.handCount} ${eq} ${jd} ${role} ${dist}`);
  }

  lines.push(`你 射程${game.attackRange(self)} 手牌上限${game.maxHand(self)}`);
  lines.push(`你的手牌 ${self.hand.map(x => c.card(x)).join(' ') || '(空)'}`);

  const h = hostilityBlock(game, c);
  if (h) lines.push(h);
  lines.push(counterBlock(game, self, c, count));
  return lines.join('\n');
}

/**
 * 交手记录 —— 这是身份推测的全部信息来源,而且是从第 1 回合起累计的。
 * 有了它就不需要为了猜身份而保留几十轮的原始战报。
 */
export function hostilityBlock(game: Game, c: Codec): string {
  const items: string[] = [];
  for (const a of game.players) {
    for (const b of game.players) {
      const d = game.hostility(a, b);
      if (!d) continue;
      // 两头身份都已明示的一对,对推身份不再有任何价值(死人也不会再行动),
      // 只是在每次调用里白占位置。8 人局打到后期这能砍掉一多半。
      if (a.revealed && b.revealed) continue;
      items.push(`${c.tag(a)}→${c.tag(b)}:${d}`);
    }
  }
  return items.length ? `交手记录(公开,累计伤害) ${items.join(' ')}` : '';
}

export function counterBlock(game: Game, self: Player, c: Codec, count: CardCount): string {
  const unseen = count.rows
    .filter(r => r.unknown > 0)
    .map(r => `${c.cardName(r.group)}${r.unknown}`)
    .join(' ');
  // 同上,这里也用短标签:一行里要提 3 次概率,武将名重复得最凶
  const odds = game.others(self).map(p => {
    const d = Math.round(count.holdChance(p, '闪') * 100);
    const s = Math.round(count.holdChance(p, '杀') * 100);
    const t = Math.round(count.holdChance(p, '桃') * 100);
    return `${c.tag(p)} ${c.cardName('闪')}${d}% ${c.cardName('杀')}${s}% ${c.cardName('桃')}${t}%`;
  }).join(' | ');
  return [
    `记牌器 未知池${count.poolSize}(牌堆${count.deckSize}+他人暗牌${count.hiddenHands})`,
    `未现身 ${unseen || '(无)'}`,
    odds ? `估算 ${odds}` : '',
  ].filter(Boolean).join('\n');
}

// ————————————————— L3 / L4 —————————————————

/**
 * 【当前局势】和【历史记录】是两种粒度,不该用同一套记法:
 *
 *  - L2 局面必须精确到花色点数。手上的牌是拿来算的 —— ♥ 还是 ♠ 直接决定
 *    仁王盾挡不挡、八卦阵判不判得过、大乔能不能把它当乐不思蜀甩出去。
 *  - L3 战报只保留因果。一张结算完的【杀】是 ♠10 还是 ♣3,对之后的任何决策
 *    都不再产生影响(仁王盾判黑杀是结算当时的事,已经过去了),记牌的活交给记牌器。
 *
 * 实测 20 局的全部战报:四类纯冗余占 27%,[花色点数] 又占剩下部分的 18%。
 *
 * 唯一的例外是**改判定**(鬼才)。判定牌翻出什么不重要,但"谁肯掏一张手牌
 * 去改谁的判定"是推身份的强证据,所以那一行要完整保留。
 */
const LOG_NOISE = [
  /^=+ 第 \d+ 轮 =+$/,
  /^--- 回合 \d+/,
  /手牌上限 \d+,需弃置/,
  /无需弃牌$/,

  // —— 判定:只留"生效/不生效",翻出的是哪张交给记牌器 ——
  /判定\[.+\] 亮出 /,
  /^\S+ 发动【八卦阵】$/,            // 判定[八卦阵] 那行已经说了发没发动、成没成
  /的八卦阵生效,视为打出/,          // 同上
  /^\S+ 发动【鬼才】$/,              // 紧跟其后的"用X替换Y的判定牌Z(鬼才)"写得更全
  /被【乐不思蜀】跳过出牌阶段$/,      // 留下更短的那行 "PX 跳过出牌阶段"

  // —— "使用"的必然后果,规则里已经写死,不必再叙述一遍 ——
  /^\S+ 装备 /,
  /^\S+ \S+ \d+ 张(?: |$)/,          // 摸牌/无中生有/集智/闭月/击杀奖励…手牌数 L2 里有
  /^\S+ 击杀\S+,摸三张牌$/,
  /获得了 .+ 的一张牌$/,             // 顺手牵羊的结果
  /^\S+ 躲开了/,                     // 前一行的"打出 闪"已经说明了
  /作为【.+】置于 .+ 的判定区$/,      // 判定区状态 L2 里有
  /^※ .+濒死!$/,                    // 有没有人救,看后面有没有【桃】
];

/** 结算完的牌只留名字。转化技后缀(武圣、丈八蛇矛)不动 —— 那是技能证据 */
const CARD_MARK = /\[[♠♥♣♦](?:10|[2-9AJQK])\]/g;
/**
 * **弃牌是例外:花色点数要留着。**
 *
 * 一张结算完的【杀】是什么花色不再影响任何决策,所以战报里删掉;但**弃牌不一样** ——
 * 它是公开信息,而且直接支撑手牌推理:对手弃了一张【闪】,说明他不缺闪;弃掉红桃
 * 说明他手里红牌够用。这类线索只有带着花色点数才成立。
 *
 * 代价很小:一条弃牌行多几个字符,而滚动窗口本来就只有 350 字,自然限定在最近几轮。
 */
const KEEP_MARKS = /弃置/;
/** 行尾的状态括号:(P0 1/5)、(3/5) —— L2 快照里都是当前值,历史值没人关心 */
const STATE_TAIL = /\s*\((?:\S+ )?-?\d+\/-?\d+\)$/;

/** 把引擎的原始日志压成 L3 战报。记录器那边存的仍是全量原文,排查时不受影响 */
export function filterLog(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || LOG_NOISE.some(re => re.test(t))) continue;
    const body = KEEP_MARKS.test(t) ? t : t.replace(CARD_MARK, '');
    out.push(body.replace(STATE_TAIL, ''));
  }
  return out;
}

/**
 * 滚动战报,**按字数封顶而不是按行数**。
 *
 * 这条容易被改回去,所以写清楚:按行封顶的话,上面删掉的噪声行会让滑窗自动
 * 往前多吃几行旧战报,总字数纹丝不动 —— 等于把省下来的钱又原样花了出去。
 */
export function eventsBlock(lines: string[], c: Codec, budget = Infinity): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = c.text(lines[i].trim());
    if (!l) continue;
    // 至少留一行,否则预算给小了整块会消失
    if (kept.length && used + l.length + 1 > budget) break;
    kept.unshift(l);
    used += l.length + 1;
  }
  if (!kept.length) return '';
  return `近期战报\n${kept.join('\n')}`;
}

/**
 * 出牌阶段专用的补充说明。**必须写清会在哪里中断** ——
 * 否则模型会以为自己规划的杀一定打得出去,在推理里做出错误的连锁判断。
 */
export function planHint(): string {
  // 这里**不能举具体牌名做例子** —— anon 模式下那就是一次泄漏(有测试盯着)。
  // 说"照抄"本来也比举例更准确:要的就是原样复制,不是照着格式仿写。
  return `你还可以顺便写下接下来几步的计划(plan 字段),这样它们会被直接执行,不再逐步问你。
act 请把选项里的动作文本**一字不差地抄过来**(连花色点数一起);要指定目标就填 target 座位号,不指定填 -1;
拆/顺要拿哪个区域就照抄区域文本填 zone,不需要填空串。
计划会在这些时候作废并重新问你:**你摸到新牌**(新牌会改变判断)、某一步对不上当前选项、回合结束。
所以别把"摸到牌之后再看"这类打算写进计划;先把摸牌的牌用掉,再规划进攻。`;
}

export function questionBlock(
  question: string, options: string[], min: number, max: number, c: Codec,
): string {
  const range = min === max ? `选${min}个` : min === 0 ? `选0~${max}个,不想选就给 []` : `选${min}~${max}个`;
  return `问题 ${c.text(question)}\n` +
    options.map((o, i) => `${i}:${c.text(o)}`).join('\n') +
    `\n${range}`;
}
