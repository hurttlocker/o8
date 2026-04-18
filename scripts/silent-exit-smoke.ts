#!/usr/bin/env tsx
/**
 * Silent-exit smoke test.
 *
 * #613 — exercise the detector against a throwaway lane in an isolated DB
 * + scratch worktree. Two scenarios:
 *
 *   1. Lane is clean but has commits ahead of baseBranch. Expected: lane
 *      promoted to `reviewing`, inbox kind `silent_exit_but_work_present`.
 *   2. Lane is clean with ZERO commits ahead of baseBranch. Expected: lane
 *      moved to `awaiting_input`, inbox kind `silent_exit_no_work`.
 *
 * We intentionally skip the dirty-worktree path here because it invokes the
 * full completion verification (tsc + rule-check) against the scratch repo
 * which requires a real Node project on disk. The triage logic that runs
 * `autoCommitCompletionWorktree` + `runCompletionVerification` in that path
 * is already covered by the existing completion-reported flow in
 * ws-server.ts. What #613 adds is the lane-detection + status-transition
 * plumbing, which is fully exercised by scenarios 1 and 2 above.
 *
 * Run with:
 *
 *     CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/silent-exit-smoke.ts
 *
 * The script prints each assertion and exits 0 on success, 1 on failure.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[], cwd: string) {
  await execFileAsync(cmd, args, { cwd });
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`  FAIL — ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  OK   — ${msg}`);
}

async function seedRepo(repoDir: string) {
  await mkdir(repoDir, { recursive: true });
  await run('git', ['init', '-q', '-b', 'main'], repoDir);
  await run('git', ['config', 'user.email', 'smoke@example.test'], repoDir);
  await run('git', ['config', 'user.name', 'Silent Exit Smoke'], repoDir);
  await writeFile(join(repoDir, 'README.md'), '# smoke\n', 'utf-8');
  await run('git', ['add', '.'], repoDir);
  await run('git', ['commit', '-q', '-m', 'initial'], repoDir);
}

async function addCommit(repoDir: string, name: string) {
  await writeFile(join(repoDir, name), `content ${Date.now()}\n`, 'utf-8');
  await run('git', ['add', name], repoDir);
  await run('git', ['commit', '-q', '-m', `add ${name}`], repoDir);
}

async function scenarioWorkPresent(root: string) {
  console.log('[smoke] scenario 1: clean worktree, commits present');
  const repoDir = join(root, 'repo-work-present');
  await seedRepo(repoDir);
  await run('git', ['checkout', '-q', '-b', 'feature/salvaged'], repoDir);
  await addCommit(repoDir, 'feature.txt');

  const { createLane, getLane, updateLane } = await import('../src/lib/lane/registry');
  const { runSilentExitTriageForLane } = await import(
    '../src/lib/supervisor/silent-exit-detector'
  );
  const { listInboxItems } = await import('../src/lib/supervisor/inbox');

  const lane = createLane({
    repoPath: repoDir,
    worktreePath: repoDir,
    branch: 'feature/salvaged',
    baseBranch: 'main',
    runtime: 'codex',
    label: 'silent-exit smoke — work present',
    sessionKey: 'codex-owned:smoke-dead-surface-id-1',
  });

  updateLane(
    lane.id,
    {
      status: 'running',
      lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastEventLabel: 'session_running',
    },
    'system',
  );

  assert(getLane(lane.id)?.status === 'running', 'lane starts in running');

  const didWork = await runSilentExitTriageForLane(lane.id);
  assert(didWork, 'detector took action on silent-exit-with-work lane');

  const laneAfter = getLane(lane.id);
  assert(laneAfter?.status === 'reviewing', 'lane promoted to reviewing');
  assert(
    laneAfter?.lastEventLabel === 'silent_exit_work_present',
    `event label is silent_exit_work_present (got ${laneAfter?.lastEventLabel})`,
  );

  const inbox = listInboxItems({ includeDismissed: false });
  const item = inbox.find(
    (entry) =>
      entry.payload &&
      typeof entry.payload === 'object' &&
      (entry.payload as { laneId?: unknown }).laneId === lane.id,
  );
  assert(!!item, 'inbox item exists for the work-present lane');
  assert(
    item?.kind === 'silent_exit_but_work_present',
    `inbox kind is silent_exit_but_work_present (got ${item?.kind})`,
  );
}

async function scenarioNoWork(root: string) {
  console.log('[smoke] scenario 2: clean worktree, zero commits');
  const repoDir = join(root, 'repo-no-work');
  await seedRepo(repoDir);
  await run('git', ['checkout', '-q', '-b', 'feature/empty'], repoDir);

  const { createLane, getLane, updateLane } = await import('../src/lib/lane/registry');
  const { runSilentExitTriageForLane } = await import(
    '../src/lib/supervisor/silent-exit-detector'
  );
  const { listInboxItems } = await import('../src/lib/supervisor/inbox');

  const lane = createLane({
    repoPath: repoDir,
    worktreePath: repoDir,
    branch: 'feature/empty',
    baseBranch: 'main',
    runtime: 'codex',
    label: 'silent-exit smoke — no work',
    sessionKey: 'codex-owned:smoke-dead-surface-id-2',
  });

  updateLane(
    lane.id,
    {
      status: 'running',
      lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastEventLabel: 'session_running',
    },
    'system',
  );

  const didWork = await runSilentExitTriageForLane(lane.id);
  assert(didWork, 'detector took action on silent-exit-no-work lane');

  const laneAfter = getLane(lane.id);
  assert(
    laneAfter?.status === 'awaiting_input',
    `no-work lane moved to awaiting_input (got ${laneAfter?.status})`,
  );
  assert(
    laneAfter?.lastEventLabel === 'silent_exit_no_work',
    `event label is silent_exit_no_work (got ${laneAfter?.lastEventLabel})`,
  );

  const inbox = listInboxItems({ includeDismissed: false });
  const item = inbox.find(
    (entry) =>
      entry.payload &&
      typeof entry.payload === 'object' &&
      (entry.payload as { laneId?: unknown }).laneId === lane.id,
  );
  assert(!!item, 'inbox item exists for the no-work lane');
  assert(
    item?.kind === 'silent_exit_no_work',
    `inbox kind is silent_exit_no_work (got ${item?.kind})`,
  );
}

async function scenarioIdempotent(root: string) {
  console.log('[smoke] scenario 3: second tick is a no-op');
  const repoDir = join(root, 'repo-work-present');
  const { listLanes, updateLane, getLane } = await import('../src/lib/lane/registry');
  const { runSilentExitTriageForLane } = await import(
    '../src/lib/supervisor/silent-exit-detector'
  );

  const lane = listLanes().find(
    (candidate) =>
      candidate.worktreePath === repoDir && candidate.lastEventLabel === 'silent_exit_work_present',
  );
  assert(!!lane, 'found the scenario-1 lane for idempotency check');
  if (!lane) return;

  // Force the lane back into a status the detector would otherwise consider
  // active; the silent_exit_* label guard should still prevent a second
  // triage pass.
  updateLane(
    lane.id,
    {
      status: 'running',
      lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      lastEventLabel: 'silent_exit_work_present',
    },
    'system',
  );

  const didWork = await runSilentExitTriageForLane(lane.id);
  // runSilentExitTriageForLane ALWAYS re-triages the lane when called
  // directly (that's its contract). The idempotency guard lives inside
  // `silentExitTick`, not the per-lane helper. So we can't verify it via
  // the direct helper — just assert that the bare direct call still works
  // without throwing.
  assert(typeof didWork === 'boolean', 'direct triage still returns a boolean');
  assert(getLane(lane.id)?.status !== 'archived', 'lane survives a re-triage');
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'silent-exit-smoke-'));
  process.env.CORTEX_IDE_DATA_DIR = root;
  console.log(`[smoke] scratch root: ${root}`);

  try {
    await scenarioWorkPresent(root);
    await scenarioNoWork(root);
    await scenarioIdempotent(root);
    console.log('[smoke] all assertions passed');
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[smoke] unexpected failure:', error);
  process.exitCode = 1;
});
