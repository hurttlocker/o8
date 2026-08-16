import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-workspace-lifecycle-real-path-'));
const worktreeRoot = path.join(dataDir, 'worktrees');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;

const { closeDb } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');

const routeChildScript = String.raw`
void (async () => {
  const importedLifecycle = await import('./src/lib/runtimes/shared/owned-session-lifecycle.ts');
  const { registerOwnedSessionLifecycleHandler } = importedLifecycle.default ?? importedLifecycle;
  const surfaceId = process.env.O8_TEST_SURFACE_ID;
  const packetId = process.env.O8_TEST_PACKET_ID;
  const workspacePath = process.env.O8_TEST_WORKSPACE_PATH;
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'codex',
    surfaceIdPrefix: 'cross-process-owned:',
    commandLabel: 'test-owned',
    resolveRoot: () => process.env.O8_DATA_DIR,
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => ({
      surfaceId,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: 'packet:' + packetId,
        repositoryUuid: process.env.O8_TEST_REPO_ID,
        packetId,
        cwd: workspacePath,
        version: 1,
        verifiedAt: new Date().toISOString(),
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    }),
    rebindWorkspace: async () => ({ rebound: true, binding: null }),
  });
  const importedNext = await import('next/server');
  const { NextRequest } = importedNext.default ?? importedNext;
  const importedFs = await import('node:fs');
  const { readFileSync } = importedFs.default ?? importedFs;
  const importedRoute = await import('./src/app/api/orchestrator/workspace/route.ts');
  const { POST } = importedRoute.default ?? importedRoute;
  process.stdout.write('O8_ROUTE_ATTEMPT\n');
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/workspace', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-o8-client-addr': '127.0.0.1',
      authorization: 'Bearer ' + readFileSync(process.env.O8_DATA_DIR + '/ws-token', 'utf8').trim(),
    },
    body: JSON.stringify({
      action: 'park',
      packetId,
      clientMutationId: 'cross-process-real-route',
    }),
  }));
  process.stdout.write('O8_ROUTE_RESULT ' + response.status + ' ' + await response.text() + '\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

const reconcilerChildScript = String.raw`
void (async () => {
  const imported = await import('./src/lib/workspace/reconciler.ts');
  const { reconcileInterruptedWorkspaces } = imported.default ?? imported;
  process.stdout.write('O8_RECONCILER_READY\n');
  await new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.resume();
  });
  process.stdout.write('O8_RECONCILER_ATTEMPT\n');
  const result = await reconcileInterruptedWorkspaces();
  process.stdout.write('O8_RECONCILER_RESULT ' + JSON.stringify(result) + '\n');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

class ChildOutput {
  stdout = '';
  stderr = '';

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => { this.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  async waitFor(marker: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stdout.includes(marker)) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Child exited before ${marker}: ${this.stdout}${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out before ${marker}: ${this.stdout}${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null) return Promise.resolve(this.child.exitCode);
    if (this.child.signalCode !== null) return Promise.resolve(null);
    return new Promise((resolve) => this.child.once('exit', resolve));
  }
}

function launch(script: string, env: Record<string, string>): ChildOutput {
  const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
  const child = spawn(path.join(process.cwd(), 'node_modules/.bin/tsx'), ['--eval', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      NODE_OPTIONS: [inheritedNodeOptions, '--conditions=react-server'].filter(Boolean).join(' '),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new ChildOutput(child);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function waitForSnapshotState(
  repositoryUuid: string,
  packetId: string,
  state: string,
  route?: ChildOutput,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (getWorkspaceSnapshot(repositoryUuid, packetId)?.state !== state) {
    if (route?.stdout.includes('O8_ROUTE_RESULT')) {
      throw new Error(`Route settled before workspace state ${state}: ${route.stdout}${route.stderr}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace state ${state}: ${route?.stdout ?? ''}${route?.stderr ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('workspace lifecycle cross-process real path', () => {
  it('orders the real workspace POST ahead of the real startup reconciler', async () => {
    const repoPath = path.join(dataDir, 'repo');
    mkdirSync(repoPath);
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.email', 'o8-test@example.test');
    git(repoPath, 'config', 'user.name', 'o8 test');
    writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
    git(repoPath, 'add', '.gitignore', 'tracked.txt');
    git(repoPath, 'commit', '-qm', 'base');

    const packetId = 'packet-cross-process-real-route';
    const worktreeId = `packet-${packetId}`;
    const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    const branch = `inline/${packetId}`;
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(worktreePath, 'tracked.txt'), 'reviewed packet\n');
    git(worktreePath, 'add', 'tracked.txt');
    git(worktreePath, 'commit', '-qm', 'reviewed packet');
    const materializationIdentity = await captureWorktreeMaterializationIdentity(worktreePath);
    const materializationParentIdentity = await captureWorktreeMaterializationIdentity(
      path.dirname(worktreePath),
    );
    writeFileSync(path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId,
          agentType: 'codex',
          sessionKey: 'cross-process-owned:session',
          baseBranch: 'main',
          createdAt: 1,
          claudeManaged: false,
          taskName: worktreeId,
          branchName: branch,
          status: 'ready',
          isolationKind: 'git-worktree',
          materializationIdentity,
          materializationParentIdentity,
        },
      },
    }));

    const repo = await addRepo(repoPath);
    const lane = createLane({
      repoPath: repo.localPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      ownership: 'managed',
      sessionKey: 'cross-process-owned:session',
      worktreePath,
    });
    setLaneStatus(lane.id, 'reviewing');

    const sharedEnv = {
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_WORKTREE_ROOT: worktreeRoot,
      O8_TEST_PACKET_ID: packetId,
      O8_TEST_REPO_ID: repo.id,
      O8_TEST_SURFACE_ID: 'cross-process-owned:session',
      O8_TEST_WORKSPACE_PATH: worktreePath,
    };
    const reconciler = launch(reconcilerChildScript, sharedEnv);
    await reconciler.waitFor('O8_RECONCILER_READY');
    const route = launch(routeChildScript, sharedEnv);
    await route.waitFor('O8_ROUTE_ATTEMPT');
    await waitForSnapshotState(repo.id, packetId, 'hibernating', route);

    reconciler.child.stdin.end('reconcile\n');
    await reconciler.waitFor('O8_RECONCILER_ATTEMPT');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(reconciler.stdout).not.toContain('O8_RECONCILER_RESULT');
    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('hibernating');

    await route.waitFor('O8_ROUTE_RESULT 200');
    expect(await route.waitForExit()).toBe(0);
    await reconciler.waitFor('O8_RECONCILER_RESULT');
    expect(await reconciler.waitForExit()).toBe(0);

    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('parked');
    expect(reconciler.stdout).toContain('"toState":"parked"');
    expect(reconciler.stdout).toContain('"disposition":"unchanged"');
  }, 60_000);
});
