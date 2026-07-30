/**
 * 批量自动对战:npm run sim [局数] [人数] [--verbose] [--handicap=N]
 *
 * --handicap=N 让 0 号位以外的每人多摸 N 张起始牌,用来扫先手优势的补偿力度。
 *
 * 这是验证平衡性改动的主要工具 —— 改完某个技能后跑几百局,
 * 看该武将的登场胜率变化,比拍脑袋准得多。
 */

import '../content/cards.js';
import '../content/generals.js';
import { createGame } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { ROLE_NAME, Role } from '../core/types.js';

interface Stat { games: number; wins: number; }

async function main() {
  const games = Number(process.argv[2] ?? 100);
  const n = Number(process.argv[3] ?? 5);
  const verbose = process.argv.includes('--verbose');
  const hcArg = process.argv.find(a => a.startsWith('--handicap='));
  const handicap = hcArg ? Number(hcArg.split('=')[1]) : undefined;
  const startingHand = handicap === undefined ? undefined
    : Array.from({ length: n }, (_, i) => (i === 0 ? 4 : 4 + handicap));

  const byGeneral = new Map<string, Stat>();
  const byRole = new Map<Role, Stat>();
  let turns = 0, errors = 0;
  const t0 = Date.now();

  for (let i = 0; i < games; i++) {
    try {
      const game = createGame({
        playerCount: n,
        seed: 1000 + i,
        startingHand,
        verbose,
        log: verbose ? (m) => console.log(m) : undefined,
        makeAgent: (p, idx) => new BasicAI(`ai${idx}`),
      });
      const res = await game.setupAndRun();
      turns += game.turnCount;
      for (const p of game.players) {
        const g = byGeneral.get(p.general.name) ?? { games: 0, wins: 0 };
        g.games++; if (res.winners.includes(p)) g.wins++;
        byGeneral.set(p.general.name, g);
        const r = byRole.get(p.role) ?? { games: 0, wins: 0 };
        r.games++; if (res.winners.includes(p)) r.wins++;
        byRole.set(p.role, r);
      }
    } catch (e) {
      errors++;
      if (errors <= 3) console.error(`第 ${i} 局出错:`, e);
    }
    if ((i + 1) % 50 === 0) process.stdout.write(`  ...${i + 1}/${games}\n`);
  }

  const ok = games - errors;
  console.log(`\n跑完 ${ok}/${games} 局(${n}人局),平均 ${(turns / Math.max(1, ok)).toFixed(1)} 回合,` +
    `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s,异常 ${errors} 局`);

  console.log('\n按身份:');
  for (const [role, s] of [...byRole.entries()].sort()) {
    console.log(`  ${ROLE_NAME[role].padEnd(4)} 登场 ${String(s.games).padStart(4)}  胜率 ${(100 * s.wins / s.games).toFixed(1)}%`);
  }

  console.log('\n按武将(登场胜率,样本少时仅供参考):');
  const rows = [...byGeneral.entries()]
    .map(([name, s]) => ({ name, games: s.games, rate: s.wins / s.games }))
    .sort((a, b) => b.rate - a.rate);
  for (const r of rows) {
    const bar = '█'.repeat(Math.round(r.rate * 30));
    console.log(`  ${r.name.padEnd(4)} ${String(r.games).padStart(4)}局  ${(r.rate * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
