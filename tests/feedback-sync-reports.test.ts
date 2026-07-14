/**
 * parseReportEmbed — reconstruct a ledger record from a Discord report card.
 *
 * This is the seam that closes the loop's real hole: a user's report is recorded
 * on THEIR machine, never the maintainer's, so a fix for somebody else's bug used
 * to resolve to "unknown report id" and get silently dropped. Discord is the
 * durable store; this reads it back.
 *
 * Fixtures are verbatim shapes from the live intake channel (2026-07-14), not
 * invented ones — including the pre-id legacy cards that must be skipped.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs build script, no types
import { parseReportEmbed } from '../scripts/sync-reports.mjs';

/** The real FYPPHK card, the first report filed under the id format. */
const REAL_REPORT = {
  timestamp: '2026-07-14T02:10:45.305000+00:00',
  embeds: [{
    title: '[BUG] FYPPHK · Small ui bug with the commands popup. Also, sometimes even when I clear the text area, the popup stays up.',
    footer: { text: 'o8 · report FYPPHK · private intake' },
    fields: [
      { name: 'Version', value: '0.1.592' },
      { name: 'OS', value: 'darwin 25.5.0 arm64' },
      { name: 'Route', value: '/dashboard' },
      { name: 'Reported by', value: 'anonymous' },
      { name: 'Timestamp', value: '2026-07-14T02:10:44.788Z' },
    ],
  }],
};

/** A real pre-id card — these predate report ids and can never be receipted. */
const LEGACY_REPORT = {
  timestamp: '2026-07-13T11:08:36.755000+00:00',
  embeds: [{
    title: '[BUG] Issue when adding a repository. All I get is this error.',
    footer: { text: 'o8 beta · one-way intake' },
    fields: [{ name: 'Version', value: '0.1.590' }],
  }],
};

describe('parseReportEmbed', () => {
  it('reconstructs a report the maintainer never filed', () => {
    const record = parseReportEmbed(REAL_REPORT);
    expect(record).toMatchObject({
      id: 'FYPPHK',
      category: 'bug',
      reporter: null, // "anonymous" is an absence, not a handle
      version: '0.1.592',
    });
    expect(record.title).toBe('Small ui bug with the commands popup. Also, sometimes even when I clear the text area, the popup stays up.');
    expect(record.ts).toBe(Date.parse('2026-07-14T02:10:44.788Z'));
  });

  it('skips a pre-id report rather than inventing an id for it', () => {
    expect(parseReportEmbed(LEGACY_REPORT)).toBeNull();
  });

  it('credits a connected reporter, stripping the @', () => {
    const record = parseReportEmbed({
      ...REAL_REPORT,
      embeds: [{
        ...REAL_REPORT.embeds[0],
        fields: [
          ...REAL_REPORT.embeds[0].fields.filter((f) => f.name !== 'Reported by'),
          { name: 'Reported by', value: '@kleosr' },
        ],
      }],
    });
    expect(record.reporter).toBe('kleosr');
  });

  it('reads the id from the footer when a long title clips it', () => {
    // Discord truncates an embed title at 256 chars, so the title is not a
    // reliable id source — the footer is.
    const record = parseReportEmbed({
      ...REAL_REPORT,
      embeds: [{ ...REAL_REPORT.embeds[0], title: `[BUG] FYPPHK · ${'x'.repeat(400)}` }],
    });
    expect(record.id).toBe('FYPPHK');
  });

  it('classifies a request', () => {
    const record = parseReportEmbed({
      ...REAL_REPORT,
      embeds: [{
        ...REAL_REPORT.embeds[0],
        title: '[REQUEST] B2M9QP · dark mode for the canvas',
        footer: { text: 'o8 · report B2M9QP · private intake' },
      }],
    });
    expect(record).toMatchObject({ id: 'B2M9QP', category: 'request', title: 'dark mode for the canvas' });
  });

  it('ignores chatter that is not a report card', () => {
    expect(parseReportEmbed({ timestamp: '2026-07-14T00:00:00Z', embeds: [] })).toBeNull();
    expect(parseReportEmbed({ timestamp: '2026-07-14T00:00:00Z' })).toBeNull();
    expect(parseReportEmbed(null)).toBeNull();
  });

  it('never mints an id containing a confusable character', () => {
    // The id alphabet excludes 0/O/1/I/L/U — a card carrying one is not ours.
    const record = parseReportEmbed({
      ...REAL_REPORT,
      embeds: [{
        ...REAL_REPORT.embeds[0],
        title: '[BUG] O0IL1U · spoofed',
        footer: { text: 'o8 · report O0IL1U · private intake' },
      }],
    });
    expect(record).toBeNull();
  });
});

describe('buildManifest — publish wins and asks, never wounds', () => {
  it('publishes a fix and a needs-info ask, and NOTHING else', async () => {
    // The manifest is a public download. A scrapeable list of "o8 won't fix these"
    // is exactly the rot board we refused to build — so wounds stay internal.
    // @ts-expect-error — plain .mjs build script, no types
    const { buildManifest } = await import('../scripts/lib/fixed-reports.mjs');

    const reports = new Map([
      ['WIN111', { id: 'WIN111', title: 'the win', version: '0.1.592' }],
      ['ASK222', { id: 'ASK222', title: 'the ask', version: '0.1.592' }],
      ['WND333', { id: 'WND333', title: 'the wound', version: '0.1.592' }],
      ['WND444', { id: 'WND444', title: 'another wound', version: '0.1.592' }],
    ]);
    const status = new Map([
      ['ASK222', { status: 'needs-info', notes: [{ note: 'which OS?', ts: 2 }] }],
      ['WND333', { status: 'wont-fix', notes: [{ note: 'by design', ts: 3 }] }],
      ['WND444', { status: 'cant-reproduce', notes: [{ note: 'clean on 0.1.593', ts: 4 }] }],
    ]);
    const published = [{ id: 'WIN111', title: 'the win', version: '0.1.592' }];

    const manifest = buildManifest(published, 'now', { status, reports });
    const byId = Object.fromEntries(manifest.fixed.map((e: { id: string }) => [e.id, e]));

    expect(byId.WIN111.status).toBe('fixed');
    expect(byId.ASK222).toMatchObject({ status: 'needs-info', note: 'which OS?' });
    expect(byId.WND333, 'wont-fix must never be published').toBeUndefined();
    expect(byId.WND444, 'cant-reproduce must never be published').toBeUndefined();

    // And no reporter handles, ever.
    expect(JSON.stringify(manifest)).not.toContain('reporter');
  });
});
