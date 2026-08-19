/**
 * Changed-cwd scenario for the PROCESS adversarial matrix (thin-workspaces).
 *
 * process-probes.ts identity primitives (pid / process_group / descendants /
 * owned_marker / tmux / runtime) key off PID, process-group id, command-line
 * substring, and env markers — never off a process's current working
 * directory. `filesystem_users` is the one primitive that IS cwd-sensitive:
 * it shells out to `lsof -Fn +D <workspacePath>`, which reports ANY process
 * with an open file (including its cwd) under that path, with no ownership
 * filter. Because `synthesizeProcessQuiescence` treats "positive liveness
 * wins" (any 'live' probe forces overall state 'live'), the design is:
 *
 *   1. A workspace-owned process that chdir's AWAY from the workspace must
 *      still be found live — via pid/process-group, not cwd.
 *   2. An unrelated process that chdir's INTO the workspace must also block
 *      parking — fail-closed, not ownership-scoped, by filesystem_users.
 *
 * Both cases use REAL spawned children and the REAL `run` (execFile-backed
 * ps/pgrep/lsof) — a mocked `run` would only prove the mock's shape agrees
 * with itself, not that the OS-level probes actually behave this way.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';
import { probeOwnedSessionProcessQuiescence } from './process-probes';

function register(prefix: string, receipt: OwnedWorkspaceBindingReceipt): void {
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'cwd-probe-test',
    surfaceIdPrefix: prefix,
    commandLabel: 'cwd-probe-test',
    resolveRoot: () => '/tmp/cwd-probe-test',
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => receipt,
    rebindWorkspace: async () => ({ status: 'missing', receipt: null, note: 'unused' }),
  });
}

/** Spawn a detached (own-process-group) real child that chdir's on start, then idles. */
function spawnChdirChild(targetCwd: string, marker: string): Promise<{ pid: number; kill: () => void }> {
  const script = `process.chdir(${JSON.stringify(targetCwd)});setInterval(()=>{},1000);process.send('ready');`;
  const child = spawn(process.execPath, ['-e', script, marker], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.on('message', () => resolve({
      pid: child.pid as number,
      kill: () => { try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* already gone */ } },
    }));
    child.on('error', reject);
  });
}

describe('changed cwd (PROCESS matrix)', () => {
  it('still finds a workspace-owned process live after it chdirs AWAY from the workspace', async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cwd-probe-ws-'));
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cwd-probe-outside-'));
    const marker = 'O8_CWD_TEST_OWNED_AWAY';
    const child = await spawnChdirChild(outsideDir, marker);
    try {
      const surfaceId = 'cwd-owned-away:session';
      register('cwd-owned-away:', {
        surfaceId,
        runtimeId: 'cwd-probe-test',
        sessionState: 'active',
        binding: {
          logicalWorkspaceId: 'packet:cwd-owned-away',
          repositoryUuid: 'repo-cwd',
          packetId: 'packet-cwd-owned-away',
          cwd: workspaceDir,
          version: 1,
          verifiedAt: new Date().toISOString(),
        },
        activeRun: { pid: child.pid, processGroupId: child.pid, commandIdentity: marker },
        retainedRuns: [{
          id: 'owned-away-run',
          outcome: 'running',
          pid: child.pid,
          processGroupId: child.pid,
          commandIdentity: marker,
        }],
        retainedRunsComplete: true,
        retainedRunTotal: 1,
      });

      const receipt = await probeOwnedSessionProcessQuiescence(surfaceId, workspaceDir);

      // Fail-closed: the owned process is still alive, so parking must refuse
      // (hibernator.ts only parks when state === 'quiescent').
      expect(receipt.state).toBe('live');
      // And specifically via pid/process-group identity, cwd-independent —
      // NOT via filesystem_users, which has nothing to find outside the
      // workspace. This pins the mechanism, not just the outcome.
      expect(receipt.probes).toContainEqual(expect.objectContaining({ primitive: 'pid', state: 'live' }));
      expect(receipt.probes).toContainEqual(expect.objectContaining({ primitive: 'filesystem_users', state: 'clear' }));
    } finally {
      child.kill();
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 15_000);

  it('still blocks parking when an UNRELATED process chdirs into the workspace (fail-closed, not ownership-scoped)', async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), 'o8-cwd-probe-ws-'));
    const marker = 'O8_CWD_TEST_UNRELATED_INTO';
    const child = await spawnChdirChild(workspaceDir, marker);
    try {
      const surfaceId = 'cwd-unrelated-into:session';
      register('cwd-unrelated-into:', {
        surfaceId,
        runtimeId: 'cwd-probe-test',
        sessionState: 'active',
        binding: {
          logicalWorkspaceId: 'packet:cwd-unrelated-into',
          repositoryUuid: 'repo-cwd',
          packetId: 'packet-cwd-unrelated-into',
          cwd: workspaceDir,
          version: 1,
          verifiedAt: new Date().toISOString(),
        },
        // No retained runs at all — this process is not tracked as ours.
        activeRun: null,
        retainedRuns: [],
        retainedRunsComplete: true,
        retainedRunTotal: 0,
      });

      const receipt = await probeOwnedSessionProcessQuiescence(surfaceId, workspaceDir);

      // The unrelated process is not in the retained-run ledger at all, yet
      // its wandered-in cwd still blocks parking. This is the documented
      // "positive liveness wins" design (synthesizeProcessQuiescence), not
      // ownership-scoped attribution — pinned here as intended fail-closed
      // behavior, not a bug.
      expect(receipt.state).toBe('live');
      expect(receipt.probes).toContainEqual(expect.objectContaining({
        primitive: 'filesystem_users',
        state: 'live',
        pids: [child.pid],
      }));
    } finally {
      child.kill();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 15_000);
});
