/**
 * #1500 — a verification-failed respawn must carry the violation forward.
 *
 * The incident: a worker finished + committed, silent-exited, the silent-exit
 * detector's rule check failed (file-ceiling growth), and the packet was then
 * respawned with the IDENTICAL brief four more times. Three gaps compounded:
 *
 *   1. buildPacketPrompt only read learnings when `attemptCount > 0`, and the
 *      silent-exit path never bumped attemptCount.
 *   2. Learnings lived only in the OLD worktree; a respawn's fresh clone had
 *      no learnings file.
 *   3. Rule-check violation text rarely contains the word "error", so the
 *      learning summary collapsed to a generic retry note.
 *
 * These tests drive the REAL entry points (buildPacketPrompt, the detector's
 * triage via runSilentExitTriageForLane) against persisted state — not the
 * attempt-log helpers in isolation.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/supervisor/completion-verification', () => ({
  runCompletionVerification: vi.fn(async () => ({
    ok: false,
    kind: 'rule-check' as const,
    output: 'Rule check failed: src/lib/operator/defaults.ts grew from 700 to 940 lines, exceeding the 800-line ceiling. Decompose before adding logic.',
  })),
  autoCommitCompletionWorktree: vi.fn(async () => true),
  hasReviewableCompletionDiff: vi.fn(async () => true),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-attempt-learnings-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { buildAttemptLearningFromFailure, persistAttemptLearnings, readPacketAttemptLearnings } = await import('@/lib/orchestrator/attempt-log');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { createLane } = await import('@/lib/lane/registry');
const { runSilentExitTriageForLane } = await import('@/lib/supervisor/silent-exit-detector');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@o8.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'o8 test']);
  writeFileSync(join(dir, 'README.md'), 'seed\n', 'utf8');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'seed']);
}

function packetFixture(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'pkt-1500-1',
    referenceLabel: 'PKT-1500',
    title: 'feat wire the thing',
    summary: 'Do the thing.',
    status: 'queued',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: '2026-07-18T00:00:00.000Z',
    lastEventLabel: 'created',
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    orchestratorThreadId: null,
    ...overrides,
  } as OrchestratorPacket;
}

const RULE_VIOLATION = 'Rule check failed: src/lib/operator/defaults.ts grew from 700 to 940 lines, exceeding the 800-line ceiling. Decompose before adding logic.';

describe('#1500 — verification-failure learnings reach the respawn prompt', () => {
  it('keeps rule-check violation text (no "error" keyword) in the learning summary', () => {
    const learning = buildAttemptLearningFromFailure(RULE_VIOLATION);
    expect(learning.summary).toContain('800-line ceiling');
  });

  it('carries closure claims and residual risk into the next attempt learning', () => {
    const learning = buildAttemptLearningFromFailure(undefined, {
      passed: false,
      confidence: 'medium',
      summary: 'The route fix is incomplete.',
      outcome: 'The request reaches the service.',
      evidence: ['The route fixture passed.'],
      residual: 'The provider response is still ambiguous.',
      decision: 'partial',
      recurrenceProtection: 'A route regression test covers the verified branch.',
    });

    expect(learning.selfReviewSummary).toContain('Outcome: The request reaches the service.');
    expect(learning.selfReviewSummary).toContain('Evidence: The route fixture passed.');
    expect(learning.selfReviewSummary).toContain('Residual: The provider response is still ambiguous.');
    expect(learning.selfReviewSummary).toContain('Decision: partial');
  });

  it('a fresh-worktree respawn prompt at attemptCount 0 still carries the prior violation', async () => {
    const oldWorktree = tempDir('o8-wt-old-');
    const freshWorktree = tempDir('o8-wt-fresh-');

    await persistAttemptLearnings(oldWorktree, 'pkt-1500-1', 1, buildAttemptLearningFromFailure(RULE_VIOLATION));
    // Simulate the respawn: the old worktree is gone, the new one is a clean clone.
    rmSync(oldWorktree, { recursive: true, force: true });

    const prompt = await buildPacketPrompt(packetFixture(), [], 'main', freshWorktree);
    expect(prompt).toContain('800-line ceiling');
  });

  it('the silent-exit detector persists the violation as a packet learning and bumps attemptCount', async () => {
    const repo = tempDir('o8-repo-1500-');
    initGitRepo(repo);
    // Dirty worktree so triage takes the salvage → verification branch.
    writeFileSync(join(repo, 'work.ts'), 'export const x = 1;\n', 'utf8');
    mkdirSync(join(dataDir, 'noop'), { recursive: true });

    const state = createEmptyOrchestratorMissionState();
    state.packets.push(packetFixture({ id: 'pkt-1500-detector', status: 'running', queueState: 'queued' }));
    writeOrchestratorControlPlaneState(state);

    const lane = createLane({
      repoPath: repo,
      branch: 'main',
      baseBranch: 'main',
      runtime: 'codex',
      label: 'pkt-1500 detector lane',
      packetId: 'pkt-1500-detector',
      worktreePath: repo,
      sessionKey: 'codex-owned:pkt-1500-detector',
    });

    const acted = await runSilentExitTriageForLane(lane.id);
    expect(acted).toBe(true);

    const learnings = await readPacketAttemptLearnings('pkt-1500-detector');
    expect(learnings.length).toBeGreaterThan(0);
    expect(learnings[0]?.summary).toContain('800-line ceiling');

    const persisted = readOrchestratorControlPlaneState();
    const packet = persisted.packets.find((candidate) => candidate.id === 'pkt-1500-detector');
    expect(packet?.attemptCount).toBe(1);
  });
});
