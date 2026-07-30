/**
 * 加入一局由 MCP server 主持的对局 —— 你在自己的终端里打,Claude Code 在它那边打。
 *
 *   npm run join                 连默认端口 7311
 *   npm run join -- --port=7312  指定端口(开局时 Claude 那边会告诉你)
 *
 * 你只会看到自己该看到的:自己的手牌、所有人的公开状态、记牌器、公开战报。
 * 对手的手牌和未明示的身份不会发过来。
 */

import { loadEnv } from './env.js';
loadEnv();

import net from 'node:net';
import { askLine, closeCli } from './humanAgent.js';

const DEFAULT_PORT = Number(process.env.SGS_PORT ?? 7311);

function flag(name: string): string | undefined {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.split('=').slice(1).join('=') : '';
}

const port = Number(flag('port') ?? DEFAULT_PORT);
const host = flag('host') ?? '127.0.0.1';

const sock = net.createConnection({ port, host }, () => {
  console.log(`已连接到牌桌 ${host}:${port},等待发牌…\n`);
});

sock.setEncoding('utf8');

sock.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'ECONNREFUSED') {
    console.error(`连不上 ${host}:${port}。`);
    console.error('先在 Claude Code 里开局(new_game 时带上 humanSeat),它会告诉你端口。');
  } else {
    console.error('连接出错:', e.message);
  }
  process.exit(1);
});

sock.on('close', () => {
  console.log('\n牌桌已关闭。');
  closeCli();
  process.exit(0);
});

let buf = '';
let busy = false;

sock.on('data', (chunk: string | Buffer) => {
  buf += String(chunk);
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* 忽略坏行 */ }
  }
});

const queue: any[] = [];

function handle(m: any) {
  switch (m.type) {
    case 'hello':
      if (m.history?.length) console.log(m.history.join('\n'));
      break;
    case 'log':
      // 轮到自己作答时先别刷屏,等答完再补
      if (busy) queue.push(m); else console.log(m.line);
      break;
    case 'error':
      console.log(`  ⚠ ${m.text}`);
      break;
    case 'ask':
      void answer(m);
      break;
    case 'over':
      console.log('\n' + '═'.repeat(60));
      console.log(m.text);
      console.log('═'.repeat(60));
      break;
  }
}

async function answer(m: any) {
  busy = true;
  const need = m.min === m.max ? `需选 ${m.min} 个` : m.min === 0
    ? '可不选,直接回车放弃'
    : `需选 ${m.min}~${m.max} 个`;

  // 0 号永远是「查看局势」,真正的选项从 1 开始 —— 和单机模式保持一致
  const render = () => {
    console.log('\n' + '═'.repeat(60));
    console.log(`※ ${m.question}`);
    console.log('   0. 查看局势');
    m.options.forEach((o: string, i: number) => console.log(`   ${i + 1}. ${o}`));
    console.log(`   (${need})`);
  };
  render();

  for (;;) {
    const raw = await askLine('> ');
    if (!raw) {
      if (m.min === 0) { sock.write(JSON.stringify({ type: 'answer', id: m.id, choice: [] }) + '\n'); break; }
      console.log(`   至少要选 ${m.min} 个`);
      continue;
    }
    const nums = [...new Set(raw.split(/[\s,，]+/).filter(Boolean).map(Number))];
    if (nums.some(n => !Number.isInteger(n) || n < 0 || n > m.options.length)) {
      console.log(`   请输入 0~${m.options.length} 之间的编号`);
      continue;
    }
    if (nums.includes(0)) {          // 查看局势:不消耗选择
      console.log('─'.repeat(60));
      console.log(m.view);
      render();
      continue;
    }
    if (nums.length < m.min || nums.length > m.max) { console.log(`   ${need}`); continue; }
    sock.write(JSON.stringify({ type: 'answer', id: m.id, choice: nums.map(n => n - 1) }) + '\n');
    break;
  }

  busy = false;
  while (queue.length) console.log(queue.shift().line);
}
