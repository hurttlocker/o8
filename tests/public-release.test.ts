import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLatestShip } from '../scripts/lib/public-release.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const LIMITS = {
  version: 32,
  tag: 40,
  publishedAt: 40,
  title: 100,
  summary: 360,
  releaseUrl: 240,
  sectionTitle: 40,
  sectionItem: 220,
};

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function passesSiteValidator(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const ship = value as Record<string, unknown>;
  const sections = ship.sections;
  const commits = ship.sourceCommits;

  if (
    ship.schemaVersion !== 1 ||
    !isBoundedString(ship.version, LIMITS.version) ||
    !isBoundedString(ship.tag, LIMITS.tag) ||
    !isBoundedString(ship.publishedAt, LIMITS.publishedAt) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(ship.publishedAt) ||
    Number.isNaN(Date.parse(ship.publishedAt)) ||
    !isBoundedString(ship.title, LIMITS.title) ||
    !isBoundedString(ship.summary, LIMITS.summary) ||
    !isBoundedString(ship.releaseUrl, LIMITS.releaseUrl) ||
    !ship.releaseUrl.startsWith('https://github.com/hurttlocker/o8/releases/tag/') ||
    !Array.isArray(commits) ||
    commits.length < 1 ||
    commits.length > 50 ||
    !commits.every((item) => typeof item === 'string' && /^[a-f0-9]{7,40}$/i.test(item)) ||
    !Array.isArray(sections) ||
    sections.length < 1 ||
    sections.length > 4
  ) {
    return false;
  }

  return sections.every((section) => {
    if (!section || typeof section !== 'object') return false;
    const candidate = section as Record<string, unknown>;
    return (
      isBoundedString(candidate.title, LIMITS.sectionTitle) &&
      Array.isArray(candidate.items) &&
      candidate.items.length > 0 &&
      candidate.items.length <= 8 &&
      candidate.items.every((item) => isBoundedString(item, LIMITS.sectionItem))
    );
  });
}

describe('latest ship builder', () => {
  it('builds a scrubbed payload that passes the site contract', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-public-release-'));
    roots.push(fixtureRoot);
    const notesPath = join(fixtureRoot, 'next.md');
    writeFileSync(notesPath, [
      '- See the final packet outcome without reopening the lane.',
      '- Codex workers keep their visible terminal state.',
    ].join('\n'));

    const ship = buildLatestShip({
      version: '0.1.739',
      tag: 'v0.1.739',
      publishedAt: '2026-09-06T19:15:00Z',
      releaseUrl: 'https://github.com/hurttlocker/o8/releases/tag/v0.1.739',
      commits: [
        {
          sha: '1234567890abcdef1234567890abcdef12345678',
          subject: 'feat(desktop): show packet outcomes immediately (#2102) [via-o8]',
        },
        {
          sha: '234567890abcdef1234567890abcdef123456789',
          subject: 'perf: reduce dashboard wake latency',
        },
        {
          sha: '34567890abcdef1234567890abcdef1234567890',
          subject: 'fix: keep stale worker states out of review',
        },
        {
          sha: '4567890abcdef1234567890abcdef12345678901',
          subject: 'fix: rotate a leaked password',
        },
        {
          sha: '567890abcdef1234567890abcdef123456789012',
          subject: 'fix: change the worker default to Astra',
        },
      ],
      notesMarkdown: readFileSync(notesPath, 'utf8'),
    });

    expect(passesSiteValidator(ship)).toBe(true);
    expect(ship.title).toBe('Show packet outcomes immediately');
    expect(ship.sections[0]).toEqual({
      title: 'What this ship changes for you',
      items: [
        'See the final packet outcome without reopening the lane.',
        'Agent runtime workers keep their visible terminal state.',
      ],
    });
    expect(ship.sections.map((section) => section.title)).toEqual([
      'What this ship changes for you',
      'Features',
      'Performance',
      'Fixes',
    ]);
    expect(JSON.stringify(ship)).not.toMatch(/password|Astra|\[via-o8\]|Codex/i);
  });
});
