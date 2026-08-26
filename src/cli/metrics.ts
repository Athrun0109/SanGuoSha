/**
 * 行为指标:`npm run metrics [日志文件或目录...]`
 *
 * 不给文件就读 logs/ 下全部记录。可以给两组做 A/B:
 *
 *   npm run metrics logs/before/ -- --vs logs/after/
 *
 * 数字**本身没有好坏** —— 只在对比里有意义。所以还有一个基准:
 *
 *   npm run metrics -- --sim 40        # 现跑 40 局规则 AI,算同一套指标
 *
 * 规则 AI 不花钱、也不受提示词影响,拿它当参照系能立刻看出"LLM 是打得不一样,
 * 还是只是随机波动"。详见 src/eval/metrics.ts 的注释。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { metricsOfLog, merge, pool, avg, ratio, type SeatMetrics } from '../eval/metrics.js';
import { infoUse } from '../eval/usedInfo.js';

/**
 * 两组比例差异的粗筛。
 *
 * **这是筛子,不是判决。**双样本 z 检验假设每个观测互相独立,而这里的观测是
 * 同一局里连着做的决策 —— 手牌好的一回合里几个选择全都相关。所以真实的不确定度
 * 比 p 值显示的**要大**,它只配用来把"连噪声都算不上"的那几行先划掉。
 * 想要真结论,得加局数、并且换个模型/seed 段再复现一次。
 */
function zTest(x1: number, n1: number, x2: number, n2: number): string {
  if (n1 < 10 || n2 < 10) return '样本太少';
  const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return '—';
  const pv = twoSided((p1 - p2) / se);
  return pv < 0.01 ? `p<0.01 ★★` : pv < 0.05 ? `p=${pv.toFixed(3)} ★` : `p=${pv.toFixed(2)}`;
}

/**
 * 这批数据**最小能测出多大的差异**(80% 把握、双侧 5%)。
 *
 * 没有这一列,"p=0.25 所以没差别"是个陷阱:样本少的时候,就算真差 30 个百分点
 * 也照样测不出显著。所以每行都要能分辨两种"没看到差异":
 *   观测差 << 可测阈值  → 确实没什么变化
 *   观测差 ~= 或 > 阈值  → **样本不够,什么都不能说**,要么加局数要么钉住武将
 */
function mde(x1: number, n1: number, x2: number, n2: number): string {
  if (!n1 || !n2) return '—';
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return `${(2.8 * se * 100).toFixed(0)}pt`;      // 1.96 + 0.84 个标准误
}

/** 正态尾概率(Abramowitz-Stegun 7.1.26 的 erf 近似),双侧 */
function twoSided(z: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-((Math.abs(z) / Math.SQRT2) ** 2));
  return 1 - erf;
}

/** 单样本二项检验:x 胜 n 局,和五五开比 */
function binom(x: number, n: number): string {
  if (n < 10) return '样本太少';
  const z = (x / n - 0.5) / Math.sqrt(0.25 / n);
  const pv = twoSided(z);
  return pv < 0.01 ? 'p<0.01 ★★' : pv < 0.05 ? `p=${pv.toFixed(3)} ★` : `p=${pv.toFixed(2)}`;
}

/**
 * 「模型有没有用上多给它的信息」。见 eval/usedInfo.ts。
 *
 * 这一块决定了上面那张对比表**怎么读**:如果治疗组和对照组在这里也一样,
 * 那"指标没动"的意思是"模型没看",而不是"信息没用" —— 该改提示词的写法,
 * 而不是放弃这条路。
 */
function showInfoUse(files: string[], ka: string, kb: string) {
  const use = infoUse(files);
  const a = use.get(ka), b = use.get(kb);
  if (!a || !b) return;
  console.log(`\n${'─'.repeat(78)}\n模型有没有用上队友的暗牌(翻它自己的推理原文)`);
  console.log('  ' + '组'.padEnd(12) + '推理条数'.padStart(10) +
    '提到牌名'.padStart(14) + '逐字引用'.padStart(14));
  for (const r of [a, b]) {
    console.log('  ' + r.control.padEnd(12) + String(r.thoughts).padStart(10) +
      ratio(r.byName, r.thoughts).padStart(14) + ratio(r.verbatim, r.thoughts).padStart(14));
  }
  console.log(`  绝对值没意义(队友**打出**的牌本来就公开)—— 只看 ${ka} 减 ${kb} 的差。`);
  for (const s of a.samples.slice(0, 2)) console.log(`  · ${s}`);
}

