/**
 * The in-app receipt — "your report was fixed in this version."
 *
 * Covers the pure join (matchReceipts) AND the real route, per the reachability
 * rule: the join working on direct arguments proves nothing if the route never
 * reaches it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchReceipts, type FixedEntry } from '@/lib/feedback/fixed-feed';
import type { ReportRecord } from '@/lib/feedback/report-ledger';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const ledger = vi.hoisted(() => ({ reports: [] as ReportRecord[] }));
const seenStore = vi.hoisted(() => ({ ids: [] as string[] }));
const manifest = vi.hoisted(() => ({ body: null as unknown, status: 200 }));

vi.mock('@/lib/feedback/report-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feedback/report-ledger')>()),
  readReports: () => ledger.reports,
  feedbackDir: () => '/tmp/o8-receipt-test',
}));

function entry(id: string, title = 'Diff panel went blank', version = '0.1.592'): FixedEntry {
  return { id, title, version };
}
function report(id: string, ts = NOW - DAY): ReportRecord {
  return { id, ts, category: 'bug', title: 'whatever', reporter: null, version: '0.1.590' };
}

describe('matchReceipts — the local join', () => {
  it('surfaces a fix for a report this machine filed', () => {
    const out = matchReceipts([entry('A7F3K2')], [report('A7F3K2')], new Set());
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Diff panel went blank');
    expect(out[0].version).toBe('0.1.592');
  });

  it("ignores fixes for somebody else's report", () => {
    // The manifest is public and carries EVERY fixed report. Showing a stranger's
    // bug as "you reported this" would be the whole feature, backwards.
    const out = matchReceipts([entry('ZZZZZZ')], [report('A7F3K2')], new Set());
    expect(out).toHaveLength(0);
  });

  it('does not re-nag an acknowledged receipt', () => {
    const out = matchReceipts([entry('A7F3K2')], [report('A7F3K2')], new Set(['A7F3K2']));
    expect(out).toHaveLength(0);
  });

  it('matches case-insensitively — ids get retyped into commit trailers', () => {
    const out = matchReceipts([entry('A7F3K2')], [{ id: 'a7f3k2', ts: NOW }], new Set());
    expect(out).toHaveLength(1);
  });

  it('puts the most recently filed report first', () => {
    const out = matchReceipts(
      [entry('OLD111', 'old bug'), entry('NEW222', 'new bug')],
      [report('OLD111', NOW - 30 * DAY), report('NEW222', NOW - DAY)],
      new Set(),
    );
    expect(out.map((r) => r.id)).toEqual(['NEW222', 'OLD111']);
  });

  it('is empty when the manifest has not shipped yet', () => {
    expect(matchReceipts([], [report('A7F3K2')], new Set())).toHaveLength(0);
  });
});

describe('GET /api/feedback/fixed — the real route', () => {
  beforeEach(() => {
    vi.resetModules();
    ledger.reports = [];
    seenStore.ids = [];
    manifest.body = { schema: 1, fixed: [] };
    manifest.status = 200;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest.body), {
      status: manifest.status,
      headers: { 'Content-Type': 'application/json' },
    }));
  });

  async function get() {
    const { GET } = await import('@/app/api/feedback/fixed/route');
    const { __resetFixedFeedCache, markSeen, readSeen } = await import('@/lib/feedback/fixed-feed');
    void markSeen; void readSeen;
    __resetFixedFeedCache();
    return GET();
  }

  it('fetches the public manifest and joins it against the local ledger', async () => {
    ledger.reports = [report('A7F3K2')];
    manifest.body = { schema: 1, fixed: [{ id: 'A7F3K2', title: 'Diff panel went blank', version: '0.1.592' }] };

    const body = (await (await get()).json()) as { ok: boolean; receipts: { id: string; version: string }[] };
    expect(body.ok).toBe(true);
    expect(body.receipts).toHaveLength(1);
    expect(body.receipts[0]).toMatchObject({ id: 'A7F3K2', version: '0.1.592' });
  });

  it('returns nothing (and does not throw) before the first manifest ships', async () => {
    ledger.reports = [report('A7F3K2')];
    manifest.status = 404; // expected until a release carries fixed.json

    const res = await get();
    const body = (await res.json()) as { receipts: unknown[] };
    expect(res.status).toBe(200);
    expect(body.receipts).toHaveLength(0);
  });

  it('survives a malformed manifest rather than breaking the dashboard', async () => {
    ledger.reports = [report('A7F3K2')];
    manifest.body = { fixed: 'not-an-array' };

    const body = (await (await get()).json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(0);
  });

  it('skips manifest rows missing a title or version', async () => {
    ledger.reports = [report('A7F3K2'), report('B2M9QP')];
    manifest.body = {
      schema: 1,
      fixed: [
        { id: 'A7F3K2', version: '0.1.592' }, // no title — nothing to show
        { id: 'B2M9QP', title: 'Merge card froze', version: '0.1.592' },
      ],
    };

    const body = (await (await get()).json()) as { receipts: { id: string }[] };
    expect(body.receipts.map((r) => r.id)).toEqual(['B2M9QP']);
  });
});
