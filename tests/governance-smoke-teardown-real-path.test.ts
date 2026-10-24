import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const lifecycle = vi.hoisted(() => ({
  release: () => {},
  entered: 0,
  completed: 0,
  removedWhilePending: false,
  root: '',
  gate: Promise.resolve(),
  stateAtRemoval: '',
}));

// Hold the actual asynchronous terminal boundary so teardown deterministically
// races it, instead of depending on filesystem speed to reproduce ENOTEMPTY.
vi.mock('@/lib/workspace/manifest/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/manifest/lifecycle')>();
  return {
    ...actual,
    async settleTerminalWorkspaceManifest(input: Parameters<typeof actual.settleTerminalWorkspaceManifest>[0]) {
      lifecycle.entered += 1;
      await lifecycle.gate;
      await actual.settleTerminalWorkspaceManifest(input);
      lifecycle.completed += 1;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (args[0] === lifecycle.root) {
        lifecycle.removedWhilePending = lifecycle.completed < lifecycle.entered;
        lifecycle.stateAtRemoval = JSON.parse(readFileSync(join(lifecycle.root, '.o8', 'workspace-manifest-receipt.json'), 'utf8')).state;
      }
      return actual.rm(...args);
    },
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-governance-teardown-data-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const { createLane, getLane, updateLane } = await import('@/lib/lane/registry');
const { cleanupGovernanceSmokeRepo } = await import('../scripts/lib/governance-smoke-cleanup');
const { beginWorkspaceManifestRun, finishWorkspaceManifestRun, readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest/lifecycle');
const { closeDb } = await import('@/lib/db');
const { waitForTerminalLaneWork } = await import('@/lib/lane/terminal-work');
const roots: string[] = [];
const runs: Array<Parameters<typeof finishWorkspaceManifestRun>[0]> = [];

afterAll(async () => {
  lifecycle.release();
  await waitForTerminalLaneWork();
  for (const run of runs) finishWorkspaceManifestRun(run);
  closeDb();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

it.each(['completed', 'failed'] as const)('drains work scheduled by a persisted %s transition before deleting the smoke repository', async (status) => {
  lifecycle.entered = 0;
  lifecycle.completed = 0;
  lifecycle.removedWhilePending = false;
  lifecycle.root = mkdtempSync(join(tmpdir(), 'o8-governance-teardown-repo-'));
  roots.push(lifecycle.root);
  lifecycle.gate = new Promise<void>((resolve) => { lifecycle.release = resolve; });
  const lane = createLane({
    repoPath: lifecycle.root,
    branch: 'lane/teardown',
    baseBranch: 'main',
    runtime: 'codex',
    label: 'Smoke teardown',
    actor: 'system',
  });
  const run = await beginWorkspaceManifestRun({ worktreePath: lifecycle.root, packetId: `lane:${lane.id}`, laneId: lane.id, manifestHash: 'a'.repeat(64) });
  runs.push(run);
  expect((await readWorkspaceManifestReceipt(lifecycle.root))?.state).toBe('running');
  updateLane(lane.id, { status }, 'system');
  expect(getLane(lane.id)?.status).toBe(status);
  expect(lifecycle.entered).toBe(status === 'completed' ? 2 : 1);

  const cleanup = cleanupGovernanceSmokeRepo(lifecycle.root);
  // The unfixed cleanup starts rm immediately. A drain waits at the held
  // boundary; either way this microtask releases the fixture deterministically.
  lifecycle.release();
  await cleanup;
  expect(lifecycle.removedWhilePending).toBe(false);
  expect(lifecycle.completed).toBe(lifecycle.entered);
  expect(lifecycle.stateAtRemoval).toBe('cancelled');
  finishWorkspaceManifestRun(run);
  expect(existsSync(lifecycle.root)).toBe(false);
  // The lane remains durable; teardown never changes governance state.
  expect(getLane(lane.id)?.status).toBe(status);
  expect(readFileSync(join(dataDir, 'cortex-ide.db')).length).toBeGreaterThan(0);
});