/** 并排列出两组的合计行,只看差在哪 */
function compare(labelA: string, ma: Map<string, SeatMetrics>,
                 labelB: string, mb: Map<string, SeatMetrics>,
                 keyA = 'llm', keyB = 'llm') {
  const a = pool(ma).get(keyA), b = pool(mb).get(keyB);
  if (!a || !b) {
    console.log(`\n找不到 ${!a ? keyA : keyB} 这组席位(记录的 meta 缺 seats?),无法对比`);
    return;
  }
  console.log(`\n${'═'.repeat(78)}\nA/B 对比\n${'═'.repeat(78)}`);
  // 符号方向必须写死在表头。`--vs 改动前 改动后` 时"后减前"读着自然,
  // 但 `--pools 治疗组 对照组` 时第一列才是治疗组,不标明就会把改善读成劣化
  console.log('指标'.padEnd(22) + labelA.padStart(17) + labelB.padStart(17) +
    `  ${labelB}−${labelA}`);

  const pct = (name: string, xa: number, na: number, xb: number, nb: number) => {
    const d = na && nb ? (xb / nb - xa / na) * 100 : NaN;
    console.log(name.padEnd(22) + ratio(xa, na).padStart(17) + ratio(xb, nb).padStart(17) +
      (Number.isNaN(d) ? '' : `  ${d >= 0 ? '+' : ''}${d.toFixed(0)}pt`.padStart(7) +
        `  ${zTest(xa, na, xb, nb)}`.padEnd(14) + `可测 ±${mde(xa, na, xb, nb)}`));
  };
  const num = (name: string, va: number, vb: number, unit = '') => {
    const d = vb - va;
    console.log(name.padEnd(22) + (va.toFixed(1) + unit).padStart(17) +
      (vb.toFixed(1) + unit).padStart(17) + `  ${d >= 0 ? '+' : ''}${d.toFixed(1)}${unit}`);
  };

  if (a.games && b.games) {
    /*
     * 同局对手要按**配对**来检验,不能当两个独立样本。
     *
     * 明牌实验里治疗组和对照组是同一局里的两支队伍,一方赢另一方必输 ——
     * 34/60 和 26/60 是同一个数的两面,信息量只有 60 局那么多。
     * 套双样本 z 检验等于把样本量当成了 120,标准误低估 √2 倍。
     * 互补(两边局数相同、胜场加起来正好等于局数)就自动切到单样本二项检验。
     */
    const paired = a.games === b.games && a.wins + b.wins === a.games;
    if (paired) {
      const n = a.games, p = a.wins / n, se = Math.sqrt(0.25 / n);
      console.log('胜率(同局对手,配对)'.padEnd(20) +
        ratio(a.wins, n).padStart(17) + ratio(b.wins, n).padStart(17) +
        `  ${((p - 0.5) * 200).toFixed(0)}pt`.padStart(7) +
        `  ${binom(a.wins, n)}`.padEnd(14) + `可测 ±${(2.8 * se * 100).toFixed(0)}pt`);
    } else {
      pct('胜率', a.wins, a.games, b.wins, b.games);
    }
  }
  num('自己的回合数', a.turns, b.turns);
  num('回合开始手牌', avg(a.handStart), avg(b.handStart));
  num('回合结束手牌', avg(a.handEnd), avg(b.handEnd));
  pct('还有牌却收手', a.endedEarly, a.couldAct, b.endedEarly, b.couldAct);
  pct('技能端上就用', a.skillTaken, a.skillOffered, b.skillTaken, b.skillOffered);
  pct('削弱排在进攻前', a.weakenFirst, a.bothKinds, b.weakenFirst, b.bothKinds);
  pct('集火(瞎打=50%)', a.coFocus, a.coAttacks, b.coFocus, b.coAttacks);
  pct('误伤队友', a.friendlyFire, a.hostileUses, b.friendlyFire, b.hostileUses);
  console.log('─'.repeat(78));
  pct('兜底(先看这行)', a.fallbacks, a.llmCalls, b.fallbacks, b.llmCalls);
  pct('按计划执行', a.fromPlan, a.llmCalls, b.fromPlan, b.llmCalls);
  num('每次请求耗时', a.apiMs / Math.max(1, a.apiCalls) / 1000,
    b.apiMs / Math.max(1, b.apiCalls) / 1000, 's');
  num('每次决策的推理量', a.reasoningTokens / Math.max(1, a.llmCalls),
    b.reasoningTokens / Math.max(1, b.llmCalls), 'tok');
  console.log(`\n★ 只是粗筛(见 zTest 注释:同一局内的决策并不独立,真实不确定度更大)。`);
  console.log('兜底那行如果两组差得远,上面所有行都不能直接比 —— 兜底的手是规则 AI 打的。');
}

function expand(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args.length ? args : ['logs']) {
    if (!fs.existsSync(a)) { console.error(`找不到:${a}`); continue; }
    if (fs.statSync(a).isDirectory()) {
      for (const f of fs.readdirSync(a)) {
        if (f.endsWith('.jsonl')) out.push(path.join(a, f));
      }
    } else if (a.endsWith('.jsonl')) out.push(a);
  }
  return out;
}

