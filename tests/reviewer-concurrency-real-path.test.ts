/**
 * Real-path regression for #2294.
 *
 * The test drives simultaneous packet completions through the production lane
 * transition and auto-review route, then drains the durable review queue through
 * the production reviewer wrapper and Codex verdict recorder. The backend is
 * stubbed at the external process boundary only.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const REVIEW_LATENCY_MS = 50;
const FIRST_WAVE_BARRIER_TIMEOUT_MS = 10_000;
const PACKET_COUNT = 6;
const REVIEW_CONCURRENCY_LIMIT = 3;
const REVIEW_TAIL_BUDGET_MS_PER_PACKET = 2_500;

const reviewer = vi.hoisted(() => ({
  activeSessions: new Set<string>(),
  activeTurns: 0,
  peakActiveTurns: 0,
  startedAt: [] as number[],
  finishedAt: [] as number[],
  sessionNames: [] as string[],
  firstWaveWaiters: [] as Array<() => void>,
}));

function reviewerSessionName(repoPath: string, threadId?: string | null): string {
  const trimmed = threadId?.trim() ?? '';
  const threadKey = trimmed.startsWith('thoughts-') ? trimmed : 'repo-default';
  return `${repoPath}:${threadKey}`;
}

vi.mock('@/lib/lane/orchestrator-backends/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
  const backend = {
    id: 'codex' as const,
    label: 'Test reviewer',
    peekSession(repoPath: string, _agent?: string, threadId?: string | null) {
      const sessionName = reviewerSessionName(repoPath, threadId);
      return {
        sessionName,
        status: reviewer.activeSessions.has(sessionName) ? 'busy' as const : 'ready' as const,
      };
    },
    ensureSession(repoPath: string, _agent?: string, threadId?: string | null) {
      const sessionName = reviewerSessionName(repoPath, threadId);
      return {
        sessionName,
        status: reviewer.activeSessions.has(sessionName) ? 'busy' as const : 'ready' as const,
      };
    },
    async sendTurn(
      repoPath: string,
      _message: string,
      onEvent: (event: { type: 'text'; text: string }) => void,
      options?: { threadId?: string | null },
    ) {
      const sessionName = reviewerSessionName(repoPath, options?.threadId);
      if (reviewer.activeSessions.has(sessionName)) {
        throw new Error('Codex orchestrator session is busy');
      }

      reviewer.activeSessions.add(sessionName);
      reviewer.sessionNames.push(sessionName);
      reviewer.activeTurns += 1;
      reviewer.peakActiveTurns = Math.max(reviewer.peakActiveTurns, reviewer.activeTurns);
      reviewer.startedAt.push(Date.now());
      try {
        if (reviewer.sessionNames.length <= REVIEW_CONCURRENCY_LIMIT) {
          await new Promise<void>((resolve) => {
            let settled = false;
            const release = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const timeout = setTimeout(release, FIRST_WAVE_BARRIER_TIMEOUT_MS);
            reviewer.firstWaveWaiters.push(() => {
              clearTimeout(timeout);
              release();
            });
            if (reviewer.firstWaveWaiters.length === REVIEW_CONCURRENCY_LIMIT) {
              const waiters = reviewer.firstWaveWaiters.splice(0);
              for (const waiter of waiters) waiter();
            }
          });
        }
        await new Promise((resolve) => setTimeout(resolve, REVIEW_LATENCY_MS));
        onEvent({
          type: 'text',
          text: 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}',
        });
      } finally {
        reviewer.finishedAt.push(Date.now());
        reviewer.activeTurns -= 1;
        reviewer.activeSessions.delete(sessionName);
      }
    },
  };

  return {
    ...actual,
    getActiveReviewerBackend: () => backend,
    getOrchestratorBackend: () => backend,
  };
});

vi.mock('@/lib/lane/packet-explainer-queue', () => ({
  drainPacketExplainerQueue: vi.fn(async () => {}),
  enqueuePacketExplainer: vi.fn(async () => {}),
  notifyCorrectnessReviewQueued: vi.fn(),
  startPacketExplainerQueueDrain: vi.fn(() => () => {}),
}));
vi.mock('@/lib/mcp/o8-webview-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp/o8-webview-client')>();
  return {
    ...actual,
    O8WebviewClient: class {
      async screenshot() {
        return {
          imageBase64: Buffer.from('review-boundary').toString('base64'),
          mimeType: 'image/png',
          width: 1,
          height: 1,
        };
      }
    },
  };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/push/review-ready-coalescer', () => ({ enqueueReviewReady: vi.fn() }));
vi.mock('@/lib/orchestrator/context-relay', () => ({
  capturePacketCompletionContext: vi.fn(async () => null),
  readPacketCompletionContext: vi.fn(async () => null),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-reviewer-concurrency-data-'));
const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-reviewer-concurrency-repo-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const reviewRoute = await import('@/app/api/review/auto-review/route');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { transitionPostCompletionLaneToReviewing } = await import('@/lib/supervisor/post-completion-packet');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createPacket(index: number) {
  const branch = `fix/reviewer-concurrency-${index}`;
  const worktreePath = join(repoDir, `.packet-${index}`);
  git(repoDir, ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main']);
  const relativePath = `packet-${index}.txt`;
  writeFileSync(join(worktreePath, relativePath), `packet ${index}\n`, 'utf8');
  git(worktreePath, ['add', '--', relativePath]);
  git(worktreePath, ['commit', '-q', '-m', `packet ${index}`]);

  const packetId = `packet-reviewer-concurrency-${index}`;
  const lane = createLane({
    repoPath: repoDir,
    worktreePath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    label: `Reviewer concurrency packet ${index}`,
    packetId,
    sessionKey: `codex-owned:reviewer-concurrency-${index}`,
  });
  return { lane, packetId };
}

async function enqueueThroughRealRoute(laneId: string): Promise<void> {
  const response = await reviewRoute.POST(new NextRequest('http://localhost/api/review/auto-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost' },
    body: JSON.stringify({ action: 'enqueue', laneId }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
}

git(repoDir, ['init', '-q', '-b', 'main']);
git(repoDir, ['config', 'user.email', 'test@example.com']);
git(repoDir, ['config', 'user.name', 'Test User']);
mkdirSync(join(repoDir, 'src'), { recursive: true });
writeFileSync(join(repoDir, 'README.md'), 'base\n', 'utf8');
git(repoDir, ['add', '--', 'README.md']);
git(repoDir, ['commit', '-q', '-m', 'base']);

afterAll(() => {
  closeDb();
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('bounded concurrent auto-review queue (#2294)', () => {
  it('reviews a simultaneous packet burst without busy deferrals and exposes queued state', async () => {
    const packets = Array.from({ length: PACKET_COUNT }, (_, index) => createPacket(index));
    for (const { lane, packetId } of packets) {
      const completed = transitionPostCompletionLaneToReviewing(lane.id, packetId);
      expect(completed.lane?.status).toBe('reviewing');
    }

    await Promise.all(packets.map(({ lane }) => enqueueThroughRealRoute(lane.id)));
    const workerCompletionAt = Date.now();
    await Promise.all([
      drainReviewQueue(),
      drainReviewQueue(),
      drainReviewQueue(),
    ]);

    const queueRows = getSqlite().prepare(
      'SELECT id, lane_id, status FROM review_queue ORDER BY created_at ASC',
    ).all() as Array<{ id: string; lane_id: string; status: string }>;
    expect(queueRows).toHaveLength(PACKET_COUNT);
    expect(queueRows.every((row) => row.status === 'completed')).toBe(true);

    for (const { lane, packetId } of packets) {
      const queueRow = queueRows.find((row) => row.lane_id === lane.id);
      expect(queueRow).toBeDefined();
      const approvals = listApprovalsForContext({ packetId, laneId: lane.id })
        .filter((approval) => approval.toolName === 'orchestrator_review');
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('approved');

      const events = getLaneEvents(lane.id, 100);
      expect(events.some((event) => (
        event.verb === 'review_queued'
        && event.payload.state === 'queued'
        && event.payload.concurrencyLimit === REVIEW_CONCURRENCY_LIMIT
      ))).toBe(true);
      expect(events.filter((event) => event.verb === 'review_deferred')).toHaveLength(0);
      const started = events.filter((event) => event.verb === 'review_turn_started');
      expect(started).toHaveLength(1);
      expect(started[0]?.payload.threadId).toBe(`auto-review-${lane.id}-${queueRow?.id}`);
      expect(events.filter((event) => event.verb === 'review_turn_finished')).toHaveLength(1);
    }

    expect(reviewer.peakActiveTurns).toBeGreaterThan(1);
    expect(reviewer.peakActiveTurns).toBeLessThanOrEqual(REVIEW_CONCURRENCY_LIMIT);
    expect(reviewer.sessionNames).toHaveLength(PACKET_COUNT);
    expect(new Set(reviewer.sessionNames).size).toBe(REVIEW_CONCURRENCY_LIMIT);
    expect(reviewer.startedAt.slice(0, REVIEW_CONCURRENCY_LIMIT).every((startedAt) => (
      startedAt < Math.min(...reviewer.finishedAt)
    ))).toBe(true);

    const lastVerdictAt = Math.max(...reviewer.finishedAt);
    expect(lastVerdictAt - workerCompletionAt).toBeLessThan(
      PACKET_COUNT * REVIEW_TAIL_BUDGET_MS_PER_PACKET,
    );
  });
});
