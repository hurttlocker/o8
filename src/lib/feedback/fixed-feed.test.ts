import { describe, it, expect } from 'vitest';
import { matchReceipts, type FixedEntry } from './fixed-feed';

// "You reported this" must only fire for reports filed from THIS install.
// The maintainer's box mirrors EVERY report into its ledger via the intake
// sync (origin 'intake-sync'); without the origin check the ops machine
// showed receipts for other people's reports (hit live 2026-07-14 on the
// D3YPBP fix). The ledger is append-only and the join is last-write-wins,
// so a re-appended marked row must override an older unmarked copy.

const manifest: FixedEntry[] = [
  { id: 'D3YPBP', title: 'New session button does nothing', version: '0.1.597', status: 'fixed' },
  { id: 'AAAAAA', title: 'Some other fix', version: '0.1.597', status: 'fixed' },
];

describe('matchReceipts origin gate', () => {
  it('receipts a locally-filed report', () => {
    const receipts = matchReceipts(manifest, [
      { id: 'AAAAAA', ts: 100, title: 'my own words', origin: 'local' },
    ], new Set());
    expect(receipts.map((r) => r.id)).toEqual(['AAAAAA']);
    expect(receipts[0].title).toBe('my own words');
  });

  it('treats unmarked legacy rows as local (a normal ledger only holds its own reports)', () => {
    const receipts = matchReceipts(manifest, [{ id: 'AAAAAA', ts: 100 }], new Set());
    expect(receipts.map((r) => r.id)).toEqual(['AAAAAA']);
  });

  it('NEVER receipts a row mirrored by the intake sync', () => {
    const receipts = matchReceipts(manifest, [
      { id: 'D3YPBP', ts: 100, origin: 'intake-sync' },
    ], new Set());
    expect(receipts).toEqual([]);
  });

  it('a later marked row overrides an older unmarked copy of the same id', () => {
    const receipts = matchReceipts(manifest, [
      { id: 'D3YPBP', ts: 100 },                          // old unmarked (pre-backfill)
      { id: 'D3YPBP', ts: 100, origin: 'intake-sync' },   // backfilled marker
    ], new Set());
    expect(receipts).toEqual([]);
  });

  it('still hides already-seen receipts', () => {
    const receipts = matchReceipts(manifest, [
      { id: 'AAAAAA', ts: 100, origin: 'local' },
    ], new Set(['AAAAAA']));
    expect(receipts).toEqual([]);
  });
});
