/**
 * #1585 — the lane zombie reaper must NOT reap a stale-heartbeat lane that is
 * still alive. The lane heartbeat only advances when the worker voluntarily runs
 * `o8 packet heartbeat`, so a Codex worker deep in a multi-minute turn freezes it
 * inside the 90s window while streaming — and the reaper massacred the whole
 * fleet on a single tick.
 *
 * These tests drive the REAL reaper entry point (`listZombieLaneCandidates`)
 * against persisted lanes + on-disk owned-session state so the secondary liveness
 * gates are exercised the way the sidecar tick reaches them (reachability rule):
 *   (a) stale heartbeat + FRESH transcript activity  → survives (not a candidate)
 *   (b) stale heartbeat + a live process cwd'd inside the worktree → survives
 *   (c) genuinely dead (no process, stale/absent transcript) → still reaps (#1292)
 *   (d) live-process probe ERROR → survives, fail-closed (assessStaleLaneLiveness)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCodexProcessCwdIndexForTesting, setCodexProcessReaderForTesting } from '@/lib/runtimes/shared/codex-process-cwd';
import { resetOwnedSessionIndex } from '@/lib/runtimes/shared/owned-session-index';
import * as processCwdSnapshot from '@/lib/runtime/process-cwd-snapshot';

// Point the SQLite store + owned root at temp dirs BEFORE importing the registry.
const testDataDir = mkdtempSync(join(tmpdir(), 'o8-reaper-liveness-'));
const ownedCodexRoot = mkdtempSync(join(tmpdir(), 'o8-owned-codex-liveness-'));
const ownedPiRoot = mkdtempSync(join(tmpdir(), 'o8-owned-pi-liveness-'));
const ownedQwenRoot = mkdtempSync(join(tmpdir(), 'o8-owned-qwen-liveness-'));
process.env.O8_DATA_DIR = testDataDir;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedCodexRoot;
process.env.O8_OWNED_PI_ROOT = ownedPiRoot;
process.env.O8_OWNED_QWEN_ROOT = ownedQwenRoot;

const { createLane, getLane, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const { LANE_HEARTBEAT_STALE_MS, listZombieLaneCandidates } = await import('@/lib/lane/reaper');
const { assessStaleLaneLiveness } = await import('@/lib/lane/reaper-liveness');

const spawnedChildren: ChildProcess[] = [];
const cleanupDirs: string[] = [];

beforeEach(() => {
  // Deterministic: no real codex processes matched via the owner-probe continuity
  // check (which would otherwise shell out to real `ps`).
  setCodexProcessReaderForTesting(async () => []);
});

afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  resetCodexProcessCwdIndexForTesting();
  resetOwnedSessionIndex();
  // Deterministic: no real codex processes matched during these tests.
  setCodexProcessReaderForTesting(async () => []);
});

afterAll(() => {
  for (const dir of [testDataDir, ownedCodexRoot, ownedPiRoot, ownedQwenRoot]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-reaper-liveness-wt-'));
  cleanupDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

/**
 * Write an owned-session dir whose `activeRun` is CLEARED (`{}`) so the owner
 * probe returns `alive:false` — forcing the reaper past the primary probe and
 * into the secondary liveness gates under test. Optionally drop a transcript run
 * log with a controlled mtime.
 */
function writeOwnedSession(
  surfaceId: string,
  opts: { transcriptAgeMs?: number | null; root?: string } = {},
): void {
  const id = surfaceId.replace(/^[^:]+:/, '');
  const dir = join(opts.root ?? process.env.CORTEX_IDE_OWNED_CODEX_ROOT!, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ surfaceId, activeRun: {} }));
  if (opts.transcriptAgeMs != null) {
    const runsDir = join(dir, 'runs');
    mkdirSync(runsDir, { recursive: true });
    const runLog = join(runsDir, 'run-1.jsonl');
    writeFileSync(runLog, '{"type":"item.completed"}\n');
    const when = new Date(Date.now() - opts.transcriptAgeMs);
    utimesSync(runLog, when, when);
  }
  resetOwnedSessionIndex();
}

function makeRunningLane(
  wt: string,
  sessionKey: string,
  now: number,
  runtime: Parameters<typeof createLane>[0]['runtime'] = 'codex',
) {
  const lane = createLane({
    repoPath: wt,
    branch: `pkt/${sessionKey.replace(/[^a-z0-9]/gi, '-')}`,
    runtime,
    worktreePath: wt,
    baseBranch: 'main',
    sessionKey,
    packetId: `pkt-${sessionKey}`,
  });
  setLaneStatus(lane.id, 'running', 'system');
  // Frozen heartbeat well past the stale window (no orchestrator/user status
  // transition, so the actor grace window does not apply).
  updateLane(lane.id, {
    lastHeartbeatAt: now - LANE_HEARTBEAT_STALE_MS - 30_000,
    lastEventLabel: 'session_launched',
  });
  return getLane(lane.id)!;
}

