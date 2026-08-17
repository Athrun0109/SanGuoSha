/**
 * 图形界面 —— 起一个本地网页,实时渲染牌局并接受鼠标操作。
 *
 * 默认是观战;加 `--play` 就由你亲自打视角那个座位,手牌、角色框、技能直接点。
 * 出牌那套逻辑和 `npm start` 的设置页共用一份(WebAgent + /api/decide)。
 *
 *   npm run ui                      3 人局,以 0 号位的视角观战
 *   npm run ui -- --play            你来打 0 号位
 *   npm run ui -- --play --seat=1   你来打 1 号位
 *   npm run ui -- --players=2       1v1
 *   npm run ui -- --seat=1          只换视角(决定谁在屏幕底部),仍是观战
 *   npm run ui -- --spectate        纯观战,没有"自己"(所有人手牌都盖着)
 *   npm run ui -- --reveal          开图:所有人手牌可见
 *   npm run ui -- --speed=300       每次决策前停多少毫秒(0 = 不停)
 *   npm run ui -- --seed=42         固定牌局
 *   npm run ui -- --generals=关羽,,吕布
 *   npm run ui -- --record          顺便记一份对局日志
 *   npm run ui -- --port=8080 --no-open
 */

import '../content/cards.js';
import '../content/generals.js';
import { createGame, parseGeneralSpec } from '../core/setup.js';
import { BasicAI } from '../ai/basicAI.js';
import { snapshot } from '../web/state.js';
import { paced } from '../web/paced.js';
import { openBrowser, startViewer } from '../web/server.js';
import { sessionApi } from '../web/setup.js';
import { GameAborted, WebAgent } from '../web/webAgent.js';
import { Recorder } from '../log/recorder.js';
import { ROLE_NAME } from '../core/types.js';
import type { Agent } from '../core/agent.js';
import type { Game } from '../core/game.js';

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const players = Number(flag('players') ?? 3);
  const spectate = flag('spectate') !== undefined;
  const seat = spectate ? null : Number(flag('seat') ?? 0);
  const play = flag('play') !== undefined;
  const reveal = flag('reveal') !== undefined;
  const speed = Number(flag('speed') ?? 500);
  const seed = Number(flag('seed') ?? Math.floor(Math.random() * 1e9));

  if (!(players >= 2 && players <= 8)) {
    console.error('人数只能是 2~8');
    process.exitCode = 1;
    return;
  }
  if (play && seat === null) {
    console.error('--play 和 --spectate 冲突:没有"自己"就没法出牌');
    process.exitCode = 1;
    return;
  }
  if (seat !== null && !(seat >= 0 && seat < players)) {
    console.error(`视角座位要在 0~${players - 1} 之间`);
    process.exitCode = 1;
    return;
  }

  let fixedGenerals: Record<number, string> | undefined;
  try {
    fixedGenerals = parseGeneralSpec(flag('generals'), players);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
    return;
  }

  let web: WebAgent | null = null;
  let generation = 0;          // 重开一次 +1;旧的那局认出自己过期了就安静收场
  const view = await startViewer({
    port: Number(flag('port') ?? 5173),
    api: sessionApi({
      onDecide: play
        ? (choice: number[]) => web ? web.submit(choice) : '这一局没有网页座位'
        : undefined,
      // 这个入口没有设置页可回,所以重开 = 换个 seed 直接再来一局,页面不用跳转
      onReset: () => {
        generation++;
        web?.abort();
        startGame(Math.floor(Math.random() * 1e9));
      },
      onQuit: async () => {
        console.log('\n收到网页的结束指令,退出。');
        // 先把手上的事收干净再退:挂起的决策兑现掉、SSE 连接和监听端口关掉。
        // 直接在 HTTP 回调里 process.exit(),Windows 上会撞 libuv 的
        // "handle is closing" 断言 —— 进程是退了,但退出码和收尾都不干净。
        web?.abort();
        await view.close().catch(() => {});
        setTimeout(() => process.exit(0), 0);
      },
    }),
  });
  console.log(`\n观战地址  ${view.url}`);
  if (flag('no-open') === undefined) openBrowser(view.url);

  const rec = flag('record') !== undefined ? new Recorder() : null;

  console.log('等待浏览器连上来…(打开上面的地址即可开局)');
  await view.waitForClient();

  /** 跑一局。重开就是换个 seed 再叫一次 */
  function startGame(useSeed = seed) {
    const mine = generation;
    // game 要在 push 之后才存在,所以先声明再赋值,免得 log 回调撞上 TDZ
    let game: Game;
    const push = (reason = '') => {
      // 已经被重开挤掉的那局别再往界面上推,否则两局的快照会交替闪
      if (!game || mine !== generation) return;
      // web 一个座位一个实例,只坐在视角座位上,所以这里的 pending 天然就是视角自己的
      view.push(snapshot(game, { viewer: seat, reveal, reason, pending: web?.pending ?? null }));
    };
    const recLog = rec?.logFn();

    game = createGame({
      playerCount: players,
      seed: useSeed,
      fixedGenerals,
      // 每写一行战报就推一次,画面跟着日志走
      log: (m) => { recLog?.(m); push(); },
      makeAgent: (p, i): Agent => {
        let base: Agent;
        if (play && i === seat) {
          web = new WebAgent('you', () => push());
          base = web;
        } else {
          base = new BasicAI(`ai${i}`);
        }
        const withRec = rec ? rec.wrap(base) : base;
        // 你自己那个座位不用 sleep —— 它本来就在等你点
        const delay = play && i === seat ? 0 : speed;
        return paced(withRec, {
          async before() {
            if (delay > 0) await sleep(delay);
            push();
          },
        });
      },
    });

    if (rec) {
      rec.bind(game);
      rec.start({ seed: useSeed, playerCount: players, seat, play, source: 'ui' });
    }

    console.log(`\n${players} 人局  seed=${useSeed}  ` +
      (seat === null ? '纯观战' : play ? `你打 ${seat}号` : `视角 ${seat}号`) +
      (reveal ? '  开图' : ''));
    if (play) console.log('轮到你时,网页上能点的东西会描蓝边。');
    for (const p of game.players) {
      console.log(`  [${p.seat}] ${p.general.name} ${p.maxHp}血 ${ROLE_NAME[p.role]}`);
    }
    push();

    game.setupAndRun().then(res => {
      if (mine !== generation) return;      // 已经被重开挤掉了
      rec?.finish({
        reason: res.reason, winners: res.winners.map(p => p.seat), turns: game.turnCount,
      });
      push(res.reason);
      console.log(`\n${res.reason}(${game.turnCount} 回合)`);
      if (rec) console.log(`记录 → ${rec.file}`);
      console.log('页面还开着。右上角「退出」或结束浮层里可以「再来一局」/「结束游戏」。');
    }).catch(e => {
      // 重开导致的中止是正常收场,别当崩溃处理
      if (e instanceof GameAborted || mine !== generation) return;
      console.error(e);
      process.exit(1);
    });
  }

  startGame();
}

main().catch(e => { console.error(e); process.exit(1); });
