/**
 * 人机对战入口。
 *
 *   npm run play                          5 人局,你坐 0 号位
 *   npm run play 8 3                      8 人局,你坐 3 号位
 *   npm run play -- 5 -1                  观战模式(全 AI)
 *   npm run play -- --pick                开局前交互式点将
 *   npm run play -- --generals=关羽,,吕布   直接指定(留空位表示随机)
 *   npm run play -- --seed=42             固定牌局,便于复现
 *   npm run play -- --record              把整局记到 logs/,可用 npm run replay 重放
 */

import { loadEnv } from './env.js';
loadEnv();

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { HumanAgent, closeCli, askLine } from './humanAgent.js';
import { pickGenerals } from './generals.js';
import { ROLE_NAME } from '../core/types.js';
import { Recorder } from '../log/recorder.js';

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

async function main() {
  const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const n = Number(flag('players') ?? positional[0] ?? 5);
  const seat = Number(flag('seat') ?? positional[1] ?? 0);
  const seed = Number(flag('seed') ?? positional[2] ?? Math.floor(Math.random() * 1e9));

  // 座位号超出范围表示观战模式(全 AI),方便看引擎跑起来是什么样
  const watch = seat < 0 || seat >= n;

  let fixedGenerals: Record<number, string> | undefined;
  try {
    fixedGenerals = parseGeneralSpec(flag('generals'), n);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (flag('pick') !== undefined) {
    const seats = Array.from({ length: n }, (_, i) => ({
      seat: i,
      label: i === seat ? `${i}号位(你)` : `${i}号位`,
    }));
    const picked = await pickGenerals(seats, askLine);
    fixedGenerals = { ...fixedGenerals, ...picked };
  }

  console.log(`\n三国杀 · 标准版  |  ${n} 人身份局  |  ` +
    `${watch ? '观战模式(全 AI)' : `你是 ${seat} 号位`}  |  seed=${seed}\n`);

  const rec = flag('record') !== undefined ? new Recorder() : null;

  const game = createGame({
    playerCount: n,
    seed,
    fixedGenerals,
    log: rec ? rec.logFn(m => console.log(m)) : (m) => console.log(m),
    makeAgent: (p, i) => {
      const a = !watch && i === seat ? new HumanAgent('you') : new BasicAI(`ai${i}`);
      return rec ? rec.wrap(a) : a;
    },
  });

  if (rec) {
    rec.bind(game);
    rec.start({ seed, playerCount: n, seat: watch ? -1 : seat, fixedGenerals: fixedGenerals ?? null });
    console.log(`\x1b[90m记录中 → ${rec.file}\x1b[0m`);
  }

  const me = watch ? null : game.players[seat];
  if (me) {
    console.log(`你的武将:${me.general.name}(${me.maxHp}血) 身份:${ROLE_NAME[me.role]}`);
    console.log(me.general.skills.filter(s => s.desc).map(s => `  【${s.name}】${s.desc}`).join('\n'));
  }

  const res = await game.setupAndRun();
  rec?.finish({
    reason: res.reason, winners: res.winners.map(p => p.seat),
    turns: game.turnCount, rounds: game.round,
  });
  rec?.close();
  console.log('\n最终局面:');
  console.log(game.board(true));
  if (me) console.log(`\n你${res.winners.includes(me) ? '赢了 🎉' : '输了'}`);
  closeCli();
}

main().catch(e => { console.error(e); closeCli(); process.exit(1); });
