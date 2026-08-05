/**
 * 看对局记录。不带参数就分析 logs/ 里最新的那份。
 *
 *   npm run log                      概览:开局、耗时、兜底、慢调用
 *   npm run log -- logs/xxx.jsonl    指定文件
 *   npm run log -- --fallbacks       只看兜底,连原始响应一起打出来
 *   npm run log -- --slow=10         最慢的 10 次模型调用(排查卡死用)
 *   npm run log -- --decisions       完整决策流水
 *   npm run log -- --seat=1          只看某个座位
 *   npm run log -- --turn=7          只看第 7 回合
 *   npm run log -- --grep=闪电        在战报里搜,带上下文
 *   npm run log -- --ls              列出所有记录
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadLog } from '../log/replay.js';

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

export function logDir() {
  return flag('dir') ?? path.join(process.cwd(), 'logs');
}

/** 按修改时间倒序列出所有记录 */
export function listLogs(dir = logDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/**
 * 把用户给的东西变成真实路径。
 * 光名字(`20260805-164504` 或带 .jsonl)也认 —— 提示里打印的就是名字,
 * 直接复制粘贴必须能用。
 */
export function resolveLogPath(given: string, dir = logDir()): string | null {
  const tries = [given, path.join(dir, given), path.join(dir, `${given}.jsonl`)];
  return tries.find(f => fs.existsSync(f) && fs.statSync(f).isFile()) ?? null;
}

/** 命令行里第一个不以 -- 开头的参数;没有就取最新一份 */
export function resolveTarget(argv = process.argv.slice(2)): string | null {
  const given = argv.find(a => !a.startsWith('--'));
  if (given) return resolveLogPath(given);
  return listLogs()[0] ?? null;
}

function ms(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

function pct(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function main() {
  if (flag('ls') !== undefined) {
    const all = listLogs();
    if (!all.length) { console.log(`${logDir()} 里还没有记录`); return; }
    for (const f of all) {
      const st = fs.statSync(f);
      console.log(`${path.basename(f)}  ${(st.size / 1024).toFixed(0)}KB  ${st.mtime.toLocaleString()}`);
    }
    return;
  }

  const given = process.argv.slice(2).find(a => !a.startsWith('--'));
  const file = resolveTarget();
  if (!file) {
    console.error(given ? `在 ${logDir()} 里找不到 ${given}`
      : `${logDir()} 里还没有记录。先跑一局:npm run duel -- --record`);
    process.exitCode = 1;
    return;
  }

  const log = loadLog(file);
  const seat = flag('seat') === undefined ? null : Number(flag('seat'));
  const turn = flag('turn') === undefined ? null : Number(flag('turn'));
  const llm = log.events.filter(e => e.type === 'llm');
  const answers = log.events.filter(e => e.type === 'answer');
  const asks = new Map(log.events.filter(e => e.type === 'ask').map(e => [e.i, e]));

  // ————————————————— 概览 —————————————————
  console.log(C.bold(`\n${path.basename(file)}`));
  const m = log.meta;
  const bits = ['seed', 'model', 'provider', 'effort', 'codec', 'playerCount', 'startingHand']
    .filter(k => m[k] !== undefined).map(k => `${k}=${JSON.stringify(m[k])}`);
  if (bits.length) console.log(C.dim('  ' + bits.join('  ')));
  for (const p of log.setup?.players ?? []) {
    // 同名技能可能拆成好几个对象实现(如裸衣 = 摸牌少摸 + 伤害+1),显示时合并
    const skills = [...new Set<string>(p.skills ?? [])];
    console.log(`  [${p.seat}] ${p.general} ${p.hp}/${p.maxHp} ${p.role}` +
      C.dim(`  技能:${skills.join('/')}  起手:${(p.hand ?? []).join(' ')}`));
  }
  if (log.end) {
    console.log(`  ${C.bold('结果')} ${log.end.reason ?? ''}  ` +
      C.dim(`${log.end.turns ?? '?'} 回合 / ${ms(log.end.t ?? 0)} / ${log.decisions.length} 次决策`));
  } else {
    console.log(C.red(`  没有结束事件 —— 这局是崩溃或被中断的(战报停在第 ${log.logLines.length} 行)`));
  }

  // ————————————————— 模型调用统计 —————————————————
  if (llm.length) {
    const byAgent = new Map<string, any[]>();
    for (const e of llm) {
      if (!byAgent.has(e.agentId)) byAgent.set(e.agentId, []);
      byAgent.get(e.agentId)!.push(e);
    }
    console.log(C.bold('\n模型调用'));
    for (const [id, list] of byAgent) {
      const lat = list.map(e => (e.attempts ?? []).reduce((s: number, a: any) => s + a.ms, 0))
        .sort((a, b) => a - b);
      const fb = list.filter(e => e.usedFallback).length;
      const retries = list.reduce((s, e) => s + Math.max(0, (e.attempts?.length ?? 1) - 1), 0);
      const tok = list.reduce((s, e) => s + (e.usage?.output_tokens ?? 0), 0);
      console.log(`  ${id}: ${list.length} 次  ` +
        `延迟 中位 ${ms(pct(lat, 0.5))} / p90 ${ms(pct(lat, 0.9))} / 最慢 ${ms(lat[lat.length - 1] ?? 0)}  ` +
        `重试 ${retries}  ` +
        (fb ? C.red(`兜底 ${fb}`) : C.green('兜底 0')) +
        C.dim(`  输出 ${tok} tokens`));
    }
  }

  // ————————————————— 兜底 —————————————————
  const fallbacks = llm.filter(e => e.usedFallback);
  if (fallbacks.length) {
    console.log(C.bold(`\n兜底 ${fallbacks.length} 次`));
    for (const e of fallbacks) {
      console.log(`  ${C.dim(`R${e.round}/T${e.turn}`)} [${e.agentId}] ${C.red(e.error ?? '未知')}`);
      console.log(C.dim(`      问题:${e.prompt}`));
      for (const a of e.attempts ?? []) {
        console.log(C.dim(`      第${a.n}次 ${ms(a.ms)} budget=${a.maxTokens}${a.error ? ' ← ' + a.error : ''}`));
      }
      if (flag('fallbacks') !== undefined && e.raw) {
        console.log(C.dim('      原始响应:') + String(e.raw).slice(0, 600));
      }
    }
  }

  // ————————————————— 最慢的调用 —————————————————
  const slowN = flag('slow') === undefined ? 0 : Number(flag('slow') || 5);
  if (slowN > 0) {
    const withMs = llm.map(e => ({
      e, total: (e.attempts ?? []).reduce((s: number, a: any) => s + a.ms, 0),
    })).sort((a, b) => b.total - a.total).slice(0, slowN);
    console.log(C.bold(`\n最慢的 ${withMs.length} 次调用`));
    for (const { e, total } of withMs) {
      console.log(`  ${ms(total).padStart(7)}  ${C.dim(`R${e.round}/T${e.turn}`)} [${e.agentId}] ` +
        `${e.prompt}${(e.attempts?.length ?? 1) > 1 ? C.dim(` (${e.attempts.length} 次尝试)`) : ''}`);
    }
  }

  // ————————————————— 决策流水 —————————————————
  if (flag('decisions') !== undefined) {
    console.log(C.bold('\n决策流水'));
    let n = 0;
    for (const ans of answers) {
      const ask = asks.get(ans.of);
      if (!ask) continue;
      if (seat !== null && ask.seat !== seat) continue;
      if (turn !== null && ask.turn !== turn) continue;
      const picked = (ans.choice ?? []).map((i: number) => ask.options[i] ?? `#${i}`);
      const think = llm.find(e => e.i > ask.i && e.i < ans.i && e.agentId === ask.agent);
      console.log(`\n  ${C.dim(`#${n++} R${ask.round}/T${ask.turn}/${ask.phase}`)} ` +
        `[${ask.seat}] ${C.bold(ask.prompt)} ${C.dim(`(${ask.kind}, ${ms(ans.ms ?? 0)})`)}`);
      ask.options.forEach((o: string, i: number) => {
        const on = (ans.choice ?? []).includes(i);
        console.log(on ? C.green(`     ▸ ${i}. ${o}`) : C.dim(`       ${i}. ${o}`));
      });
      if (!picked.length) console.log(C.dim('     ▸ (放弃)'));
      if (think?.thinking) console.log(C.cyan(`     ~ ${think.thinking}`));
      if (think?.usedFallback) console.log(C.red(`     ! 兜底 ← ${think.error}`));
    }
  }

  // ————————————————— 战报搜索 —————————————————
  const q = flag('grep');
  if (q) {
    const re = new RegExp(q, 'i');
    console.log(C.bold(`\n战报里搜 /${q}/`));
    log.logLines.forEach((line, i) => {
      if (!re.test(line)) return;
      for (let j = Math.max(0, i - 2); j <= Math.min(log.logLines.length - 1, i + 2); j++) {
        console.log(j === i ? C.green(`  ${j}: ${log.logLines[j]}`) : C.dim(`  ${j}: ${log.logLines[j]}`));
      }
      console.log(C.dim('  ---'));
    });
  }

  const tail = flag('tail');
  if (tail !== undefined) {
    const k = Number(tail || 40);
    console.log(C.bold(`\n战报末尾 ${k} 行`));
    for (const line of log.logLines.slice(-k)) console.log('  ' + line);
  }

  if (flag('decisions') === undefined && !q && tail === undefined && !slowN) {
    console.log(C.dim('\n看更多:--decisions 决策流水  --slow=5 慢调用  --fallbacks 兜底详情  ' +
      '--grep=关键词  --tail=40\n重放这一局:npm run replay -- ' + path.basename(file)));
  }
}

if (process.argv[1]?.endsWith('logview.ts') || process.argv[1]?.endsWith('logview.js')) main();
