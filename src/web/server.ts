/**
 * 观战服务端:node:http + SSE,零依赖。
 *
 * 为什么不是 WebSocket:Node 22 有 WebSocket **客户端**,但没有内置服务端,
 * 上 ws 就得加依赖。而观战是单向推送,SSE 正好够用 ——
 * 服务端把响应挂住不关,每次状态变化写一行 `data: {...}`,浏览器端
 * `new EventSource()` 是原生的,不用打包、不用构建步骤。
 *
 * 推的是**整份快照**而不是增量:一局状态序列化出来才几 KB,全量推能彻底
 * 消灭"前端状态和引擎不同步"这类最难查的 bug,刷新页面也自动恢复。
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'client.html');

/**
 * API 钩子。返回 true 表示这个请求已经处理掉了。
 *
 * 设置页的那些接口(模型列表、写 key、开局)都从这里挂进来 —— 服务端本身
 * 保持通用,不知道三国杀的任何事,也就不会变成一个什么都往里塞的上帝对象。
 */
export type ApiHandler = (
  req: http.IncomingMessage, res: http.ServerResponse, url: string,
) => boolean | Promise<boolean>;

/** 读完整个请求体。带上限,免得被一个超长 POST 撑爆内存 */
export function readBody(req: http.IncomingMessage, limit = 1 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

export interface ViewerServer {
  port: number;
  url: string;
  /** 当前连着的浏览器数 */
  clients: number;
  /** 推一份快照 */
  push(state: unknown): void;
  /** 等第一个浏览器连上来。已经有连接就立刻返回 */
  waitForClient(): Promise<void>;
  close(): Promise<void>;
}

export interface ViewerOptions {
  port?: number;
  /** 额外的接口。设置页用它挂 /api/*,观战模式不传就只有 / 和 /events */
  api?: ApiHandler;
  /** 首页给哪个文件。设置页模式下是 setup.html,棋盘固定在 /board */
  page?: string;
}

export async function startViewer(opts: ViewerOptions = {}): Promise<ViewerServer> {
  const conns = new Set<http.ServerResponse>();
  let last: string | null = null;
  let onFirst: (() => void) | null = null;

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (opts.api) {
      try {
        if (await opts.api(req, res, url)) return;
      } catch (e) {
        // 接口自己抛了 —— 回一句人能看懂的,别把整个服务器带下去
        if (!res.headersSent) sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        else try { res.end(); } catch { /* 已经断了 */ }
        return;
      }
    }

    if (url === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // nginx 之类的反代会缓冲 SSE;本地用不上,但写着没坏处
        'x-accel-buffering': 'no',
      });
      res.write(': ok\n\n');
      conns.add(res);
      // 新连上来的(含刷新)先补一份当前状态,不然要等下一次推送才有画面
      if (last) res.write(`data: ${last}\n\n`);
      onFirst?.(); onFirst = null;
      req.on('close', () => conns.delete(res));
      return;
    }

    if (url === '/board') {
      serveHtml(res, PAGE);
      return;
    }

    if (url === '/' || url === '/index.html') {
      serveHtml(res, opts.page ?? PAGE);
      return;
    }

    res.writeHead(404).end('not found');
  });

  const port = await listen(server, opts.port ?? 5173);

  return {
    port,
    url: `http://localhost:${port}`,
    get clients() { return conns.size; },
    push(state) {
      last = JSON.stringify(state);
      const frame = `data: ${last}\n\n`;
      for (const res of conns) {
        // 浏览器关得不干净时 write 会抛,别让它掀翻整局
        try { res.write(frame); } catch { conns.delete(res); }
      }
    },
    waitForClient() {
      if (conns.size) return Promise.resolve();
      return new Promise<void>(resolve => { onFirst = resolve; });
    },
    close() {
      for (const res of conns) { try { res.end(); } catch { /* 已经断了 */ } }
      conns.clear();
      return new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

/** 每次都从磁盘读 —— 改完 html 刷新页面即可,不用重启 */
function serveHtml(res: http.ServerResponse, file: string): void {
  let html: string;
  try { html = fs.readFileSync(file, 'utf8'); }
  catch { res.writeHead(500).end(`找不到 ${path.basename(file)}`); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** 端口被占就顺延找下一个,最多试 20 个。传 0 表示随便给一个空闲端口 */
function listen(server: http.Server, want: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = want;
    const tryOnce = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && want > 0 && port - want < 20) { port++; tryOnce(); }
        else reject(e);
      });
      server.listen(port, '127.0.0.1', () => {
        // want=0 时内核挑了个端口,得回头问它到底是哪个
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    };
    tryOnce();
  });
}

/** 打开系统默认浏览器。失败了不算错 —— 顶多你自己点一下链接 */
export function openBrowser(url: string) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* 打不开就打不开 */ }
}
