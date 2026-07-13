import { describe, it, expect } from 'vitest';
import {
  buildCrashDigest,
  CRASH_WINDOW_MS,
  MAX_DIGEST_RECORDS,
  MAX_DIGEST_BYTES,
} from './crash-digest';
import type { CrashRecord } from './crash-store';

const NOW = 1_800_000_000_000;

function record(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    ts: NOW - 1000,
    source: 'renderer',
    appVersion: '0.1.591',
    kind: 'window.error',
    message: 'TypeError: cannot read properties of undefined',
    stack: 'at DiffPanel (DiffPanel.tsx:42)',
    ...overrides,
  };
}

describe('buildCrashDigest', () => {
  it('returns an empty digest when there are no crashes', () => {
    const digest = buildCrashDigest([], NOW);
    expect(digest.count).toBe(0);
    expect(digest.text).toBe('');
    expect(digest.summary).toBe('');
  });

  it('drops crashes older than the window', () => {
    const digest = buildCrashDigest(
      [record({ ts: NOW - CRASH_WINDOW_MS - 1, message: 'ancient' })],
      NOW,
    );
    expect(digest.count).toBe(0);
    expect(digest.text).toBe('');
  });

  it('keeps a crash on the window boundary', () => {
    const digest = buildCrashDigest([record({ ts: NOW - CRASH_WINDOW_MS })], NOW);
    expect(digest.count).toBe(1);
  });

  it('ignores records stamped in the future', () => {
    const digest = buildCrashDigest([record({ ts: NOW + 60_000 })], NOW);
    expect(digest.count).toBe(0);
  });

  it('orders newest first and caps the records it renders', () => {
    const all = Array.from({ length: MAX_DIGEST_RECORDS + 3 }, (_, i) =>
      record({ ts: NOW - i * 1000, message: `crash-${i}` }),
    );
    const digest = buildCrashDigest(all, NOW);

    // count reports everything in the window; records are the capped subset.
    expect(digest.count).toBe(MAX_DIGEST_RECORDS + 3);
    expect(digest.records).toHaveLength(MAX_DIGEST_RECORDS);
    expect(digest.records[0].message).toBe('crash-0');
    expect(digest.summary).toContain('crash-0');
    expect(digest.text).toContain('3 older omitted');
    expect(digest.text).not.toContain(`crash-${MAX_DIGEST_RECORDS}`);
  });

  it('surfaces the newest crash in the summary line', () => {
    const digest = buildCrashDigest(
      [
        record({ ts: NOW - 5000, message: 'older' }),
        record({ ts: NOW - 1000, source: 'ws-server', kind: 'uncaughtException', message: 'newest' }),
      ],
      NOW,
    );
    expect(digest.summary).toContain('2 in the last 24h');
    expect(digest.summary).toContain('uncaughtException in ws-server');
    expect(digest.summary).toContain('newest');
  });

  it('includes the stack trace in the attachment body', () => {
    const digest = buildCrashDigest([record({ stack: 'at Foo (foo.ts:1)' })], NOW);
    expect(digest.text).toContain('at Foo (foo.ts:1)');
    expect(digest.text).toContain('0.1.591');
  });

  it('clamps a crash-looping log to the byte ceiling', () => {
    const huge = Array.from({ length: MAX_DIGEST_RECORDS }, (_, i) =>
      record({ ts: NOW - i * 1000, stack: 'x'.repeat(40_000) }),
    );
    const digest = buildCrashDigest(huge, NOW);
    expect(Buffer.byteLength(digest.text, 'utf8')).toBeLessThanOrEqual(MAX_DIGEST_BYTES);
    expect(digest.text).toContain('[truncated]');
  });
});
