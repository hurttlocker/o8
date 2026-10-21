import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session/store';
import type { OwnedRuntimeAdapter, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { probeOwnedRunMarker, probeOwnedRunProcessClaim } from '@/lib/runtimes/shared/owned-session/run-process-proof';
import { registerOwnedSessionLifecycleHandler } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';

const roots: string[] = [];
const children = new Map<number, string>();

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Owned marker fixture did not settle.');
}

afterEach(async () => {
  for (const [pid, marker] of children) {
    const identity = await probeOwnedRunProcessClaim({ pid, marker, rootPid: null });
    if (identity.state === 'match') {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('owned marker scan through persisted run identity', () => {
  it('finds an escaped descendant after its leader exits and clears only after that descendant exits', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'o8-owned-marker-proof-'));
    roots.push(root);
    const workspace = path.join(root, 'workspace');
    const sessionRoot = path.join(root, 'sessions');
    const sessionDir = path.join(sessionRoot, 'session');
    const pidFile = path.join(root, 'escaped.pid');
    mkdirSync(workspace);
    mkdirSync(sessionDir, { recursive: true });
    const marker = randomUUID();
    const childScript = [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
      'setInterval(() => {}, 1_000)',
    ].join(';');
    const leaderScript = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio: 'ignore' })`,
      'child.unref()',
    ].join(';');
    const leader = spawn(process.execPath, ['-e', leaderScript], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, O8_OWNED_RUN_MARKER: marker },
    });
    const leaderPid = leader.pid!;
    expect(leaderPid).toBeGreaterThan(0);
    await once(leader, 'exit');
    await waitFor(() => existsSync(pidFile));
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    children.set(childPid, marker);
    expect(childPid).toBeGreaterThan(0);
    expect(childPid).not.toBe(leaderPid);

    const surfaceId = `marker-proof-${marker}:session`;
    const now = new Date().toISOString();
    const session: OwnedSessionRecord = {
      surfaceId,
      sessionDir,
      cwd: workspace,
      repoPath: workspace,
      workspaceBinding: {
        logicalWorkspaceId: 'packet:marker-proof',
        repositoryUuid: 'marker-proof-repo',
        packetId: 'marker-proof',
        cwd: workspace,
        version: 1,
        verifiedAt: now,
      },
      title: 'escaped owned marker fixture',
      createdAt: now,
      updatedAt: now,
      latestPrompt: 'fixture',
      latestSummary: 'fixture',
      recentRuns: [{
        id: marker,
        mode: 'launch',
        prompt: 'fixture',
        startedAt: now,
        finishedAt: now,
        pid: leaderPid,
        commandIdentity: path.basename(process.execPath),
        processGroupId: leaderPid,
        processMarker: marker,
        spawnState: 'started',
        detachMode: 'detached',
        stdoutPath: path.join(sessionDir, 'run.jsonl'),
        stderrPath: path.join(sessionDir, 'run.stderr'),
        outcome: 'finished',
      }],
      runIdentityLedger: { version: 1, totalRuns: 1, complete: true },
    };
    writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(session));
    const adapter: OwnedRuntimeAdapter = {
      runtimeId: `marker-proof-${marker}`,
      surfaceIdPrefix: `marker-proof-${marker}:`,
      rootEnvVar: `O8_TEST_MARKER_ROOT_${marker.replaceAll('-', '_')}`,
      rootDefault: sessionRoot,
      binaryName: 'node',
      binaryEnvOverride: 'O8_TEST_MARKER_BINARY',
      humanLabel: 'Marker proof fixture',
      squadShortName: 'MarkerProof',
      launchArgs: () => [],
      resumeArgs: () => [],
      parseRunLog: () => ({ entries: [], outcome: 'finished', completedTurn: true }),
    };
    const store = createOwnedSessionStore(adapter);
    registerOwnedSessionLifecycleHandler({
      runtimeId: adapter.runtimeId,
      surfaceIdPrefix: adapter.surfaceIdPrefix,
      commandLabel: 'marker-proof',
      resolveRoot: () => sessionRoot,
      sessionState: (id) => store.sessionState(id),
      archiveSession: (id) => store.archiveSession(id),
      getWorkspaceBinding: (id) => store.getWorkspaceBinding!(id),
      rebindWorkspace: (id, input) => store.rebindWorkspace!(id, input),
    });
    expect(await store.getWorkspaceBinding!(surfaceId)).toMatchObject({
      retainedRunsComplete: true,
      retainedRunTotal: 1,
      retainedRuns: [{ processMarker: marker, pid: leaderPid }],
    });
    expect(await probeOwnedRunMarker(marker)).toBe('live');
    const live = await probeOwnedSessionProcessQuiescence(surfaceId, workspace);
    expect(live.state).toBe('live');
    expect(live.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ primitive: 'pid', state: 'clear' }),
      expect.objectContaining({ primitive: 'process_group', state: 'clear' }),
      expect.objectContaining({ primitive: 'descendants', state: 'clear' }),
      expect.objectContaining({ primitive: 'owned_marker', state: 'live', pids: [childPid] }),
    ]));
    expect(existsSync(path.join(sessionDir, 'session.json'))).toBe(true);

    process.kill(childPid, 'SIGTERM');
    await waitFor(async () => await probeOwnedRunMarker(marker) === 'clear');
    children.delete(childPid);
    const clear = await probeOwnedSessionProcessQuiescence(surfaceId, workspace);
    expect(clear.state).toBe('quiescent');
    expect(clear.probes).toContainEqual(expect.objectContaining({ primitive: 'owned_marker', state: 'clear' }));
    expect(existsSync(path.join(sessionDir, 'session.json'))).toBe(true);
  }, 15_000);
});
