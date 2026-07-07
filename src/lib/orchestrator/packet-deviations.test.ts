import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEVIATIONS_CLAUSE,
  IMPLEMENTATION_NOTES_FILENAME,
  parseDeviations,
  readPacketDeviations,
} from './packet-deviations';

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
    expect(readPacketDeviations(null)).toBeNull();
    expect(readPacketDeviations('')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'dev-'));
    dirs.push(dir);
    expect(readPacketDeviations(dir)).toBeNull();
  });

  it('reads and parses the notes file with a capturedAt timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev-'));
    dirs.push(dir);
    writeFileSync(join(dir, IMPLEMENTATION_NOTES_FILENAME), '## Deviations\n- swapped approach\n');
    const result = readPacketDeviations(dir);
    expect(result?.entries).toEqual(['swapped approach']);
    expect(typeof result?.capturedAt).toBe('string');
    expect(Number.isNaN(Date.parse(result!.capturedAt))).toBe(false);
  });
});

describe('DEVIATIONS_CLAUSE', () => {
  it('names the notes file and the Deviations heading so briefs stay consistent', () => {
    expect(DEVIATIONS_CLAUSE).toContain(IMPLEMENTATION_NOTES_FILENAME);
    expect(DEVIATIONS_CLAUSE).toContain('## Deviations');
    expect(DEVIATIONS_CLAUSE).toContain('conservative');
  });
});
