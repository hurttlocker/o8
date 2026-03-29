/**
 * Auto-review trigger for the orchestrator loop.
 *
 * When a lane transitions to 'reviewing' (agent finished), this module
 * queues an orchestrator review message. The orchestrator reads the diff,
 * evaluates the work, and creates an approval with its verdict.
 *
 * This is the connecting tissue between agent completion and human approval.
 */

import { execSync } from 'node:child_process';
import type { Lane } from './types';

/** Lanes currently being reviewed — prevents duplicate review triggers */
const reviewingLanes = new Set<string>();

/**
 * Called when a lane transitions to 'reviewing' during reconciliation.
 * Fires asynchronously — does not block the reconciliation loop.
 */
export function triggerAutoReview(lane: Lane): void {
  if (reviewingLanes.has(lane.id)) return; // Already queued
  reviewingLanes.add(lane.id);

  console.log(`[auto-review] Queuing orchestrator review for lane ${lane.id} (${lane.label})`);

  // Fire async — don't block reconciliation
  void performAutoReview(lane).finally(() => {
    reviewingLanes.delete(lane.id);
  });
}

/**
 * Generate a diff summary for a lane's worktree compared to its base branch.
 */
const MAX_DIFF_LINES = 200;

function getDiffSummary(lane: Lane): string {
  const cwd = lane.worktreePath || lane.repoPath;
  try {
    // Get the diff stat
    let stat = '';
    try {
      stat = execSync(`git diff --stat ${lane.baseBranch}...HEAD`, { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
    } catch {
      try {
        stat = execSync('git diff --stat HEAD~1', { cwd, timeout: 10_000, encoding: 'utf-8' }).trim();
      } catch { /* no commits yet */ }
    }

    // Get a compact diff — truncate in Node.js instead of piping through head
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

/**
 * Build the review prompt for the orchestrator.
 */
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

/**
 * Send the review prompt to the orchestrator session.
 */
async function performAutoReview(lane: Lane): Promise<void> {
  try {
    const diffSummary = getDiffSummary(lane);
    const reviewPrompt = buildReviewPrompt(lane, diffSummary);

    // Import dynamically to avoid circular dependencies
    const { ensureOrchestratorSession, sendToOrchestrator } = await import('./orchestrator-session');
    const session = ensureOrchestratorSession(lane.repoPath);

    if (session.status === 'busy') {
      console.log(`[auto-review] Orchestrator busy — deferring review for lane ${lane.id}`);
      // Retry after a delay
      setTimeout(() => {
        reviewingLanes.delete(lane.id);
        triggerAutoReview(lane);
      }, 30_000);
      return;
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
  } catch (err) {
    console.error(`[auto-review] Failed to review lane ${lane.id}:`, err instanceof Error ? err.message : err);
  }
}
