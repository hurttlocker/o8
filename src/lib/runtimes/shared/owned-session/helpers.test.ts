import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  filterStderrNoise,
  repoSlugFromOrigin,
  writeJsonFile,
} from './helpers';

describe('repoSlugFromOrigin', () => {
  it('parses https and ssh GitHub remotes', () => {
    expect(repoSlugFromOrigin('https://github.com/hurttlocker/cortex-ide.git')).toBe('hurttlocker/cortex-ide');
    expect(repoSlugFromOrigin('https://github.com/hurttlocker/cortex-ide')).toBe('hurttlocker/cortex-ide');
    expect(repoSlugFromOrigin('git@github.com:hurttlocker/cortex-ide.git')).toBe('hurttlocker/cortex-ide');
  });

  it('returns undefined for non-GitHub or empty origins', () => {
    expect(repoSlugFromOrigin('https://gitlab.com/team/repo.git')).toBeUndefined();
    expect(repoSlugFromOrigin('')).toBeUndefined();
    expect(repoSlugFromOrigin(undefined)).toBeUndefined();
  });
});

describe('filterStderrNoise', () => {
  it('drops lines matching noise patterns and keeps the rest', () => {
    const raw = 'real error: spawn failed\nrmcp::transport::worker something worker quit\nsecond real line';
    const filtered = filterStderrNoise(raw, [/rmcp::transport::worker.*worker quit/i]);
    expect(filtered).toBe('real error: spawn failed\nsecond real line');
  });

  it('returns input untouched when no patterns are supplied', () => {
    expect(filterStderrNoise('anything\nat all', [])).toBe('anything\nat all');
  });
});

describe('writeJsonFile', () => {
  let tmpDir: string | null = null;

  afterAll(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes parseable JSON and leaves no .tmp files behind', async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'o8-helpers-test-'));
    const target = path.join(tmpDir, 'session.json');

    await writeJsonFile(target, { surfaceId: 'codex-owned:abc', retryCount: 2 });
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    expect(parsed).toEqual({ surfaceId: 'codex-owned:abc', retryCount: 2 });

    // Overwrite must replace atomically (write-then-rename), not append/tear.
    await writeJsonFile(target, { surfaceId: 'codex-owned:abc', retryCount: 3 });
    const reparsed = JSON.parse(await readFile(target, 'utf8'));
    expect(reparsed.retryCount).toBe(3);

    const leftovers = (await readdir(tmpDir)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
