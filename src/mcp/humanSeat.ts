/**
 * 人类座位 —— 让你和 Claude Code 同桌打。
 *
 * MCP server 进程里开一个本地 socket,你在另一个终端跑 `npm run join` 接进来。
 * 两边都只是这局游戏的客户端:引擎问到谁,谁才动;各自只看得到自己该看到的信息。
 *
 * 协议是按行分隔的 JSON:
 *   server → client  {type:'hello'}  {type:'log'}  {type:'ask'}  {type:'over'}
 *   client → server  {type:'answer', id, choice}
 */

import net from 'node:net';
import type { Agent } from '../core/agent.js';
import type { Game } from '../core/game.js';
import type { Player } from '../core/player.js';
import { BasicAI } from '../ai/basicAI.js';
import { ChoiceAgent, validateChoice } from '../ai/choiceAgent.js';
import type { CodecMode } from '../ai/codec.js';

export const DEFAULT_PORT = Number(process.env.SGS_PORT ?? 7311);

interface AskMsg {
  type: 'ask';
  id: number;
  view: string;
  question: string;
  options: string[];
  min: number;
  max: number;
}

export class SeatHub {
  private server: net.Server | null = null;
  private sock: net.Socket | null = null;
  private buf = '';
  private pending: { msg: AskMsg; resolve: (c: number[]) => void } | null = null;
  private history: string[] = [];
  private nextId = 1;
  port = 0;

  get connected() { return !!this.sock; }
  /** 人类那边是不是正卡在一个决策上(Claude 侧据此提示"等待对手") */
  get waiting() { return !!this.pending; }

  listen(port = DEFAULT_PORT): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(sock => this.attach(sock));
      srv.on('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        this.server = srv;
        this.port = (srv.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  private attach(sock: net.Socket) {
    // 只接受一个玩家;后来的连接顶掉前面的(方便断线重连)
    this.sock?.destroy();
    this.sock = sock;
    this.buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d: string | Buffer) => this.onData(String(d)));
    sock.on('close', () => { if (this.sock === sock) this.sock = null; });
    sock.on('error', () => { if (this.sock === sock) this.sock = null; });

    this.send({ type: 'hello', history: this.history.slice(-40) });
    // 断线重连时把还没答的问题重新推一遍
    if (this.pending) this.send(this.pending.msg);
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      try { this.onMessage(JSON.parse(line)); } catch { /* 忽略坏行 */ }
    }
  }

  private onMessage(m: any) {
    if (m?.type !== 'answer' || !this.pending) return;
    if (m.id !== this.pending.msg.id) return;
    const p = this.pending.msg;
    const choice = Array.isArray(m.choice) ? m.choice : [];
    const err = validateChoice(choice, p.options.length, p.min, p.max);
    if (err) { this.send({ type: 'error', text: err }); this.send(p); return; }
    const { resolve } = this.pending;
    this.pending = null;
    resolve(choice.map(Number));
  }

  private send(o: any) {
    if (!this.sock) return;
    try { this.sock.write(JSON.stringify(o) + '\n'); } catch { /* 断了就算了 */ }
  }

  /** 公开战报,人类那边实时看到 */
  log(line: string) {
    if (!line.trim()) return;
    this.history.push(line);
    this.send({ type: 'log', line });
  }

  ask(msg: Omit<AskMsg, 'type' | 'id'>): Promise<number[]> {
    return new Promise(resolve => {
      const full: AskMsg = { type: 'ask', id: this.nextId++, ...msg };
      this.pending = { msg: full, resolve };
      this.send(full);
    });
  }

  over(text: string) {
    this.send({ type: 'over', text });
  }

  close() {
    this.sock?.destroy();
    this.server?.close();
    this.sock = null;
    this.server = null;
  }
}

/** 坐在 hub 后面的那个"人" */
export class HumanSeat extends ChoiceAgent {
  readonly id = 'human';
  readonly human = true;
  protected fallback: Agent = new BasicAI('human-afk');
  protected codecMode: CodecMode = 'verbose';

  constructor(
    private hub: SeatHub,
    private renderView: (game: Game, self: Player) => string,
  ) { super(); }

  protected async decide(
    game: Game, self: Player, question: string, options: string[], min: number, max: number,
  ): Promise<number[] | null> {
    return this.hub.ask({ view: this.renderView(game, self), question, options, min, max });
  }
}
