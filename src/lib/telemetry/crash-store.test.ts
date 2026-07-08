import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-telemetry-'));
process.env.O8_DATA_DIR = dataDir;
process.env.O8_APP_VERSION = '9.9.9-test';

const {
  appendCrashLine,
  appendCrashLineSync,
  buildCrashRecord,
  computeRetainedTail,
  crashLogPath,
  readCrashRecords,
} = await import('./crash-store');

describe('crash-store — sanitize', () => {
  it('truncates message + stack and never carries extra fields', () => {
    const record = buildCrashRecord({
      source: 'next-server',
      kind: 'uncaughtException',
      message: 'x'.repeat(5000),
      stack: 'y'.repeat(20000),
    });
    expect(record.message.length).toBeLessThan(2100);
    expect(record.message.endsWith('…[truncated]')).toBe(true);
    expect((record.stack ?? '').length).toBeLessThan(8100);
    expect(record.appVersion).toBe('9.9.9-test');
    // Only the known keys — no leaked input.
    expect(Object.keys(record).sort()).toEqual(['appVersion', 'kind', 'message', 'source', 'stack', 'ts']);
  });

  it('serializes newlines inside a message as a single JSONL line', async () => {
    await appendCrashLine(buildCrashRecord({
      source: 'renderer',
      kind: 'window.error',
      message: 'line one\nline two',
    }));
    const raw = readFileSync(crashLogPath(), 'utf8').trimEnd();
    const lastLine = raw.split('\n').pop() ?? '';
    // The record must round-trip as ONE JSON object despite the embedded newline.
    expect(() => JSON.parse(lastLine)).not.toThrow();
    expect(JSON.parse(lastLine).message).toBe('line one\nline two');
  });
});

describe('crash-store — ring buffer', () => {
  it('computeRetainedTail drops oldest lines to fit the budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join('\n');
    const tail = computeRetainedTail(lines, 40);
    expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(40);
    // Keeps the NEWEST content.
    expect(tail).toContain('line-99');
    expect(tail).not.toContain('line-0\n');
  });

  it('sync + async appends both persist and read back', async () => {
    appendCrashLineSync(buildCrashRecord({ source: 'boot', kind: 'uncaughtException', message: 'sync crash' }));
    await appendCrashLine(buildCrashRecord({ source: 'ws-server', kind: 'unhandledRejection', message: 'async crash' }));
    const records = readCrashRecords();
    const messages = records.map((r) => r.message);
    expect(messages).toContain('sync crash');
    expect(messages).toContain('async crash');
  });
});

beforeAll(() => {
  // Marker so a failed import surfaces clearly rather than as a silent skip.
  expect(typeof buildCrashRecord).toBe('function');
});
