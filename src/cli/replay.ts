/**
 * 重放一份对局记录,并和当初的战报逐行比对。
 *
 *   npm run replay                        重放最新的一份
 *   npm run replay -- logs/xxx.jsonl      指定文件
 *   npm run replay -- --verbose           把重放的战报也打出来
 *   npm run replay -- --diff              分叉点前后各 10 行对照
 *
 * 典型用法:发现 bug → 改引擎 → 重放同一份记录 → 看战报从哪一行开始不一样。
 * 那一行就是这次改动的实际影响点;和预期一致就说明修对了。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { replay } from '../log/replay.js';
import { listLogs, resolveLogPath } from './logview.js';

const C = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

function flag(name: string) {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

async function main() {
  const given = process.argv.slice(2).find(a => !a.startsWith('--'));
  const file = given ? resolveLogPath(given) : listLogs()[0];
  if (!file) {
    console.error(given ? `找不到 ${given}` : '还没有记录。先跑一局:npm run duel -- --record');
    process.exitCode = 1;
    return;
  }

  const verbose = flag('verbose') !== undefined;
  console.log(C.bold(`重放 ${path.basename(file)}`));

  const t0 = Date.now();
  const r = await replay(file, verbose ? { log: m => console.log(C.dim('  ' + m)) } : {});
  const dt = Date.now() - t0;

  console.log(`\n用掉记录里 ${r.script.consumed}/${r.script.total} 次决策,` +
    `重放战报 ${r.newLines.length} 行(原 ${r.log.logLines.length} 行),耗时 ${dt}ms`);
  if (r.error) console.log(C.red(`重放中抛错:${r.error}`));

  if (r.script.divergences.length) {
    console.log(C.yellow(`\n脚本对不上 ${r.script.divergences.length} 处(这些决策退回了规则 AI):`));
    for (const d of r.script.divergences) console.log('  ' + d);
  }

  if (!r.firstDiff) {
    console.log(C.green('\n✓ 完全一致 —— 这一局在当前代码下能原样复现'));
  } else {
    const { line, was, now } = r.firstDiff;
    console.log(C.red(`\n✗ 第 ${line} 行开始不同(前 ${r.matched} 行一致)`));
    const lo = Math.max(0, line - 10);
    if (flag('diff') !== undefined) {
      console.log(C.dim('\n  —— 共同前缀 ——'));
      for (let i = lo; i < line; i++) console.log(C.dim(`  ${i}: ${r.log.logLines[i]}`));
      console.log(C.dim('\n  —— 原记录 ——'));
      for (let i = line; i < Math.min(r.log.logLines.length, line + 10); i++) {
        console.log(C.red(`  ${i}: ${r.log.logLines[i]}`));
      }
      console.log(C.dim('\n  —— 现在 ——'));
      for (let i = line; i < Math.min(r.newLines.length, line + 10); i++) {
        console.log(C.green(`  ${i}: ${r.newLines[i]}`));
      }
    } else {
      console.log(`  ${C.dim('原:')} ${C.red(was)}`);
      console.log(`  ${C.dim('现:')} ${C.green(now)}`);
      console.log(C.dim('\n  看上下文:加 --diff'));
    }
  }

  const oldEnd = r.log.end?.reason;
  const newEnd = r.game.winners.length
    ? `${r.game.winners.map(p => p.name).join('、')} 获胜` : '未分出胜负';
  if (oldEnd) console.log(C.dim(`\n结局:原「${oldEnd}」 现「${newEnd}」`));
}

if (process.argv[1]?.endsWith('replay.ts') || process.argv[1]?.endsWith('replay.js')) {
  main().catch(e => { console.error(e); process.exit(1); });
}
