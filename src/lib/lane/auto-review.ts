/**
 * Auto-review trigger for the orchestrator loop.
 *
 * When a lane transitions to 'reviewing' (agent finished), this module
 * enqueues a durable review job in SQLite. A drain loop processes the
 * queue sequentially, sending review prompts to the orchestrator session.
 *
 * This is the connecting tissue between agent completion and human approval.
 * (#456) — Persistent queue survives process restarts. No more lost reviews.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { Lane } from './types';

const MAX_REVIEW_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 10_000;
const MAX_DIFF_LINES = 200;

/** Lanes currently being reviewed — prevents concurrent review of the same lane */
const reviewingLanes = new Set<string>();

let drainTimer: ReturnType<typeof setInterval> | null = null;

export function isLaneAutoReviewActive(laneId: string): boolean {
  return reviewingLanes.has(laneId);
}

// ── Queue Operations (SQLite-backed) ──

function getDb() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSqlite } = require('@/lib/db') as { getSqlite: () => import('better-sqlite3').Database };
  return getSqlite();
}

function enqueueReview(lane: Lane): boolean {
  const db = getDb();

  // Don't enqueue if already pending/in_progress for this lane
  const existing = db.prepare(
    `SELECT id FROM review_queue WHERE lane_id = ? AND status IN ('pending', 'in_progress')`,
  ).get(lane.id) as { id: string } | undefined;

  if (existing) {
    console.log(`[auto-review] Review already queued for lane ${lane.id}`);
    return false;
  }

  const id = `review-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))`,
  ).run(id, lane.id, lane.repoPath);

  console.log(`[auto-review] Enqueued review ${id} for lane ${lane.id} (${lane.label})`);
  return true;
}

interface QueuedReview {
  id: string;
  lane_id: string;
  repo_path: string;
  attempts: number;
}

function claimNextReview(): QueuedReview | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, lane_id, repo_path, attempts FROM review_queue
     WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`,
  ).get() as QueuedReview | undefined;

  if (!row) return null;

  db.prepare(
    `UPDATE review_queue SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`,
  ).run(row.id);

  return row;
}

function markReviewCompleted(reviewId: string): void {
  getDb().prepare(
    `UPDATE review_queue SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
  ).run(reviewId);
}

function markReviewFailed(reviewId: string, error: string, attempts: number): void {
  const db = getDb();
  if (attempts >= MAX_REVIEW_ATTEMPTS) {
    db.prepare(
      `UPDATE review_queue SET status = 'failed', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
  } else {
    // Return to pending for retry
    db.prepare(
      `UPDATE review_queue SET status = 'pending', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
  }
}

// ── Public API ──

/**
 * Called when a lane transitions to 'reviewing' during reconciliation.
 * Enqueues a durable review job — does not block the caller.
 */
export function triggerAutoReview(lane: Lane): void {
  enqueueReview(lane);
}

/**
 * Start the review queue drain loop. Call once on ws-server startup.
 */
export function startReviewQueueDrain(): () => void {
  if (drainTimer) return () => { /* already running */ };

  // Recover any reviews stuck in 'in_progress' from a previous crash
  try {
    getDb().prepare(
      `UPDATE review_queue SET status = 'pending', updated_at = datetime('now')
       WHERE status = 'in_progress'`,
    ).run();
  } catch {
    // DB may not be ready yet — drain loop will handle it
  }

  drainTimer = setInterval(() => {
    void drainReviewQueue().catch((err) => {
      console.error('[auto-review] Drain error:', err);
    });
  }, DRAIN_INTERVAL_MS);

  console.log(`[auto-review] Started review queue drain (${DRAIN_INTERVAL_MS}ms interval)`);

  // Run immediately
  void drainReviewQueue().catch(() => {});

  return () => {
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
      console.log('[auto-review] Stopped review queue drain');
    }
  };
}

// ── Drain Logic ──

let drainInFlight = false;

