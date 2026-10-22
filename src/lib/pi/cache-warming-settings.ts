import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { detectPiUserSetup } from '@/lib/pi/user-setup';
import type { PiCacheWarming } from '@/lib/pi/cache-warming';

const MAX_BYTES = 64 * 1024;

// Parse first, then replace just the top-level value's byte span. Nested keys,
// whitespace and unrelated values are left verbatim. Duplicate keys are refused.
function editSetting(raw: string, mode: PiCacheWarming): string {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings');
  const tokens = [...raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)];
  let depth = 0;
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (depth === 1 && token[0].startsWith('"') && tokens[i + 1]?.[0] === ':' && JSON.parse(token[0]) === 'cacheWarming') {
      const start = tokens[i + 2];
      let end = i + 2;
      if (start[0] === '{' || start[0] === '[') {
        let nested = 1;
        while (nested && ++end < tokens.length) {
          if (tokens[end][0] === '{' || tokens[end][0] === '[') nested += 1;
          if (tokens[end][0] === '}' || tokens[end][0] === ']') nested -= 1;
        }
      }
      spans.push([start.index, tokens[end].index + tokens[end][0].length]);
    }
    if (token[0] === '{' || token[0] === '[') depth += 1;
    if (token[0] === '}' || token[0] === ']') depth -= 1;
  }
  if (spans.length > 1) throw new Error('Duplicate settings');
  if (spans.length) {
    const [start, end] = spans[0];
    return raw.slice(0, start) + JSON.stringify(mode) + raw.slice(end);
  }
  const close = raw.lastIndexOf('}');
  const before = raw.slice(0, close).trimEnd();
  const hasKeys = Object.keys(value).length > 0;
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const multiline = raw.includes('\n');
  const indent = raw.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  return before + (hasKeys ? ',' : '') + (multiline ? newline + indent : hasKeys ? ' ' : '')
    + `"cacheWarming": ${JSON.stringify(mode)}` + raw.slice(before.length);
}

// Serialize this process's requests; external edits are checked again before
// atomic replacement. Never truncate a user's file or follow a settings link.
let pending: Promise<void> = Promise.resolve();
export function setPiCacheWarming(mode: PiCacheWarming): Promise<void> {
  const next = pending.then(() => writeSetting(mode));
  pending = next.catch(() => undefined);
  return next;
}

async function writeSetting(mode: PiCacheWarming): Promise<void> {
  const setup = await detectPiUserSetup();
  if (!setup.detected || !setup.cacheWarmingSupported) throw new Error('Unsupported Pi');
  const file = path.join(setup.agentDir, 'settings.json');
  await mkdir(setup.agentDir, { recursive: true });
  const original = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (original && (!original.isFile() || original.size > MAX_BYTES)) throw new Error('Unsafe settings');
  let raw = '{}\n';
  if (original) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || info.ino !== original.ino || info.dev !== original.dev) throw new Error('Changed settings');
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!read.bytesRead) break;
        bytesRead += read.bytesRead;
      }
      if (bytesRead > MAX_BYTES) throw new Error('Oversized settings');
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  }
  const updated = editSetting(raw, mode);
  if (Buffer.byteLength(updated, 'utf8') > MAX_BYTES) throw new Error('Oversized settings');
  const temp = `${file}.o8-${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx', original ? original.mode & 0o777 : 0o600);
    try { await handle.writeFile(updated, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    const current = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (original ? !current || !current.isFile() || current.ino !== original.ino || current.dev !== original.dev
      || current.size !== original.size || current.mtimeMs !== original.mtimeMs : current !== null) throw new Error('Changed settings');
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => undefined); }
}
