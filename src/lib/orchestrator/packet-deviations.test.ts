import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDeviationsClause,
  IMPLEMENTATION_NOTES_FILENAME,
  MAX_NOTES_BYTES,
  packetImplementationNotesPath,
  parseDeviations,
  readPacketDeviations,
} from './packet-deviations';

const packetId = 'pkt-notes-test';

describe('parseDeviations', () => {
  it('returns null when there is no Deviations heading', () => {
    expect(parseDeviations('# Notes\n\nAll went to plan.')).toBeNull();
    expect(parseDeviations('')).toBeNull();
  });

  it('extracts bullet entries under the heading', () => {
    const content = [
      '# Implementation notes',
      '',
      '## Deviations',
      '- Used a sibling module instead of editing the 800-line file — kept it under the ceiling.',
      '* Skipped the flaky smoke test — noted as an operator follow-up.',
      '',
    ].join('\n');
    const parsed = parseDeviations(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.entries).toEqual([
      'Used a sibling module instead of editing the 800-line file — kept it under the ceiling.',
      'Skipped the flaky smoke test — noted as an operator follow-up.',
    ]);
  });

  it('distinguishes an empty section (asserted no deviations) from a missing heading', () => {
    const parsed = parseDeviations('## Deviations\n');
    expect(parsed).not.toBeNull();
    expect(parsed?.entries).toEqual([]);
    expect(parsed?.raw).toBe('');
  });

  it('stops at the next heading of the same or higher level', () => {
    const content = [
      '## Deviations',
      '- Only this bullet belongs to the section.',
      '## Testing',
      '- This bullet is a different section.',
    ].join('\n');
    expect(parseDeviations(content)?.entries).toEqual(['Only this bullet belongs to the section.']);
  });

  it('is case-insensitive on the heading and tolerates CRLF', () => {
    const content = '### deviations\r\n- one\r\n';
    expect(parseDeviations(content)?.entries).toEqual(['one']);
  });
});

describe('readPacketDeviations', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing worktree path or missing file', () => {
    expect(readPacketDeviations(null, packetId)).toBeNull();
    expect(readPacketDeviations('', packetId)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'dev-'));
    dirs.push(dir);
    expect(readPacketDeviations(dir, packetId)).toBeNull();
  });

  it('reads and parses the ignored packet artifact instead of the tracked root filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-'));
    dirs.push(dir);
    writeFileSync(join(dir, IMPLEMENTATION_NOTES_FILENAME), '## Deviations\n- stale root note\n');
    const notesPath = join(dir, packetImplementationNotesPath(packetId));
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(notesPath, '## Deviations\n- swapped approach\n');
    const result = readPacketDeviations(dir, packetId);
    expect(result?.entries).toEqual(['swapped approach']);
    expect(typeof result?.capturedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result!.capturedAt))).toBe(false);
  });

  it('caps the read so a runaway notes file cannot bloat the review/packet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-'));
    dirs.push(dir);
    const huge = `## Deviations\n- ${'x'.repeat(MAX_NOTES_BYTES * 2)}\n`;
    const notesPath = join(dir, packetImplementationNotesPath(packetId));
    mkdirSync(dirname(notesPath), { recursive: true });
    writeFileSync(notesPath, huge);
    const result = readPacketDeviations(dir, packetId);
    expect(result).not.toBeNull();
    // The parsed raw body is bounded by the read cap (never the full 2x file).
    expect(result!.raw.length).toBeLessThanOrEqual(MAX_NOTES_BYTES);
    expect(result!.raw.length).toBeLessThan(huge.length);
  });
});

describe('buildDeviationsClause', () => {
  it('names the ignored packet path and the Deviations heading so briefs stay consistent', () => {
    const clause = buildDeviationsClause(packetId);
    expect(clause).toContain(packetImplementationNotesPath(packetId));
    expect(clause).toContain('## Deviations');
    expect(clause).toContain('conservative');
    expect(clause).not.toContain('worktree root');
  });
});
