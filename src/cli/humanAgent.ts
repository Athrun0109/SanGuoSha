import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type {
  Agent, CardOption, ChooseCardsOpts, ChoosePlayersOpts, OptionCtx, PlayAction, ResponseCtx,
} from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { Card, SUITS, Suit, cardLabel, KINGDOM_NAME, ROLE_NAME } from '../core/types.js';
import { countCards, formatCounter } from '../ai/cardCounter.js';

// 懒创建:只有真的需要人类输入时才占用 stdin
let rl: readline.Interface | null = null;
/**
 * 自己维护行队列,不用 rl.question()。
 *
 * 因为 readline 会**丢弃"当前没人在等"时到达的行** —— 交互输入看不出来
 * (人一次只敲一行),但管道输入会连丢好几行,导致脚本化运行直接卡死。
 * 自己缓冲之后,`printf '1\n2\n' | npm start` 这种用法才成立,测试也才好写。
 */
const lineQueue: string[] = [];
const waiters: Array<(s: string) => void> = [];
let closed = false;

function cli() {
  if (!rl) {
    rl = readline.createInterface({ input, output });
    rl.on('line', (l) => {
      const w = waiters.shift();
      if (w) w(l); else lineQueue.push(l);
    });
    rl.on('close', () => {
      closed = true;
      while (waiters.length) waiters.shift()!('');
    });
  }
  return rl;
}

export function closeCli() {
  rl?.close();
  rl = null;
  lineQueue.length = 0;
  waiters.length = 0;
  closed = false;
}

/** 输入流是否已经结束(Ctrl+D 或管道喂完了) */
export function isInputClosed() { return closed && lineQueue.length === 0; }

async function ask(q: string): Promise<string> {
  if (isInputClosed()) return '';        // 关掉之后再碰 readline 会抛 ERR_USE_AFTER_CLOSE
  const i = cli();
  try { i.setPrompt(q); i.prompt(); } catch { return ''; }
  if (lineQueue.length) {
    const l = lineQueue.shift()!;
    if (!(input as any).isTTY) output.write(l + '\n');   // 管道输入时回显内容,便于看录像
    return l.trim();
  }
  if (closed) return '';
  return new Promise<string>(r => waiters.push(l => r(l.trim())));
}

/** 供点将等开局前的交互复用,和对局中用的是同一个 readline */
export const askLine = ask;

/** 隐藏回显地读一行(输 API key 用) */
export async function askSecret(q: string): Promise<string> {
  const i = cli() as any;
  const orig = i._writeToOutput;
  if (typeof orig !== 'function' || !(input as any).isTTY) return ask(q); // 非交互就别玩打码
  let armed = false;
  i._writeToOutput = function (s: string) {
    if (!armed) { orig.call(i, s); return; }        // 提示语照常显示
    orig.call(i, s.includes('\n') ? '\n' : '*');    // 输入内容打码
  };
  try {
    const p = ask(q);
    armed = true;
    return await p;
  } finally {
    armed = false;
    i._writeToOutput = orig;
  }
}

function bar(hp: number, maxHp: number) {
  return '♥'.repeat(Math.max(0, hp)) + '♡'.repeat(Math.max(0, maxHp - hp));
}

/** 场上局势:每个座位的武将、势力、身份、体力、手牌数、装备、判定区、距离 */
export function formatBoard(game: Game, self: Player): string {
  const lines = [
    '─'.repeat(66),
    ' 座位  武将    势力 身份  体力        手牌  装备 / 判定区',
  ];
  for (const p of game.players) {
    const role = p.revealed || p === self ? ROLE_NAME[p.role] : '??';
    const eq = p.equipCards.map(c => c.name).join(',') || '-';
    const jd = p.judgeZone.map(c => game.judgeName(p, c)).join(',');
    const mark = p === self ? '→' : (p === game.current ? '◆' : ' ');
    const state = p.alive
      ? `${bar(p.hp, p.maxHp).padEnd(12, ' ')}${String(p.handCount).padEnd(5)}`
      : '【阵亡】'.padEnd(13, ' ');
    const dist = p === self || !p.alive ? '' : `   距你${game.distance(self, p)}`;
    lines.push(`${mark}[${p.seat}]  ${p.general.name.padEnd(4, '　')}${KINGDOM_NAME[p.kingdom]}   ` +
      `${role.padEnd(4, '　')}${state}${eq}${jd ? ` / 判定:${jd}` : ''}${dist}`);
  }
  lines.push(`你的攻击范围 ${game.attackRange(self)}   手牌上限 ${game.maxHand(self)}   牌堆剩余 ${game.deck.length}`);
  return lines.join('\n');
}

export interface HumanAgentIO {
  /** 读一行,默认走 stdin */
  ask?: (q: string) => Promise<string>;
  /** 输出一行,默认 console.log */
  print?: (s: string) => void;
}

export class HumanAgent implements Agent {
  readonly id: string;
  readonly human = true;
  private ask: (q: string) => Promise<string>;
  private print: (s: string) => void;
  private warnedEOF = false;

  constructor(id: string, io: HumanAgentIO = {}) {
    this.id = id;
    this.ask = io.ask ?? ask;
    this.print = io.print ?? ((s: string) => console.log(s));
  }

