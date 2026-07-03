/**
 * Pipeline root-fix contracts (2026-07-03) — the two predicates that buried
 * review-ready work. These sets ARE the policy; pin them so a future edit
 * that re-adds `reviewing` to the probe set or `silent_exit_work_present` to
 * the terminally-dead set fails loudly with this incident's context.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resetCodexProcessCwdIndexForTesting, setCodexProcessReaderForTesting } from '@/lib/runtimes/shared/codex-process-cwd';
import { resetOwnedSessionIndex } from '@/lib/runtimes/shared/owned-session-index';
import {
  DEAD_LANE_EVENT_LABELS,
  INTERESTING_LANE_STATUSES,
  runSilentExitTickForTesting,
} from './silent-exit-detector';

const { createLane, getLane, updateLane } = await import('@/lib/lane/registry');

let ownedRoot: string | null = null;
let tempWorktree: string | null = null;

function writeOwnedSession(surfaceId: string, activeRun: unknown): void {
  if (!ownedRoot) throw new Error('ownedRoot not initialized');
  const dir = join(ownedRoot, surfaceId.replace(/^codex-owned:/, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ surfaceId, activeRun }));
}

afterEach(() => {
  if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  if (tempWorktree) rmSync(tempWorktree, { recursive: true, force: true });
  ownedRoot = null;
  tempWorktree = null;
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  resetOwnedSessionIndex();
  resetCodexProcessCwdIndexForTesting();
});

describe('silent-exit detector policy (wave-1B burial incident)', () => {
  it('never probes reviewing lanes — a dead process after completion is normal, not a silent exit', () => {
    expect(INTERESTING_LANE_STATUSES.has('reviewing')).toBe(false);
    expect(INTERESTING_LANE_STATUSES.has('running')).toBe(true);
    expect(INTERESTING_LANE_STATUSES.has('awaiting_input')).toBe(true);
  });

  it('never auto-archives work-present lanes — committed work is review-ready, not terminally dead', () => {
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_work_present')).toBe(false);
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_no_work')).toBe(true);
    expect(DEAD_LANE_EVENT_LABELS.has('zombie_reap')).toBe(true);
  });

  it('does not salvage a quiet owned Codex lane when a live codex process is still in its worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'o8-live-codex-wt-'));
    tempWorktree = worktreePath;
    ownedRoot = mkdtempSync(join(tmpdir(), 'o8-owned-codex-'));
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
    resetOwnedSessionIndex();

    const surfaceId = 'codex-owned:test-live-cwd';
    writeOwnedSession(surfaceId, { pid: 2_147_483_647 });
    setCodexProcessReaderForTesting(async () => [{
      pid: 12345,
      command: '/usr/local/bin/codex exec --resume abc',
      cwd: worktreePath,
    }]);

    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/live-cwd',
      runtime: 'codex',
      sessionKey: surfaceId,
      packetId: 'pkt-live-cwd',
    });
    updateLane(lane.id, {
      status: 'running',
      lastEventAt: new Date(Date.now() - 120_000).toISOString(),
      lastEventLabel: 'session_launched',
    });

    await runSilentExitTickForTesting();

    const after = getLane(lane.id);
    expect(after?.status).toBe('running');
    expect(after?.lastEventLabel).toBe('session_launched');
  });
});