function collect(files: string[]) {
  const ok: Array<ReturnType<typeof metricsOfLog>> = [];
  for (const f of files) {
    try { ok.push(metricsOfLog(f)); } catch (e) {
      console.error(`  跳过 ${f}:${e instanceof Error ? e.message : e}`);
    }
  }
  return merge(ok);
}

function show(title: string, m: Map<string, SeatMetrics>) {
  console.log(`\n${'═'.repeat(78)}\n${title}\n${'═'.repeat(78)}`);
  // 一个回合都没走到的席位(开局就死/记录太短)只会添乱
  const rows = [...m.values()].filter(r => r.turns > 0).sort((a, b) => b.turns - a.turns);
  if (!rows.length) { console.log('(没有可用的记录)'); return; }

  /*
   * 先按控制方式合成一行再列武将。
   * 十几局会摸到二十来个武将,分武将那几行每行只有一两个样本,`3/4 (75%)` 是纯噪声;
   * 而"改了 effort 打法变没变"问的本来就是整体倾向。想看单个武将得用 --generals
   * 把它钉住再跑够局数。
   */
  const pooled = [...pool(m).values()].filter(r => r.turns > 0);
  console.log(
    '席位'.padEnd(14) + '回合'.padStart(5) +
    '  手牌 起→末'.padStart(14) + '  还有牌却收手'.padStart(16) +
    '  技能端上就用'.padStart(18) + '  削弱排在进攻前'.padStart(18));
  for (const r of pooled) {
    console.log('\x1b[1m' +
      `${r.control}/合计`.padEnd(14) + String(r.turns).padStart(5) +
      `  ${avg(r.handStart).toFixed(1)} → ${avg(r.handEnd).toFixed(1)}`.padStart(14) +
      `  ${ratio(r.endedEarly, r.couldAct)}`.padStart(16) +
      `  ${ratio(r.skillTaken, r.skillOffered)}`.padStart(18) +
      `  ${ratio(r.weakenFirst, r.bothKinds)}`.padStart(18) + '\x1b[0m');
  }
  console.log('─'.repeat(78));

  console.log(
    '席位'.padEnd(14) + '回合'.padStart(5) +
    '  手牌 起→末'.padStart(14) + '  还有牌却收手'.padStart(16) +
    '  技能端上就用'.padStart(18) + '  削弱排在进攻前'.padStart(18));
  for (const r of rows) {
    const who = `${r.control}/${r.general}`;
    console.log(
      who.padEnd(14) + String(r.turns).padStart(5) +
      `  ${avg(r.handStart).toFixed(1)} → ${avg(r.handEnd).toFixed(1)}`.padStart(14) +
      `  ${ratio(r.endedEarly, r.couldAct)}`.padStart(16) +
      `  ${ratio(r.skillTaken, r.skillOffered)}`.padStart(18) +
      `  ${ratio(r.weakenFirst, r.bothKinds)}`.padStart(18));
  }

  /*
   * 配合单开一块。塞进上面那张表会超过 78 列,而且这两个指标的读法完全不同 ——
   * 上面几列越低越好/越高越好各说各的,这两列都是"越高越像一个队伍"。
   */
  const coop = [...pooled, ...rows].filter(r => r.coAttacks > 0 || r.hostileUses > 0);
  if (coop.length) {
    console.log('\n配合:');
    console.log('  ' + '席位'.padEnd(14) + '集火'.padStart(16) +
      '瞎打基线'.padStart(10) + '净值'.padStart(9) + '  误伤队友'.padStart(14));
    for (const r of coop) {
      const who = pooled.includes(r) ? `${r.control}/合计` : `${r.control}/${r.general}`;
      const bold = pooled.includes(r);
      const base = r.coAttacks ? r.coExpected / r.coAttacks : 0;
      const obs = r.coAttacks ? r.coFocus / r.coAttacks : 0;
      const net = (obs - base) * 100;
      console.log('  ' + (bold ? '\x1b[1m' : '') + who.padEnd(14) +
        ratio(r.coFocus, r.coAttacks).padStart(16) +
        (r.coAttacks ? `${(base * 100).toFixed(0)}%` : '—').padStart(10) +
        (r.coAttacks ? `${net >= 0 ? '+' : ''}${net.toFixed(0)}pt` : '—').padStart(9) +
        `  ${ratio(r.friendlyFire, r.hostileUses)}`.padStart(14) + (bold ? '\x1b[0m' : ''));
    }
    console.log('  「瞎打基线」= 按每次出手当时的存活敌人数折算的期望重合率。');
    console.log('  2v2 只有两个敌人,瞎打就有 50%;敌人死剩一个时必然 100%。**只看净值**。');
  }
  const bad = [...m.values()].reduce((s, r) => s + r.unparsedUses, 0);
  if (bad) {
    console.log(`\n\x1b[33m⚠ 有 ${bad} 行战报看着像出牌却没解析出来 —— ` +
      `战报措辞可能改了,上面"配合"那一块的数字不可信\x1b[0m`);
  }

  const llm = rows.filter(r => r.llmCalls > 0);
  if (llm.length) {
    console.log('\nLLM 成本:');
    for (const r of llm) {
      console.log(`  ${(r.control + '/' + r.general).padEnd(14)} ` +
        `决策 ${String(r.llmCalls).padStart(4)}  ` +
        `按计划执行 ${ratio(r.fromPlan, r.llmCalls)}  ` +
        `兜底 ${ratio(r.fallbacks, r.llmCalls)}  ` +
        `请求 ${String(r.apiCalls).padStart(4)} 次 均 ${(r.apiMs / Math.max(1, r.apiCalls) / 1000).toFixed(1)}s  ` +
        `推理 ${r.reasoningTokens} tokens`);
    }
  }
}