describe('zombie reaper secondary liveness gates (#1585)', () => {
  it('(a) keeps a stale-heartbeat lane with FRESH transcript activity', async () => {
    const wt = makeWorktree();
    const sessionKey = 'codex-owned:reaper-fresh-transcript';
    writeOwnedSession(sessionKey, { transcriptAgeMs: 5_000 }); // streamed 5s ago
    const now = Date.now();
    const lane = makeRunningLane(wt, sessionKey, now);

    const candidates = await listZombieLaneCandidates(now);

    expect(candidates.some((c) => c.lane.id === lane.id)).toBe(false);
    expect(getLane(lane.id)?.status).toBe('running');
  }, 20_000);

  it('(b) keeps a stale-heartbeat lane with a live process cwd inside the worktree', async () => {
    const wt = makeWorktree();
    const sessionKey = 'codex-owned:reaper-live-process';
    writeOwnedSession(sessionKey, { transcriptAgeMs: null }); // no transcript signal
    const now = Date.now();
    const lane = makeRunningLane(wt, sessionKey, now);

    // A real, live process whose cwd is inside the worktree — exactly what a
    // detached `codex exec` worker looks like to `lsof +D`.
    const child = spawn('sleep', ['30'], { cwd: wt, stdio: 'ignore' });
    spawnedChildren.push(child);
    await new Promise((r) => setTimeout(r, 300)); // let it settle in the process table
    const liveProbe = vi.spyOn(processCwdSnapshot, 'hasLiveProcessCwdInside').mockResolvedValue(true);

    const candidates = await listZombieLaneCandidates(now);
    liveProbe.mockRestore();

    expect(candidates.some((c) => c.lane.id === lane.id)).toBe(false);
    expect(getLane(lane.id)?.status).toBe('running');
  }, 20_000);

  it('(c) still reaps a genuinely dead lane — no process, no fresh transcript (#1292 preserved)', async () => {
    const wt = makeWorktree();
    const sessionKey = 'codex-owned:reaper-genuinely-dead';
    // activeRun cleared + transcript aged far past the stale window, no live proc.
    writeOwnedSession(sessionKey, { transcriptAgeMs: LANE_HEARTBEAT_STALE_MS * 10 });
    const now = Date.now();
    const lane = makeRunningLane(wt, sessionKey, now);

    // A saturated full-suite host can make the real 2s lsof probe time out;
    // production correctly keeps the lane fail-closed in that case. This case
    // specifically proves the clean "no process" branch, so make it explicit.
    const liveProbe = vi.spyOn(processCwdSnapshot, 'hasLiveProcessCwdInside').mockResolvedValue(false);
    const candidates = await listZombieLaneCandidates(now);
    liveProbe.mockRestore();

    const candidate = candidates.find((c) => c.lane.id === lane.id);
    expect(candidate).toBeDefined();
    expect(candidate?.reason).toBe('stale_heartbeat');
  }, 20_000);

  it('(d) keeps a lane when the live-process probe throws (fail closed)', async () => {
    const wt = makeWorktree();
    const lane = makeRunningLane(wt, 'codex-owned:reaper-probe-error', Date.now());

    const decision = await assessStaleLaneLiveness(lane, {
      staleThresholdMs: LANE_HEARTBEAT_STALE_MS,
      now: Date.now(),
      probes: {
        transcriptMtimeMs: async () => null,
        liveProcessInside: async () => {
          throw new Error('lsof exploded');
        },
      },
    });

    expect(decision.keep).toBe(true);
    expect(decision.source).toBe('live-process-guard');
    expect(decision.note).toContain('fail-closed');
  });

  it.each([
    ['pi', 'pi-owned:reaper-dead-pi', process.env.O8_OWNED_PI_ROOT!],
    ['qwen', 'qwen-owned:reaper-dead-qwen', process.env.O8_OWNED_QWEN_ROOT!],
  ] as const)('reaps a dead %s owned lane through the real fleet entry', async (runtime, sessionKey, root) => {
    const wt = makeWorktree();
    writeOwnedSession(sessionKey, {
      root,
      transcriptAgeMs: LANE_HEARTBEAT_STALE_MS * 10,
    });
    const now = Date.now();
    const lane = makeRunningLane(wt, sessionKey, now, runtime);
    const liveProbe = vi.spyOn(processCwdSnapshot, 'hasLiveProcessCwdInside').mockResolvedValue(false);

    const candidates = await listZombieLaneCandidates(now);
    liveProbe.mockRestore();

    expect(candidates.find((candidate) => candidate.lane.id === lane.id)?.probe).toMatchObject({
      alive: false,
      source: 'owned-session-registry',
    });
  }, 20_000);
});
