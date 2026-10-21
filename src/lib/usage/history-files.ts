import 'server-only';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initialCodexScanState, parseCodexLine, parseClaudeLine, parseGrokLine,
  type CodexScanState, type UsageRecord } from './history-readers/usageTranscripts';
import type { HistoryRoot } from './history-roots';

export interface FileMemo {
  size: number; mtimeMs: number; inode: string; offset: number; partial?: boolean; state: CodexScanState; records: UsageRecord[];
}
export async function discoverHistoryFiles(root: HistoryRoot, since: number) {
  const files: string[] = [];
  const canonical = await realpath(root.path).catch(() => null);
  if (!canonical) return { files, missing: true, partial: false };
  const directories = [canonical]; let partial = false;
  while (directories.length) {
    const directory = directories.pop()!;
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile() && entry.name.endsWith('.jsonl') && (root.provider !== 'grok' || entry.name === 'updates.jsonl')) {
          const info = await stat(path);
          if (info.mtimeMs >= since - 36 * 3_600_000) files.push(path);
        }
      }
    } catch { partial = true; }
  }
  return { files, missing: false, partial };
}

/** Keeps only usage metadata. A partial final line is re-read after the writer finishes it. */
export async function scanHistoryFile(path: string, provider: HistoryRoot['provider'], previous: FileMemo | undefined, since: number) {
  const info = await stat(path); const inode = `${info.dev}:${info.ino}`;
  if (previous && previous.inode === inode && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
    return { memo: previous, bytesRead: 0 };
  }
  const append = previous && previous.inode === inode && info.size > previous.size;
  const memo: FileMemo = append ? { ...previous, state: { ...previous.state }, records: previous.records.filter(record => record.timestampMs >= since) }
    : { size: 0, mtimeMs: 0, inode, offset: 0, state: initialCodexScanState(), records: [] };
  const start = memo.offset;
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024, start, end: Math.max(0, info.size - 1) });
  // readline would consume an unfinished tail. Process only complete lines with their byte offset.
  let segments: Buffer[] = []; let pendingBytes = 0; let offset = start; let skipping = false;
  for await (const chunk of stream) {
    const bytes = chunk as Buffer; let cursor = 0; let end: number;
    while ((end = bytes.indexOf(10, cursor)) !== -1) {
      const part = bytes.subarray(cursor, end);
      if (skipping) { offset += pendingBytes + part.length + 1; cursor = end + 1; segments = []; pendingBytes = 0; skipping = false; continue; }
      const lineBytes = segments.length ? Buffer.concat([...segments, part], pendingBytes + part.length) : part;
      offset += pendingBytes + part.length + 1; cursor = end + 1; segments = []; pendingBytes = 0;
      const eligible = provider === 'claude' ? lineBytes.includes('"usage"') : provider === 'grok' ? lineBytes.includes('"turn_completed"')
        : ['"token_count"', '"turn_context"', '"session_meta"', '"thread_settings_applied"'].some(key => lineBytes.includes(key));
      if (!eligible) continue;
      const line = lineBytes.toString('utf8');
      const records = provider === 'claude' ? [parseClaudeLine(line)] : provider === 'grok' ? parseGrokLine(line) : [parseCodexLine(line, memo.state)];
      for (const record of records) if (record && record.timestampMs >= since) {
        memo.records.push({ ...record, sessionId: record.sessionId || createHash('sha256').update(path).digest('hex') });
      }
    }
    const tail = bytes.subarray(cursor); if (tail.length) { if (!skipping) segments.push(tail); pendingBytes += tail.length; }
    if (!skipping && pendingBytes > 16 * 1024 * 1024) {
      const prefix = segments[0]?.subarray(0, 512).toString('utf8') ?? '';
      const unrelated = provider === 'codex' && /"type"\s*:\s*"response_item"/.test(prefix);
      if (!unrelated) memo.partial = true;
      skipping = true; segments = [];
    }
  }
  memo.offset = offset; memo.size = info.size; memo.mtimeMs = info.mtimeMs;
  return { memo, bytesRead: info.size - start };
}
