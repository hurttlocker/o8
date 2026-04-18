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
import { capturePacketCompletionContext, readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import type { PacketSelfReview } from '@/lib/orchestrator/types';
import { runMergeGate, formatMergeGateForReview, type MergeGateResult } from './merge-gate';
import { resolveLaneReviewScreenshotReference, type LaneReviewScreenshotReference } from './review-screenshot';
import type { Lane } from './types';

const MAX_REVIEW_ATTEMPTS = 5;
const DRAIN_INTERVAL_MS = 10_000;
const REVIEW_DIFF_LINES = {
  'fast-track': 120,
  standard: 200,
  'deep-dive': 320,
} as const;

/** Lanes currently being reviewed — prevents concurrent review of the same lane */
const reviewingLanes = new Set<string>();

let drainTimer: ReturnType<typeof setInterval> | null = null;

export function isLaneAutoReviewActive(laneId: string): boolean {
  return reviewingLanes.has(laneId);
}

// ── Queue Operations (SQLite-backed) ──

function getDb() {
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

type ReviewDepth = keyof typeof REVIEW_DIFF_LINES;

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

/**
 * Derive review depth from self-review confidence.
 * (#482) — Fast-track removed. Agent self-review is informational only;
 * mechanical checks + LLM review are the real gates. Agents confidently
 * reported "passed: true, confidence: high" on broken code in Round 1.
 */
function deriveReviewDepth(selfReview?: PacketSelfReview): ReviewDepth {
  if (!selfReview?.passed || selfReview.confidence === 'low') {
    return 'deep-dive';
  }

  // Never fast-track — mechanical checks are the real gate
  return 'standard';
}

function formatSelfReview(selfReview: PacketSelfReview | undefined, depth: ReviewDepth): string {
  if (!selfReview) {
    return [
      '## Agent self-review',
      '',
      'Structured self-review: missing',
      'Review depth: deep-dive',
      'Reason: no machine-readable self-review verdict was captured in the completion context.',
    ].join('\n');
  }

  const issues = selfReview.issuesFound && selfReview.issuesFound.length > 0
    ? selfReview.issuesFound.map((issue) => `- ${issue}`).join('\n')
    : '- none recorded';

  return [
    '## Agent self-review',
    '',
    `Passed: ${selfReview.passed ? 'yes' : 'no'}`,
    `Confidence: ${selfReview.confidence}`,
    `Review depth: ${depth}`,
    `Summary: ${selfReview.summary}`,
    'Issues found and fixed during self-review:',
    issues,
  ].join('\n');
}

function getDiffSummary(lane: Lane, depth: ReviewDepth): string {
  const cwd = lane.worktreePath || lane.repoPath;
  const maxDiffLines = REVIEW_DIFF_LINES[depth];
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
      diff = rawDiff.split('\n').slice(0, maxDiffLines).join('\n').trim();
    } catch {
      try {
        const rawDiff = execSync('git diff HEAD~1 --no-color -U2', { cwd, timeout: 10_000, encoding: 'utf-8' });
        diff = rawDiff.split('\n').slice(0, maxDiffLines).join('\n').trim();
      } catch { /* no commits yet */ }
    }

    if (!stat && !diff) return 'No changes detected in the worktree.';
    return `## Diff summary\n\n\`\`\`\n${stat}\n\`\`\`\n\n## Changes\n\n\`\`\`diff\n${diff}\n\`\`\``;
  } catch {
    return 'Unable to generate diff — the worktree may not have commits yet.';
  }
}

// ── Mechanical Checks (#482) ──
// Automated diff stats + security pattern scan that runs before LLM review.
// Findings are prepended to the review prompt so the orchestrator sees them.

interface MechanicalFinding {
  severity: 'high' | 'warning';
  label: string;
  detail: string;
}

