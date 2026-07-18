import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnedRuntimeAdapter, OwnedSessionRecord, ParsedRunLog } from './types';

vi.mock('@/lib/lane/registry', () => ({ listActiveLanes: () => [] }));

function testAdapter(root: string): OwnedRuntimeAdapter {
  return {
    runtimeId: 'state-test',
    surfaceIdPrefix: 'state-owned:',
    rootEnvVar: 'O8_TEST_SESSION_STATE_ROOT',
    rootDefault: root,
    binaryName: 'node',
    binaryEnvOverride: 'O8_TEST_SESSION_STATE_BIN',
    humanLabel: 'Owned State Test',
    squadShortName: 'State Test',
    launchArgs: () => [],
    resumeArgs: () => [],
    parseRunLog: (): ParsedRunLog => ({ entries: [], outcome: 'finished', completedTurn: true }),
  };
}

function writeMetadata(sessionDir: string, surfaceId: string) {
  mkdirSync(sessionDir, { recursive: true });
  const record: OwnedSessionRecord = {
    surfaceId,
    sessionDir,
    cwd: '/tmp',
    repoPath: '/tmp',
    title: surfaceId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestPrompt: '',
    latestSummary: '',
    recentRuns: [],
  };
  writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(record));
}

describe('owned-session store sessionState', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    delete process.env.O8_TEST_SESSION_STATE_ROOT;
    for (const tempRoot of tempRoots.splice(0)) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('distinguishes active, archived, and missing session metadata without mutation', async () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-owned-session-state-'));
    tempRoots.push(tempRoot);
    const root = path.join(tempRoot, 'sessions');
    process.env.O8_TEST_SESSION_STATE_ROOT = root;
    const activeId = 'state-owned:active-id';
    const archivedId = 'state-owned:archived-id';
    writeMetadata(path.join(root, 'active-id'), activeId);
    writeMetadata(path.join(`${root}-archive`, 'archived-id'), archivedId);

    const { createOwnedSessionStore } = await import('./store');
    const store = createOwnedSessionStore(testAdapter(root));

    await expect(store.sessionState(activeId)).resolves.toBe('active');
    await expect(store.sessionState(archivedId)).resolves.toBe('archived');
    await expect(store.sessionState('state-owned:missing-id')).resolves.toBe('missing');

    rmSync(root, { recursive: true, force: true });
    rmSync(`${root}-archive`, { recursive: true, force: true });
    await expect(store.sessionState('state-owned:still-missing')).resolves.toBe('missing');
    expect(existsSync(root)).toBe(false);
    expect(existsSync(`${root}-archive`)).toBe(false);
  });
});