async function drainReviewQueue(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;

  try {
    const review = claimNextReview();
    if (!review) return;

    // Don't review concurrently for the same lane
    if (reviewingLanes.has(review.lane_id)) {
      markReviewFailed(review.id, 'Lane already being reviewed', review.attempts);
      return;
    }

    reviewingLanes.add(review.lane_id);
    try {
      await performAutoReview(review);
      markReviewCompleted(review.id);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      markReviewFailed(review.id, errorMsg, review.attempts + 1);
      console.error(`[auto-review] Review ${review.id} failed (attempt ${review.attempts + 1}): ${errorMsg}`);
    } finally {
      reviewingLanes.delete(review.lane_id);
    }
  } finally {
    drainInFlight = false;
  }
}

// ── Review Execution ──

function getDiffSummary(lane: Lane): string {
  const cwd = lane.worktreePath || lane.repoPath;
  try {
    let stat = '';
    try {
      stat = execSync(`git diff --stat ${lane.baseBranch}...HEAD`, { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
    } catch {
      try {
        stat = execSync('git diff --stat HEAD~1', { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
      } catch { /* no commits yet */ }
    }

    let diff = '';
    try {
      const rawDiff = execSync(`git diff ${lane.baseBranch}...HEAD --no-color -U2`, { cwd, timeout: 10_000, encoding: 'utf-8' });
      diff = rawDiff.split('\n').slice(0, MAX_DIFF_LINES).join('\n').trim();
    } catch {
      try {
        const rawDiff = execSync('git diff HEAD~1 --no-color -U2', { cwd, timeout: 10_000, encoding: 'utf-8' });
        diff = rawDiff.split('\n').slice(0, MAX_DIFF_LINES).join('\n').trim();
      } catch { /* no commits yet */ }
    }

    if (!stat && !diff) return 'No changes detected in the worktree.';
    return `## Diff summary\n\n\`\`\`\n${stat}\n\`\`\`\n\n## Changes\n\n\`\`\`diff\n${diff}\n\`\`\``;
  } catch {
    return 'Unable to generate diff — the worktree may not have commits yet.';
  }
}

function buildReviewPrompt(lane: Lane, diffSummary: string): string {
  return [
    `An agent has completed work on lane "${lane.label}" (branch: ${lane.branch}).`,
    ``,
    `Review the changes and provide your verdict. Your review summary will be shown`,
    `to the operator on their approval card — they don't read code, so your summary`,
    `IS their understanding of what happened.`,
    ``,
    diffSummary,
    ``,
    `## Your review should include:`,
    `1. What was changed (1-2 sentences)`,
    `2. Whether it looks correct and matches the original task intent`,
    `3. Any concerns (regressions, missing tests, style violations)`,
    `4. Your recommendation: approve or request changes`,
    ``,
    `After reviewing, create an approval for the operator by calling the lane_command`,
    `tool with verb "create_pr" or "merge" for lane "${lane.id}". The policy engine`,
    `will gate this and create the approval card automatically.`,
  ].join('\n');
}

async function performAutoReview(review: QueuedReview): Promise<void> {
  const { getLane } = await import('@/lib/lane/registry');
  const lane = getLane(review.lane_id);
  if (!lane) {
    throw new Error(`Lane ${review.lane_id} not found`);
  }

  if (lane.status !== 'reviewing') {
    console.log(`[auto-review] Lane ${lane.id} is no longer reviewing (${lane.status}) — skipping`);
    return;
  }

  const diffSummary = getDiffSummary(lane);
  const reviewPrompt = buildReviewPrompt(lane, diffSummary);

  const { ensureOrchestratorSession, sendToOrchestrator } = await import('./orchestrator-session');
  const session = ensureOrchestratorSession(lane.repoPath);

  if (session.status === 'busy') {
    throw new Error('Orchestrator session busy — will retry');
  }

  if (session.status === 'dead') {
    throw new Error('Orchestrator session dead — will retry after recovery');
  }

  console.log(`[auto-review] Sending review prompt to orchestrator for lane ${lane.id}`);

  await sendToOrchestrator(session, reviewPrompt, (event) => {
    if (event.type === 'text') {
      console.log(`[auto-review] Orchestrator: ${event.text.slice(0, 100)}`);
    } else if (event.type === 'tool_use') {
      console.log(`[auto-review] Orchestrator called tool: ${event.name}`);
    } else if (event.type === 'error') {
      console.error(`[auto-review] Orchestrator error: ${event.error}`);
    }
  });

  console.log(`[auto-review] Review complete for lane ${lane.id}`);
}