const SECURITY_PATTERNS: Array<{ pattern: RegExp; label: string; severity: 'high' | 'warning' }> = [
  { pattern: /execSync\s*\(.*\$\{/, label: 'execSync with template literal', severity: 'high' },
  { pattern: /execSync\s*\(.*\+\s*/, label: 'execSync with string concatenation', severity: 'high' },
  { pattern: /\bexec\s*\(.*\$\{/, label: 'exec with template literal', severity: 'high' },
  { pattern: /child_process.*\bsh\s+-c\b/, label: 'sh -c shell execution', severity: 'high' },
  { pattern: /\beval\s*\(/, label: 'eval() usage', severity: 'high' },
  { pattern: /new\s+Function\s*\(/, label: 'new Function() constructor', severity: 'high' },
  { pattern: /dangerouslySetInnerHTML/, label: 'dangerouslySetInnerHTML', severity: 'warning' },
  { pattern: /path\.join\s*\([^)]*(?:req\.|params\.|query\.|body\.)/, label: 'path.join on user input without bounds check', severity: 'high' },
  { pattern: /\.innerHTML\s*=/, label: 'direct innerHTML assignment', severity: 'warning' },
];

/** Parse `git diff --stat` output into per-file insertion/deletion counts. */
function parseDiffStat(stat: string): Array<{ file: string; insertions: number; deletions: number }> {
  const results: Array<{ file: string; insertions: number; deletions: number }> = [];
  for (const line of stat.split('\n')) {
    // Format: " src/foo.ts | 42 +++++-----"  or  " src/foo.ts | 10 ++++"
    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)\s/);
    if (!match) continue;
    const file = match[1].trim();
    const plusMatch = line.match(/(\d+)\s*insertion/);
    const minusMatch = line.match(/(\d+)\s*deletion/);
    // Fallback: count + and - symbols in the bar chart
    const barMatch = line.match(/\|\s*\d+\s+([\s+\-]+)$/);
    let insertions = plusMatch ? parseInt(plusMatch[1], 10) : 0;
    let deletions = minusMatch ? parseInt(minusMatch[1], 10) : 0;
    if (!plusMatch && !minusMatch && barMatch) {
      const bar = barMatch[1];
      insertions = (bar.match(/\+/g) || []).length;
      deletions = (bar.match(/-/g) || []).length;
    }
    if (file && (insertions > 0 || deletions > 0)) {
      results.push({ file, insertions, deletions });
    }
  }
  return results;
}

function runMechanicalChecks(lane: Lane): { findings: MechanicalFinding[]; summary: string } {
  const cwd = lane.worktreePath || lane.repoPath;
  const findings: MechanicalFinding[] = [];

  // ── Diff stats check ──
  let stat = '';
  try {
    stat = execSync(`git diff --stat ${lane.baseBranch}...HEAD`, { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
  } catch {
    try {
      stat = execSync('git diff --stat HEAD~1', { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
    } catch { /* no commits */ }
  }

  if (stat) {
    const fileStats = parseDiffStat(stat);
    for (const fs of fileStats) {
      const total = fs.insertions + fs.deletions;
      if (total === 0) continue;
      const deleteRatio = fs.deletions / total;
      if (fs.deletions > 50 && deleteRatio > 0.5) {
        findings.push({
          severity: 'high',
          label: 'Possible file rewrite',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Agent may have rewritten instead of surgically editing.`,
        });
      } else if (fs.deletions > 20 && deleteRatio > 0.3) {
        findings.push({
          severity: 'warning',
          label: 'High deletion ratio',
          detail: `${fs.file}: ${fs.deletions} deletions (${Math.round(deleteRatio * 100)}% of changes). Verify deletions were intentional.`,
        });
      }
    }
  }

  // ── Security pattern scan ──
  let rawDiff = '';
  try {
    rawDiff = execSync(`git diff ${lane.baseBranch}...HEAD --no-color`, { cwd, timeout: 10_000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    try {
      rawDiff = execSync('git diff HEAD~1 --no-color', { cwd, timeout: 10_000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    } catch { /* no commits */ }
  }

  if (rawDiff) {
    // Only scan added lines (lines starting with +, excluding +++ headers)
    const addedLines = rawDiff
      .split('\n')
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'));

    for (const { pattern, label, severity } of SECURITY_PATTERNS) {
      for (const line of addedLines) {
        if (pattern.test(line)) {
          findings.push({
            severity,
            label,
            detail: `New code matches security pattern: ${line.slice(1).trim().slice(0, 120)}`,
          });
          break; // One finding per pattern is enough
        }
      }
    }
  }

  if (findings.length === 0) {
    return { findings, summary: '' };
  }

  const highCount = findings.filter((f) => f.severity === 'high').length;
  const warnCount = findings.filter((f) => f.severity === 'warning').length;
  const lines = [
    '## Mechanical checks (automated)',
    '',
    `Found ${findings.length} issue${findings.length === 1 ? '' : 's'}: ${highCount} high, ${warnCount} warning.`,
    '',
    ...findings.map((f) => `- **[${f.severity.toUpperCase()}]** ${f.label}: ${f.detail}`),
    '',
    'These checks are automated and may have false positives. Evaluate each finding independently.',
  ];

  console.log(`[auto-review] Mechanical checks for lane ${lane.id}: ${highCount} high, ${warnCount} warning`);

  return { findings, summary: lines.join('\n') };
}

function buildReviewPrompt(
  lane: Lane,
  diffSummary: string,
  selfReview: PacketSelfReview | undefined,
  depth: ReviewDepth,
  mechanicalChecksSummary?: string,
  mergeGateResult?: MergeGateResult,
  reviewScreenshot?: LaneReviewScreenshotReference | null,
): string {
  const depthGuidance = depth === 'deep-dive'
    ? 'This lane has low-confidence or missing self-review context. Perform a deep-dive review and challenge assumptions, edge cases, and missing validation.'
    : 'This lane reports medium-confidence self-review. Do a normal review with independent verification of the claimed changes.';

  const mergeGateSection = mergeGateResult ? formatMergeGateForReview(mergeGateResult) : null;
  const reviewScreenshotMetadata = reviewScreenshot
    ? [
        typeof reviewScreenshot.width === 'number' && reviewScreenshot.width > 0
          && typeof reviewScreenshot.height === 'number' && reviewScreenshot.height > 0
          ? `${reviewScreenshot.width}x${reviewScreenshot.height}`
          : null,
        reviewScreenshot.mimeType ?? null,
        reviewScreenshot.capturedAt ? `captured ${reviewScreenshot.capturedAt}` : null,
      ].filter((value): value is string => Boolean(value)).join(' • ')
    : '';

  return [
    `An agent has completed work on lane "${lane.label}" (branch: ${lane.branch}).`,
    ``,
    depthGuidance,
    ``,
    `Review the changes and provide your verdict. Your review summary will be shown`,
    `to the operator on their approval card — they don't read code, so your summary`,
    `IS their understanding of what happened.`,
    ``,
    mergeGateSection,
    mergeGateSection ? `` : null,
    mechanicalChecksSummary ? mechanicalChecksSummary : null,
    mechanicalChecksSummary ? `` : null,
    formatSelfReview(selfReview, depth),
    ``,
    reviewScreenshot ? '## Attached review screenshot' : null,
    reviewScreenshot ? 'A screenshot was auto-captured when this lane entered review. Inspect the image file directly at native resolution instead of asking for a reduced copy.' : null,
    reviewScreenshot ? `Image path: ${reviewScreenshot.path}` : null,
    reviewScreenshotMetadata ? `Image metadata: ${reviewScreenshotMetadata}` : null,
    reviewScreenshot ? `` : null,
    diffSummary,
    ``,
    `## Your review should include:`,
    `1. What was changed (1-2 sentences)`,
    `2. Whether it looks correct and matches the original task intent`,
    `3. Any concerns (regressions, missing tests, style violations)`,
    mergeGateSection ? `4. Address each merge gate violation — these are enforcement-level findings` : null,
    mechanicalChecksSummary ? `${mergeGateSection ? '5' : '4'}. Address each mechanical check finding — confirm or dismiss` : null,
    `${mergeGateSection && mechanicalChecksSummary ? '6' : mergeGateSection || mechanicalChecksSummary ? '5' : '4'}. Your recommendation: approve or request changes`,
    ``,
    `After reviewing, create an approval for the operator by calling the lane_command`,
    `tool with verb "create_pr" or "merge" for lane "${lane.id}". The policy engine`,
    `will gate this and create the approval card automatically.`,
  ].filter((value): value is string => value !== null).join('\n');
}

async function performAutoReview(review: QueuedReview): Promise<void> {
  const { getLane, getLatestLaneReviewScreenshot } = await import('@/lib/lane/registry');
  const lane = getLane(review.lane_id);
  if (!lane) {
    throw new Error(`Lane ${review.lane_id} not found`);
  }

  if (lane.status !== 'reviewing') {
    console.log(`[auto-review] Lane ${lane.id} is no longer reviewing (${lane.status}) — skipping`);
    return;
  }

  let completionContext = null;
  if (lane.packetId && lane.sessionKey) {
    try {
      completionContext = await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
    } catch (error) {
      console.warn(`[auto-review] Failed to refresh completion context for lane ${lane.id}:`, error);
      completionContext = await readPacketCompletionContext(lane.packetId);
    }
  } else if (lane.packetId) {
    completionContext = await readPacketCompletionContext(lane.packetId);
  }

  const depth = deriveReviewDepth(completionContext?.selfReview);
  const mechanicalChecks = runMechanicalChecks(lane);
  const mergeGateResult = runMergeGate(lane, completionContext?.selfReview);
  const diffSummary = getDiffSummary(lane, depth);
  let reviewScreenshot: LaneReviewScreenshotReference | null = null;
  if (lane.runtime === 'codex') {
    try {
      reviewScreenshot = await resolveLaneReviewScreenshotReference(
        lane.id,
        getLatestLaneReviewScreenshot(lane.id),
      );
    } catch (error) {
      console.warn(`[auto-review] Failed to prepare review screenshot for lane ${lane.id}:`, error);
    }
  }
  const reviewPrompt = buildReviewPrompt(
    lane,
    diffSummary,
    completionContext?.selfReview,
    depth,
    mechanicalChecks.summary || undefined,
    mergeGateResult,
    reviewScreenshot,
  );

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
