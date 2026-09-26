import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../scripts/roadmap-status.mjs', import.meta.url));
const roadmapPath = fileURLToPath(new URL('../ROADMAP.md', import.meta.url));
const fixtureRoots: string[] = [];

type GhFixture = Record<string, unknown>;

function openNowLinkFixtures(): GhFixture {
  const now = readFileSync(roadmapPath, 'utf8').split(/^## Now\s*$/m)[1]?.split(/^## /m)[0] || '';
  return Object.fromEntries([...now.matchAll(/issues\/(\d+)/g)].map((match) => [
    `repos/example/roadmap/issues/${match[1]}`,
    { state: 'open' },
  ]));
}

function runRoadmapStatus(fixture: GhFixture, check = false) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'o8-roadmap-status-'));
  fixtureRoots.push(fixtureRoot);
  const ghPath = join(fixtureRoot, 'gh');
  writeFileSync(ghPath, [
    '#!/usr/bin/env node',
    "const fixture = JSON.parse(process.env.ROADMAP_GH_FIXTURE || '{}');",
    'const response = fixture[process.argv.at(-1)];',
    "if (response === undefined) throw new Error(`missing gh fixture for ${process.argv.at(-1)}`);",
    'process.stdout.write(JSON.stringify(response));',
  ].join('\n'));
  chmodSync(ghPath, 0o755);

  return spawnSync(process.execPath, [scriptPath, ...(check ? ['--check'] : [])], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixtureRoot}:${process.env.PATH ?? ''}`,
      ROADMAP_REPO: 'example/roadmap',
      ROADMAP_GH_FIXTURE: JSON.stringify(fixture),
    },
  });
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

describe('roadmap status', () => {
  it('uses the issue body checklist for both counts and drift checks', () => {
    const fixture: GhFixture = {
      'repos/example/roadmap/issues?state=open&labels=tracking&per_page=100': [{
        number: 900,
        title: 'tracking issue',
        body: [
          '## Checklist',
          '- [x] #101 shipped child',
          '- [ ] #102 awaiting release',
          '- [x] tracking note without a child issue',
          '## Notes',
          'The checklist ends above.',
          '- [x] #104 checkbox outside the checklist',
        ].join('\n'),
        comments: 1,
      }],
      'repos/example/roadmap/issues/900/comments?per_page=100': [{
        body: '## Checklist\n- [x] #103 conflicting comment child',
      }],
      'repos/example/roadmap/issues/101': { state: 'closed' },
      'repos/example/roadmap/issues/102': { state: 'closed' },
      'repos/example/roadmap/issues/103': { state: 'open' },
      'repos/example/roadmap/issues/104': { state: 'open' },
    };
    Object.assign(fixture, openNowLinkFixtures());

    const display = runRoadmapStatus(fixture);
    expect(display.status).toBe(0);
    expect(display.stdout).toContain('#900');
    expect(display.stdout).toContain('1/2');
    expect(display.stdout).toContain('1 tracking issues, 1 of 2 children shipped.');

    const check = runRoadmapStatus(fixture, true);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('awaiting release:');
    expect(check.stdout).toContain('#900: #102 is closed, box stays open until it ships');
    expect(check.stdout).toContain('roadmap check: no drift.');
    expect(check.stderr).not.toContain('roadmap drift:');
  });

  it('reports a valid body checklist consistently in display and check modes', () => {
    const fixture: GhFixture = {
      'repos/example/roadmap/issues?state=open&labels=tracking&per_page=100': [{
        number: 901,
        title: 'valid tracking issue',
        body: '## Checklist\n- [X] #201 shipped child\n- [ ] #202 active child\n## How to help\nClaim a child.',
        comments: 0,
      }],
      'repos/example/roadmap/issues/201': { state: 'closed' },
      'repos/example/roadmap/issues/202': { state: 'open' },
    };
    Object.assign(fixture, openNowLinkFixtures());

    const display = runRoadmapStatus(fixture);
    expect(display.status).toBe(0);
    expect(display.stdout).toContain('1 tracking issues, 1 of 2 children shipped.');

    const check = runRoadmapStatus(fixture, true);
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('roadmap check: no drift.');
  });

  it('still rejects a checked body child whose issue is open', () => {
    const fixture: GhFixture = {
      ...openNowLinkFixtures(),
      'repos/example/roadmap/issues?state=open&labels=tracking&per_page=100': [{
        number: 902,
        title: 'invalid tracking issue',
        body: '## Checklist\n- [x] #301 incorrectly marked shipped',
        comments: 0,
      }],
      'repos/example/roadmap/issues/301': { state: 'open' },
    };

    const check = runRoadmapStatus(fixture, true);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('1 tracking issues, 1 of 1 children shipped.');
    expect(check.stderr).toContain('#902: checked #301 is open');
    expect(check.stdout).not.toContain('roadmap check: no drift.');
  });
});
