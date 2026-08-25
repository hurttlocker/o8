import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.O8_DATA_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'o8-hourly-cap-'));
process.env.CORTEX_IDE_DATA_DIR ??= process.env.O8_DATA_DIR;

const { getSqlite } = await import('@/lib/db');
const { ensureV44BroadcastSchema } = await import('@/lib/db/v44-broadcast-migration');
const { appendBroadcastEvent } = await import('@/lib/broadcast/post');
const { claimBroadcastLineSlot, broadcastGeneratedLinesSince, broadcastHourlyWindowStart } =
  await import('@/lib/broadcast/hourly-cap');

const NOW = new Date('2026-08-24T12:00:00.000Z');

function capped(text: string) {
  return appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text }, {
    sqlite: getSqlite(),
    now: NOW,
    metadata: { hourlyCapped: true },
  });
}

describe('claimBroadcastLineSlot (#1840)', () => {
  it('never lets producers exceed the cap, however many race for the last slot', () => {
    const sqlite = getSqlite();
    ensureV44BroadcastSchema(sqlite);
    const before = broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW));
    const cap = before + 12;

    // Two producers previously each read the same count, each concluded there
    // was room, and both appended -- so the ceiling was soft by however many
    // were running. Every attempt now re-reads inside its own insert's
    // transaction, so only the ones with room actually write.
    let written = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const event = claimBroadcastLineSlot(sqlite, NOW, cap, () => capped(`line ${attempt}`));
      if (event) written += 1;
    }

    expect(written).toBe(12);
    expect(broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW))).toBe(cap);
  });

  it('refuses without writing once the window is full', () => {
    const sqlite = getSqlite();
    const count = broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW));
    expect(claimBroadcastLineSlot(sqlite, NOW, count, () => capped('overflow'))).toBeNull();
    expect(broadcastGeneratedLinesSince(sqlite, broadcastHourlyWindowStart(NOW))).toBe(count);
  });

  it('treats a zero or nonsense cap as closed rather than unlimited', () => {
    const sqlite = getSqlite();
    expect(claimBroadcastLineSlot(sqlite, NOW, 0, () => capped('zero'))).toBeNull();
    expect(claimBroadcastLineSlot(sqlite, NOW, -1, () => capped('negative'))).toBeNull();
    expect(claimBroadcastLineSlot(sqlite, NOW, Number.NaN, () => capped('nan'))).toBeNull();
  });
});
