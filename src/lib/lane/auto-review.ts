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
import { execFileSync } from 'node:child_process';
import { getSqlite } from '@/lib/db';
import { isSafeGitRef } from '@/lib/git/refs';
import { capturePacketCompletionContext, readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { readPacketDeviations, type PacketDeviations } from '@/lib/orchestrator/packet-deviations';
import type { PacketSelfReview, PacketTaskContract } from '@/lib/orchestrator/types';
import { buildAutoReviewPromptV1 } from '@/lib/prompts/v1';
import { runMergeGate, formatMergeGateForReview, type MergeGateResult } from './merge-gate';
import { extractAddedLines, getLaneDiffFacts, parseDiffStat } from './lane-diff-facts';
import { buildAdversarialReviewProtocol, classifyReviewRisk } from './review-risk';
import { resolveLaneReviewScreenshotReference, type LaneReviewScreenshotReference } from './review-screenshot';
import { buildBlindSecondPassPrompt, findPendingSecondPassApproval, parseSecondPassVerdict } from './blind-second-pass-review';
import { appendCodexAutoReviewVerdictInstructions, recordCodexAutoReviewVerdict } from './codex-auto-review-verdict';
import { runReviewerTurnWithQuotaFallback } from './review-quota-fallback';
import { enqueueLaneReview, surfaceReviewQueueBlocker } from './review-queue';
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
const cancelledReviewLanes = new Set<string>();

let drainTimer: ReturnType<typeof setInterval> | null = null;

export function isLaneAutoReviewActive(laneId: string): boolean {
  return reviewingLanes.has(laneId);
}

export function cancelAutoReviewForLane(laneId: string, reason: string): void {
  cancelledReviewLanes.add(laneId);
  try {
    getDb().prepare(
      `UPDATE review_queue
       SET status = 'completed', last_error = ?, updated_at = datetime('now')
       WHERE lane_id = ? AND status IN ('pending', 'in_progress')`,
    ).run(`Cancelled: ${reason}`, laneId);
  } catch (error) {
    console.warn(`[auto-review] Failed to persist cancellation for lane ${laneId}:`, error);
  }
}

// ── Queue Operations (SQLite-backed) ──

function getDb() {
  return getSqlite();
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

function markReviewFailed(reviewId: string, laneId: string, error: string, attempts: number): void {
  const db = getDb();
  if (attempts >= MAX_REVIEW_ATTEMPTS) {
    db.prepare(
      `UPDATE review_queue SET status = 'failed', last_error = ?, attempts = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(error, attempts, reviewId);
    surfaceReviewQueueBlocker({ laneId, reviewId, reason: error, attempts });
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
  enqueueLaneReview(lane);
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
      markReviewFailed(review.id, review.lane_id, 'Lane already being reviewed', review.attempts);
      return;
    }

    reviewingLanes.add(review.lane_id);
    try {
      await performAutoReview(review);
      markReviewCompleted(review.id);
    } catch (err) {
      if (cancelledReviewLanes.has(review.lane_id)) {
        markReviewCompleted(review.id);
        return;
      }
      const errorMsg = err instanceof Error ? err.message : String(err);
      markReviewFailed(review.id, review.lane_id, errorMsg, review.attempts + 1);
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
  const evidence = selfReview.evidence && selfReview.evidence.length > 0
    ? selfReview.evidence.map((entry) => `- ${entry}`).join('\n')
    : '- none recorded';

  return [
    '## Agent self-review',
    '',
    `Passed: ${selfReview.passed ? 'yes' : 'no'}`,
    `Confidence: ${selfReview.confidence}`,
    `Review depth: ${depth}`,
    `Summary: ${selfReview.summary}`,
    `Outcome: ${selfReview.outcome ?? 'not stated'}`,
    `Decision: ${selfReview.decision ?? 'legacy self-review; infer independently'}`,
    `Residual: ${selfReview.residual ?? 'not stated'}`,
    `Recurrence protection: ${selfReview.recurrenceProtection ?? 'not stated'}`,
    'Claimed evidence:',
    evidence,
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

function getDiffSummary(lane: Lane, depth: ReviewDepth, comparisonRef?: string): ReviewDiffSummary {
  const cwd = lane.worktreePath || lane.repoPath;
  const maxDiffLines = REVIEW_DIFF_LINES[depth];
  try {
    const facts = getLaneDiffFacts(lane, comparisonRef);
    const safeBase = comparisonRef && isSafeGitRef(comparisonRef)
      ? comparisonRef
      : isSafeGitRef(lane.baseBranch) ? lane.baseBranch : null;
    let stat = '';
    try {
      stat = execFileSync('git', ['diff', '--stat', safeBase ? `${safeBase}...HEAD` : 'HEAD~1'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
    } catch {
      try {
        stat = execFileSync('git', ['diff', '--stat', 'HEAD~1'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
      } catch { /* no commits yet */ }
    }

    let diff = '';
    try {
      const rawDiff = execFileSync('git', ['diff', safeBase ? `${safeBase}...HEAD` : 'HEAD~1', '--no-color', '-U2'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' });
      diff = rawDiff.split('\n').slice(0, maxDiffLines).join('\n').trim();
    } catch {
      try {
        const rawDiff = execFileSync('git', ['diff', 'HEAD~1', '--no-color', '-U2'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' });
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

function runMechanicalChecks(lane: Lane, comparisonRef?: string): { findings: MechanicalFinding[]; summary: string } {
  const cwd = lane.worktreePath || lane.repoPath;
  const safeBase = comparisonRef && isSafeGitRef(comparisonRef)
    ? comparisonRef
    : isSafeGitRef(lane.baseBranch) ? lane.baseBranch : null;
  const findings: MechanicalFinding[] = [];

  // ── Diff stats check ──
  let stat = '';
  try {
    stat = execFileSync('git', ['diff', '--stat', safeBase ? `${safeBase}...HEAD` : 'HEAD~1'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
  } catch {
    try {
      stat = execFileSync('git', ['diff', '--stat', 'HEAD~1'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
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
    rawDiff = execFileSync('git', ['diff', safeBase ? `${safeBase}...HEAD` : 'HEAD~1', '--no-color'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    try {
      rawDiff = execFileSync('git', ['diff', 'HEAD~1', '--no-color'], { windowsHide: true, cwd, timeout: 10_000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
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
  deviations?: PacketDeviations | null,
  taskContract?: PacketTaskContract | null,
  taskContractRequired = false,
): string {
  const mergeGateSection = mergeGateResult ? formatMergeGateForReview(mergeGateResult) : null;
  const reviewRisk = classifyReviewRisk(changedFiles, addedLines);
  const adversarialReviewProtocol = buildAdversarialReviewProtocol(reviewRisk.tier);
  const worktreePath = reviewWorktreePath || lane.worktreePath || lane.repoPath;
  return buildAutoReviewPromptV1({
    lane: {
      id: lane.id,
      label: lane.label,
      branch: lane.branch,
      packetId: lane.packetId,
    },
    depth,
    worktreePath,
    diffSummary,
    selfReviewSection: formatSelfReview(selfReview, depth),
    deviationsEntries: deviations?.entries ?? [],
    mergeGateSection,
    mechanicalChecksSummary,
    reviewScreenshot,
    adversarialReviewProtocol,
    taskContract,
    taskContractRequired,
  });
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
  if (cancelledReviewLanes.has(lane.id)) {
    console.log(`[auto-review] Lane ${lane.id} was released before review — skipping`);
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

  // #1490 — capture worker deviations from the worktree notes file and stamp
  // them onto the packet so the review surfaces + the auto-reviewer both see
  // where the worker went off-plan. Null (no notes file / no heading) persists
  // as null so the surfaces render the asserted "No deviations reported" line.
  let deviations: PacketDeviations | null = null;
  let taskContractRequired = false;
  if (lane.packetId) {
    try {
      deviations = readPacketDeviations(lane.worktreePath || lane.repoPath, lane.packetId);
      const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
      taskContractRequired = readOrchestratorControlPlaneState().packets
        .find((packet) => packet.id === lane.packetId)?.taskContractRequired === true;
      const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
      await patchMissionPacket(lane.packetId, {
        deviations: deviations ?? null,
        taskContract: completionContext?.taskContract ?? null,
      });
    } catch (error) {
      console.warn(`[auto-review] Failed to capture deviations for lane ${lane.id}:`, error);
    }
  }

  const depth = deriveReviewDepth(completionContext?.selfReview);
  const mergeGateResult = await runMergeGate(lane, completionContext?.selfReview);
  const comparisonRef = mergeGateResult.diffBase?.mergeBase
    ?? mergeGateResult.diffBase?.comparisonRef;
  const mechanicalChecks = runMechanicalChecks(lane, comparisonRef);
  const diffSummary = getDiffSummary(lane, depth, comparisonRef);
  const reviewRisk = classifyReviewRisk(diffSummary.changedFiles, diffSummary.addedLines);
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
    deviations,
    completionContext?.taskContract,
    taskContractRequired,
  );

  if (cancelledReviewLanes.has(lane.id)) {
    console.log(`[auto-review] Lane ${lane.id} was released while preparing review — skipping`);
    return;
  }

  // Dual-path routing (epic #1044): the `inAppOrchestratorEnabled` toggle is
  // now a runtime selector, not an on/off gate.
  //   - toggle OFF (default) → Codex GPT-5.6 Sol xhigh runs the review through
  //     the connected Codex subscription.
  //   - toggle ON              → the resident Claude Code harness runs the
  //     review with the model source selected in Settings > Models.
  // Both backends can call `submit_review` and `lane_command`. Fail-closed
  // approval is enforced by the durable review gate (`requiresSecondPass`),
  // not by backend capability asymmetry.
  // Backend selected via the orchestrator-backend registry (#1075). Behavior
  // is byte-identical to the prior dual-path branch — see registry.ts.
  // #reviewer-split (2026-07-07): reviews resolve their OWN backend so the
  // accuracy-critical review can run on Claude while the bulk orchestrator
  // stays on Codex. 'follow' (default) = pre-split behavior.
  const reviewTurn = await runReviewerTurnWithQuotaFallback({
    laneId: lane.id,
    repoPath: lane.repoPath,
    threadId: `auto-review-${lane.id}-${review.id}`,
    surface: 'auto-review',
    prompt: (backendId) => backendId === 'codex'
      ? appendCodexAutoReviewVerdictInstructions(reviewPrompt)
      : reviewPrompt,
    onEvent: (turnBackend, event) => {
      if (event.type === 'text') {
        console.log(`[auto-review] ${turnBackend.label}: ${event.text.slice(0, 100)}`);
      } else if (event.type === 'tool_use') {
        console.log(`[auto-review] ${turnBackend.label} called tool: ${event.name}`);
      } else if (event.type === 'error') {
        console.error(`[auto-review] ${turnBackend.label} error: ${event.error}`);
      }
    },
  });
  if (cancelledReviewLanes.has(lane.id)) {
    console.log(`[auto-review] Lane ${lane.id} was released during review — discarding the result`);
    return;
  }
  if (!reviewTurn.ok) {
    throw new Error(`Review turn failed: ${reviewTurn.errors.join('; ').slice(0, 500)}`);
  }

  if (reviewTurn.backend === 'codex') {
    const recorded = await recordCodexAutoReviewVerdict({
      lane,
      rawText: reviewTurn.text,
      requiresSecondPass: reviewRisk.tier === 'high',
      reviewTurnId: reviewTurn.reviewTurnId,
      // #1812 — one stricter retry when the reviewer answers with prose. A
      // verdict that fails to parse is a reviewer outage, not a packet
      // rejection, so nothing is written against the packet if it fails twice.
      retry: {
        reviewPrompt,
        threadId: `auto-review-${lane.id}-${review.id}-verdict-retry`,
      },
    });
    if (recorded?.reviewUnavailable) {
      console.warn(`[auto-review] Codex review unavailable for lane ${lane.id} (${recorded.verdict.parseWarning}); existing verdict left untouched`);
    } else if (recorded?.verdict.parseWarning) {
      console.warn(`[auto-review] Codex verdict for lane ${lane.id} needed parser fallback: ${recorded.verdict.parseWarning}`);
    }
  }

  // #1491 — HTML packet explainer + quiz. Fire-and-forget so it never blocks
  // the review transition or the second-pass path below; the packet carries a
  // generating→ready|failed status and the surface degrades to the diff on
  // failure. Off when the operator disabled it.
  if (lane.packetId) {
    try {
      const { resolvePacketExplainerEnabledSync } = await import('@/lib/operator/defaults');
      if (resolvePacketExplainerEnabledSync()) {
        const { generatePacketExplainer } = await import('./packet-explainer');
        void generatePacketExplainer({
          lane,
          packetId: lane.packetId,
          packetTitle: lane.label || lane.branch,
          packetSummary: completionContext?.summary ?? '',
          diffSummary: diffSummary.summary,
          changedFileCount: diffSummary.changedFiles.length,
          deviationsRaw: deviations?.raw ?? null,
          reviewContext: mechanicalChecks.summary || '',
        }).catch((error) => {
          console.warn(`[auto-review] Explainer generation threw for lane ${lane.id}:`, error);
        });
      }
    } catch (error) {
      console.warn(`[auto-review] Failed to launch explainer for lane ${lane.id}:`, error);
    }
  }

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

  const blindPrompt = buildBlindSecondPassPrompt(
    lane,
    diffSummary,
    reviewRisk.reasons,
    completionContext?.taskContract,
    taskContractRequired,
  );
  const secondPassThreadId = `thoughts-second-pass-${lane.id}-${randomUUID().slice(0, 8)}`;
  let secondPassText = '';
  const secondPassErrors: string[] = [];

  console.log(`[auto-review] Sending blind second-pass review for lane ${lane.id}`);
  const secondPassTurn = await runReviewerTurnWithQuotaFallback({
    laneId: lane.id,
    repoPath: lane.repoPath,
    threadId: secondPassThreadId,
    surface: 'merge-gate-review',
    prompt: blindPrompt,
    onEvent: (turnBackend, event) => {
      if (event.type === 'text') {
        console.log(`[auto-review] ${turnBackend.label} second-pass: ${event.text.slice(0, 100)}`);
      } else if (event.type === 'tool_use') {
        console.log(`[auto-review] ${turnBackend.label} second-pass called tool: ${event.name}`);
      } else if (event.type === 'error') {
        console.error(`[auto-review] ${turnBackend.label} second-pass error: ${event.error}`);
      }
    },
  });
  secondPassText = secondPassTurn.text;
  secondPassErrors.push(...secondPassTurn.errors);

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