  private showDetail(game: Game, self: Player) {
    this.print(formatBoard(game, self));
    this.print(`你的手牌(${self.handCount}):` +
      (self.hand.length ? self.hand.map(c => `\n   ${cardLabel(c)}`).join('') : ' (空)'));
    const skills = self.allSkills.filter(s => s.desc).map(s => `【${s.name}】${s.desc}`);
    if (skills.length) this.print('你的技能:' + skills.map(s => '\n   ' + s).join(''));
    this.print(formatCounter(countCards(game, self), game, self));
    this.print('─'.repeat(66));
  }

  /**
   * 所有选择都走这里。**0 号永远是「查看局势」**,真正的选项从 1 开始编号 ——
   * 随时能看一眼场面再决定,不消耗任何东西、不推进牌局。返回选项在原数组里的下标。
   */
  private async choose(
    game: Game, self: Player, title: string, labels: string[], min: number, max: number,
  ): Promise<number[]> {
    const render = () => {
      this.print(`\n※ ${title}`);
      this.print('   0. 查看局势');
      labels.forEach((o, i) => this.print(`   ${i + 1}. ${o}`));
      this.print(min === max ? `   (需选 ${min} 个)`
        : min === 0 ? '   (可不选,直接回车放弃)'
          : `   (需选 ${min}~${max} 个)`);
    };
    render();

    for (;;) {
      // 输入流结束了(Ctrl+D / 管道喂完)。再问下去会死循环,
      // 所以打个招呼然后按最小合法选择继续,让这局能自己走完。
      if (isInputClosed()) {
        if (!this.warnedEOF) {
          this.warnedEOF = true;
          this.print('\n   (输入已结束,后续决策自动选择靠前的选项)');
        }
        return Array.from({ length: Math.min(min, labels.length) }, (_, i) => i);
      }
      const raw = await this.ask('> ');
      if (raw === '' || raw === '-' || raw.toLowerCase() === 'q') {
        if (min === 0) return [];
        this.print(`   至少要选 ${min} 个`);
        continue;
      }
      const nums = [...new Set(raw.split(/[\s,，]+/).filter(Boolean).map(Number))];
      if (nums.some(n => !Number.isInteger(n) || n < 0 || n > labels.length)) {
        this.print(`   请输入 0~${labels.length} 之间的编号`);
        continue;
      }
      if (nums.includes(0)) {          // 查看局势:看完重新问,不算一次选择
        this.showDetail(game, self);
        render();
        continue;
      }
      if (nums.length < min || nums.length > max) {
        this.print(`   需要选 ${min}~${max} 个,你给了 ${nums.length} 个`);
        continue;
      }
      return nums.map(n => n - 1);
    }
  }

  async choosePlayAction(game: Game, self: Player, actions: PlayAction[]): Promise<number> {
    this.showDetail(game, self);
    const r = await this.choose(game, self, '出牌阶段,选一个动作', actions.map(a => a.label), 1, 1);
    return r[0] ?? actions.length - 1;
  }

  async chooseResponse(
    game: Game, self: Player, options: CardOption[], prompt: string, forced: boolean,
    ctx?: ResponseCtx,
  ): Promise<number> {
    // 手上没有可用的牌时不打扰你 —— 一道只有一个答案的题不值得停下来问。
    // (引擎仍然发起了这次询问,所以旁观者看不出你有没有牌,见 game.askForUse)
    if (!options.length) return -1;
    const r = await this.choose(game, self, prompt, options.map(o => o.label), forced ? 1 : 0, 1);
    return r.length ? r[0] : -1;
  }

  async chooseCards(
    game: Game, self: Player, cards: Card[], min: number, max: number, prompt: string,
  ): Promise<Card[]> {
    const r = await this.choose(game, self, prompt, cards.map(cardLabel), min, max);
    return r.map(i => cards[i]);
  }

  async choosePlayers(
    game: Game, self: Player, cands: Player[], min: number, max: number, prompt: string,
    opts: ChoosePlayersOpts = {},
  ): Promise<Player[]> {
    const labels = cands.map(p =>
      `[${p.seat}] ${p.general.name} ${bar(p.hp, p.maxHp)} 手牌${p.handCount}` + (p === self ? '(你)' : ''));
    // 顺序有意义时要说清楚:输入的先后就是结果的先后
    const q = opts.ordered && max > 1 ? `${prompt}(按顺序输入,先写的排在前面)` : prompt;
    const r = await this.choose(game, self, q, labels, min, max);
    return r.map(i => cands[i]);
  }

  async chooseOption(
    game: Game, self: Player, options: string[], prompt: string, cancelable?: boolean,
    ctx?: OptionCtx,
  ): Promise<number> {
    const r = await this.choose(game, self, prompt, options, cancelable ? 0 : 1, 1);
    return r.length ? r[0] : (cancelable ? -1 : 0);
  }

  async chooseSuit(game: Game, self: Player, prompt: string): Promise<Suit> {
    const r = await this.choose(game, self, prompt, [...SUITS], 1, 1);
    return SUITS[r[0] ?? 0];
  }

  async arrangeCards(
    game: Game, self: Player, cards: Card[], prompt: string,
  ): Promise<{ top: Card[]; bottom: Card[] }> {
    const r = await this.choose(
      game, self,
      `${prompt}\n   (按输入顺序放到牌堆顶,先摸到的排前面;没选的沉底)`,
      cards.map(cardLabel), 0, cards.length,
    );
    const top = r.map(i => cards[i]);
    return { top, bottom: cards.filter(c => !top.includes(c)) };
  }
}
