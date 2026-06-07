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
import { extractAddedLines, getLaneDiffFacts, parseDiffStat } from './lane-diff-facts';
import { buildAdversarialReviewProtocol, classifyReviewRisk } from './review-risk';
import { resolveLaneReviewScreenshotReference, type LaneReviewScreenshotReference } from './review-screenshot';
import { buildBlindSecondPassPrompt, findPendingSecondPassApproval, parseSecondPassVerdict } from './blind-second-pass-review';
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

interface ReviewDiffSummary {
  summary: string;
  changedFiles: string[];
  addedLines: string[];
  cwd: string;
}

function getDiffSummary(lane: Lane, depth: ReviewDepth): ReviewDiffSummary {
  const cwd = lane.worktreePath || lane.repoPath;
  const maxDiffLines = REVIEW_DIFF_LINES[depth];
  try {
    const facts = getLaneDiffFacts(lane);
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

    if (!stat && !diff) {
      return { summary: 'No changes detected in the worktree.', changedFiles: facts.changedFiles, addedLines: facts.addedLines, cwd };
    }
    return {
      summary: `## Diff summary\n\n\`\`\`\n${stat}\n\`\`\`\n\n## Changes\n\n\`\`\`diff\n${diff}\n\`\`\``,
      changedFiles: facts.changedFiles,
      addedLines: facts.addedLines,
      cwd,
    };
  } catch {
    return {
      summary: 'Unable to generate diff — the worktree may not have commits yet.',
      changedFiles: [],
      addedLines: [],
      cwd,
    };
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
    const addedLines = extractAddedLines(rawDiff);

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
  changedFiles: string[],
  addedLines: string[],
  selfReview: PacketSelfReview | undefined,
  depth: ReviewDepth,
  mechanicalChecksSummary?: string,
  mergeGateResult?: MergeGateResult,
  reviewScreenshot?: LaneReviewScreenshotReference | null,
  reviewWorktreePath?: string,
): string {
  const depthGuidance = depth === 'deep-dive'
    ? 'This lane has low-confidence or missing self-review context. Perform a deep-dive review and challenge assumptions, edge cases, and missing validation.'
    : 'This lane reports medium-confidence self-review. Do a normal review with independent verification of the claimed changes.';

  const mergeGateSection = mergeGateResult ? formatMergeGateForReview(mergeGateResult) : null;
  const reviewRisk = classifyReviewRisk(changedFiles, addedLines);
  const adversarialReviewProtocol = buildAdversarialReviewProtocol(reviewRisk.tier);
  const worktreePath = reviewWorktreePath || lane.worktreePath || lane.repoPath;
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
  const requiredTraceFormat = [
    '## Required verification traces',
    '',
    'Before any verdict, recommendation, or submit_review call, emit a completed trace block in this exact format:',
    `Worktree: ${worktreePath}`,
    lane.packetId ? `Packet: ${lane.packetId}` : null,
    '',
    'SCOPE traces - required for every changed file that writes or mutates state:',
    '`SCOPE: <file:line> partition=<repo|tenant|user|project|lane|packet|scope|slug|id|NONE>`',
    'Then state the SINGLE intended destination and confirm the diff writes there and ONLY there. Flag output written to the wrong location or duplicated across locations.',
    '',
    'GUARD traces - required for every new guard, condition, or early return:',
    '`GUARD: <file:line> fires-from=<file:line|INERT>`',
    '',
    'COVERAGE checklist - enumerate EACH sub-requirement from the packet scope:',
    '`COVERAGE:`',
    '`[x] <sub-requirement> - evidence <file:line|command output>`',
    '`[ ] <sub-requirement> - gap <reason>`',
    '',
    'Hard approval rule: You may NOT approve if any guard is INERT, any write has partition=NONE, or any COVERAGE box is unchecked. Request changes instead.',
    'To clear an intentional global write, cite the file:line that proves the global destination is correct.',
    'Where the change has observable output (a file written, a command stdout, a function return), PREFER to run it in the worktree and inspect the ACTUAL output over reasoning about the diff.',
  ].filter((value): value is string => value !== null).join('\n');

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
    requiredTraceFormat,
    ``,
    adversarialReviewProtocol || null,
    adversarialReviewProtocol ? `` : null,
    `## Your review should include:`,
    `1. What was changed (1-2 sentences)`,
    `2. The Required verification traces above, completed before the verdict`,
    `3. EXECUTION-PATH TRACE — trace the actual call path the change runs under, not the one its name implies.`,
    mergeGateSection ? `4. Address each merge gate violation — these are enforcement-level findings` : null,
    mechanicalChecksSummary ? `${mergeGateSection ? '5' : '4'}. Address each mechanical check finding — confirm or dismiss` : null,
    `${mergeGateSection && mechanicalChecksSummary ? '6' : mergeGateSection || mechanicalChecksSummary ? '5' : '4'}. Your recommendation: approve or request changes`,
    ``,
    `After reviewing, FIRST record your verdict by calling submit_review with`,
    `approved=true only if all required traces clear; otherwise call it with approved=false and findings. This writes the durable`,
    `review record that authorizes merge/PR for the current HEAD. THEN call`,
    `lane_command with verb "merge" (or "create_pr") for lane "${lane.id}".`,
    `A merge or PR with no recorded approved review will surface an operator`,
    `approval card instead of auto-continuing.`,
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
    diffSummary.summary,
    diffSummary.changedFiles,
    diffSummary.addedLines,
    completionContext?.selfReview,
    depth,
    mechanicalChecks.summary || undefined,
    mergeGateResult,
    reviewScreenshot,
    diffSummary.cwd,
  );

  // Dual-path routing (epic #1044): the `inAppOrchestratorEnabled` toggle is
  // now a runtime selector, not an on/off gate.
  //   - toggle OFF (default) → Codex GPT-5.5 xhigh runs the review. Free for
  //     ChatGPT Plus / Codex sub users; no Anthropic Agent SDK draw.
  //   - toggle ON              → Claude Opus 4.8 runs the review (existing
  //     behavior, bills against the user's Agent SDK credit pool).
  // Both backends can call `submit_review` and `lane_command`. Fail-closed
  // approval is enforced by the durable review gate (`requiresSecondPass`),
  // not by backend capability asymmetry.
  // Backend selected via the orchestrator-backend registry (#1075). Behavior
  // is byte-identical to the prior dual-path branch — see registry.ts.
  const { getActiveOrchestratorBackend } = await import('./orchestrator-backends/registry');
  const backend = getActiveOrchestratorBackend();

  console.log(`[auto-review] Routing lane ${lane.id} via ${backend.label} orchestrator`);

  const session = backend.ensureSession(lane.repoPath);
  if (session.status === 'busy') {
    throw new Error(`${backend.label} orchestrator session busy — will retry`);
  }
  if (session.status === 'dead') {
    throw new Error(`${backend.label} orchestrator session dead — will retry after recovery`);
  }

  console.log(`[auto-review] Sending review prompt to ${backend.label} orchestrator for lane ${lane.id}`);

  await backend.sendTurn(lane.repoPath, reviewPrompt, (event) => {
    if (event.type === 'text') {
      console.log(`[auto-review] ${backend.label}: ${event.text.slice(0, 100)}`);
    } else if (event.type === 'tool_use') {
      console.log(`[auto-review] ${backend.label} called tool: ${event.name}`);
    } else if (event.type === 'error') {
      console.error(`[auto-review] ${backend.label} error: ${event.error}`);
    }
  });

  const reviewRisk = classifyReviewRisk(diffSummary.changedFiles, diffSummary.addedLines);
  if (reviewRisk.tier !== 'high') {
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return;
  }

  const pendingSecondPass = await findPendingSecondPassApproval(lane);
  if (!pendingSecondPass) {
    console.log(`[auto-review] High-risk lane ${lane.id} has no current-head approval awaiting second pass`);
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return;
  }

  const blindPrompt = buildBlindSecondPassPrompt(lane, diffSummary, reviewRisk.reasons);
  const secondPassThreadId = `thoughts-second-pass-${lane.id}-${randomUUID().slice(0, 8)}`;
  let secondPassText = '';
  const secondPassErrors: string[] = [];

  console.log(`[auto-review] Sending blind second-pass review to ${backend.label} for lane ${lane.id}`);
  try {
    await backend.sendTurn(lane.repoPath, blindPrompt, (event) => {
      if (event.type === 'text') {
        secondPassText += event.text;
        console.log(`[auto-review] ${backend.label} second-pass: ${event.text.slice(0, 100)}`);
      } else if (event.type === 'tool_use') {
        console.log(`[auto-review] ${backend.label} second-pass called tool: ${event.name}`);
      } else if (event.type === 'error') {
        secondPassErrors.push(event.error);
        console.error(`[auto-review] ${backend.label} second-pass error: ${event.error}`);
      }
    }, { threadId: secondPassThreadId });
  } catch (error) {
    secondPassErrors.push(error instanceof Error ? error.message : String(error));
  }

  const [{ normalizeHeadSha, readHeadSha }, { createApproval, markSecondPassAgreed }] = await Promise.all([
    import('@/lib/lane/head-sha-lock'),
    import('@/lib/approvals/store'),
  ]);
  let currentHeadSha: string | undefined;
  try {
    currentHeadSha = normalizeHeadSha(await readHeadSha(lane.worktreePath || lane.repoPath));
  } catch (error) {
    console.warn(`[auto-review] Failed to re-read HEAD after second pass for lane ${lane.id}:`, error);
    return;
  }
  if (currentHeadSha !== pendingSecondPass.reviewedHeadSha) {
    console.warn(`[auto-review] Second pass refused to stamp lane ${lane.id}: HEAD moved from ${pendingSecondPass.reviewedHeadSha} to ${currentHeadSha ?? '(unknown)'}`);
    return;
  }

  const verdict = secondPassErrors.length > 0
    ? { verdict: 'inconclusive' as const, reason: `turn error: ${secondPassErrors.join('; ').slice(0, 500)}` }
    : parseSecondPassVerdict(secondPassText);

  if (verdict.verdict === 'agree') {
    markSecondPassAgreed(pendingSecondPass.approval.id);
    const { dispatch } = await import('@/lib/lane/commands');
    const mergeResult = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    console.log(`[auto-review] Second-pass agreed for lane ${lane.id}; merge result ok=${mergeResult.ok} note=${mergeResult.note}`);
    console.log(`[auto-review] Review complete for lane ${lane.id}`);
    return;
  }

  const finding = verdict.verdict === 'disagree' ? verdict.finding : verdict.reason;
  createApproval({
    projectId: lane.projectId,
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: verdict.verdict === 'disagree' ? 'Second-pass reviewer disagreed' : 'Second-pass reviewer inconclusive',
    description: `Blind second-pass review did not agree at HEAD ${pendingSecondPass.reviewedHeadSha}. Merge remains blocked until an operator reviews the finding.`,
    summary: finding,
    toolName: 'orchestrator_second_pass',
    args: {
      approvalId: pendingSecondPass.approval.id,
      laneId: lane.id,
      packetId: lane.packetId,
      reviewedHeadSha: pendingSecondPass.reviewedHeadSha,
      verdict: verdict.verdict,
      finding,
    },
    editable: false,
    risk: 'high',
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      'Reviewed HEAD': pendingSecondPass.reviewedHeadSha,
    },
  });
  console.warn(`[auto-review] Second pass blocked lane ${lane.id}: ${finding}`);
  console.log(`[auto-review] Review complete for lane ${lane.id}`);
}