/**
 * 现跑一批规则 AI 对局当基准。
 *
 * 走的是**和真实对局完全一样的那条路** —— Recorder 写 jsonl,再用同一个解析器读回来。
 * 不另写一份内存版,免得基准和实测量的是两套东西。
 */
async function simBaseline(n: number, players: number) {
  const [{ createGame }, { BasicAI }, { Recorder }] = await Promise.all([
    import('../core/setup.js'), import('../ai/basicAI.js'), import('../log/recorder.js'),
  ]);
  await import('../content/cards.js');
  await import('../content/generals.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-metrics-'));
  process.stdout.write(`现跑 ${n} 局 ${players} 人规则 AI 对局`);
  for (let i = 0; i < n; i++) {
    const rec = new Recorder({ dir, name: `base-${i}`, text: false });
    const game = createGame({
      playerCount: players, seed: 20000 + i,
      log: rec.logFn(), makeAgent: (_p, j) => rec.wrap(new BasicAI(`ai${j}`)),
    });
    rec.bind(game);
    rec.start({ seats: game.players.map(() => ({ control: 'rule' })), playerCount: players });
    await game.setupAndRun();
    rec.close?.();
    if ((i + 1) % 10 === 0) process.stdout.write('.');
  }
  process.stdout.write('\n');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f));
  const m = collect(files);
  fs.rmSync(dir, { recursive: true, force: true });
  return m;
}

async function main() {
  const argv = process.argv.slice(2);
  const simAt = argv.indexOf('--sim');
  if (simAt >= 0) {
    const n = Number(argv[simAt + 1]) || 40;
    const players = Number(argv[simAt + 2]) || 4;
    show(`规则 AI 基准(${n} 局 ${players} 人局)`, await simBaseline(n, players));
    return;
  }
  /*
   * `--pools A B` —— 在**同一批记录里**比两组席位。
   *
   * 明牌实验就是这个形状:治疗组和对照组在同一局里对打(control 分别记成
   * llm+open 和 llm),所以不需要跑两次、也不需要 --vs。这种同局内对照
   * 天生就是配对的 —— 同一副牌、同一批武将、同样的运气都被消掉了。
   */
  const pt = argv.indexOf('--pools');
  if (pt >= 0) {
    const [ka, kb] = [argv[pt + 1], argv[pt + 2]];
    const files = expand(argv.slice(0, pt));
    if (!ka || !kb) { console.error('用法:--pools <组A> <组B>,例如 --pools llm+open llm'); process.exit(1); }
    if (!files.length) { console.error('没有找到任何 .jsonl 记录'); process.exit(1); }
    console.log(`读取 ${files.length} 份记录`);
    const m = collect(files);
    show('行为指标', m);
    compare(ka, m, kb, m, ka, kb);
    showInfoUse(files, ka, kb);
    return;
  }

  const at = argv.indexOf('--vs');
  const a = at < 0 ? argv : argv.slice(0, at);
  const b = at < 0 ? [] : argv.slice(at + 1);

  const fa = expand(a);
  if (!fa.length) { console.error('没有找到任何 .jsonl 记录'); process.exit(1); }
  console.log(`读取 ${fa.length} 份记录` + (b.length ? '(第一组)' : ''));
  const ma = collect(fa);

  if (!b.length) { show('行为指标', ma); return; }

  const fb = expand(b);
  console.log(`读取 ${fb.length} 份记录(第二组)`);
  const mb = collect(fb);
  const nameA = a[0] ? path.basename(a[0].replace(/[\/\\]$/, '')) : '第一组';
  const nameB = b[0] ? path.basename(b[0].replace(/[\/\\]$/, '')) : '第二组';
  show(`第一组 ${nameA}`, ma);
  show(`第二组 ${nameB}`, mb);
  compare(nameA, ma, nameB, mb);
}

main();
