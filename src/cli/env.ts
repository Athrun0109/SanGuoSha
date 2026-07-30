/**
 * 极简 .env 读写。只为了记住 API key,不想为此引依赖。
 *
 * 优先级:进程环境变量 > .env 文件。已经 export 过的不会被文件覆盖。
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve(process.cwd(), '.env');

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

/** 把 .env 里的值灌进 process.env(不覆盖已有的) */
export function loadEnv(file = FILE): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const vars = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(vars)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return vars;
}

/** 写入/更新一个键,保留文件里其它内容 */
export function saveEnv(key: string, value: string, file = FILE): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  let replaced = false;
  const out = lines.map(l => {
    const t = l.trim();
    if (!t || t.startsWith('#')) return l;
    if (t.slice(0, t.indexOf('=')).trim() === key) { replaced = true; return `${key}=${value}`; }
    return l;
  });
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(`${key}=${value}`);
  }
  fs.writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'), 'utf8');
}

export const ENV_FILE = FILE;
