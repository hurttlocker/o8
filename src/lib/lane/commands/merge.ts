import type {
  LaneCommand,
  LaneCommandResult,
  LaneEventActor,
} from '@/lib/lane/types';
import type { ApprovalRisk } from '@/lib/approvals/types';
import { createApproval } from '@/lib/approvals/store';
import { evaluatePolicy } from '@/lib/approvals/policies';
import { formatMergeGateViolations, runMergeGate } from '@/lib/lane/merge-gate';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/dispatch';
import {
  buildLanePolicyContext,
  createLaneActionApproval,
  formatOversizedFiles,
  getOversizedChangedFilesForLane,
} from '@/lib/lane/commands/approvals';
import { getLane, setLaneStatus, updateLane } from '@/lib/lane/registry';
import { runLaneRebaseTypecheck } from '@/lib/lane/rebase-typecheck';
import { performRemoteCustomerMerge } from '@/lib/lane/commands/remote-merge';

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;

export async function handleMergeCommand(
  command: MergeCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  const lane = getLane(command.laneId);
  if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
  const isRemoteCustomerLane = (lane.runtime as string) === 'remote-customer';
  if (!lane.worktreePath && !isRemoteCustomerLane) {
    return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
  }

  const oversizedFiles = await getOversizedChangedFilesForLane(lane);
  if (oversizedFiles.length > 0) {
    const largestFile = oversizedFiles[0];
    const fileSizePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
      orchestratorReviewed: command.orchestratorReviewed,
      fileSizeLimitExceeded: true,
    }));

    if (fileSizePolicy.requiresApproval && actor !== 'user') {
      return createLaneActionApproval(lane, actor, {
        verb: 'merge',
        commitMessage: command.commitMessage,
        reviewSummary: command.reviewSummary,
        title: 'Override file size limit',
        description: `Merge blocked by file size governance. Oversized changed file${oversizedFiles.length === 1 ? '' : 's'}: ${formatOversizedFiles(oversizedFiles)}. Operator approval is required to override.`,
        summary: `File size limit override: ${lane.branch} → ${lane.baseBranch}`,
        risk: fileSizePolicy.risk,
        policyRuleId: fileSizePolicy.ruleId,
        metadata: {
          'File path': oversizedFiles.length === 1
            ? largestFile.path
            : `${largestFile.path} (+${oversizedFiles.length - 1} more)`,
          'Current line count': String(largestFile.lineCount),
          Threshold: String(FILE_SIZE_BLOCK_THRESHOLD_LINES),
        },
        note: `Approval required: ${fileSizePolicy.reason}`,
      });
    }
  }

  // ── Merge gate enforcement ──
  // Runs security, budget, and integrity checks. Block-level violations
  // force human approval regardless of auto-review status.
  const gateResult = runMergeGate(lane);
  if (!gateResult.passed && actor !== 'user') {
    const blockCount = gateResult.violations.filter((v) => v.severity === 'block').length;
    return createLaneActionApproval(lane, actor, {
      verb: 'merge',
      commitMessage: command.commitMessage,
      reviewSummary: command.reviewSummary,
      title: `Merge gate: ${blockCount} violation${blockCount === 1 ? '' : 's'}`,
      description: formatMergeGateViolations(gateResult.violations),
      summary: `Merge blocked: ${lane.branch} → ${lane.baseBranch}`,
      risk: 'high',
      policyRuleId: 'merge-gate-violation',
      note: 'Merge gate enforcement: human review required.',
      gateResult: { passed: gateResult.passed, violations: gateResult.violations },
    });
  }

  // Policy gate — require approval for merge
  const mergePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
    orchestratorReviewed: command.orchestratorReviewed,
  }));
  if (mergePolicy.requiresApproval && actor !== 'user') {
    return createLaneActionApproval(lane, actor, {
      verb: 'merge',
      commitMessage: command.commitMessage,
      reviewSummary: command.reviewSummary,
      title: 'Merge lane',
      description: command.reviewSummary || `Merge lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
      summary: `Merge: ${lane.branch} → ${lane.baseBranch}`,
      risk: mergePolicy.risk,
      policyRuleId: mergePolicy.ruleId,
      note: `Approval required: ${mergePolicy.reason}`,
    });
  }

  if (mergePolicy.ruleId === 'auto_approve_orchestrator_review') {
    console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (merge)`);
  }

  setLaneStatus(command.laneId, 'merging', actor, 'merging');

  if (isRemoteCustomerLane) {
    return performRemoteCustomerMerge(lane, command, actor);
  }

  const worktreePath = lane.worktreePath;
  if (!worktreePath) {
    return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
  }

  try {
    const { getWorktreeManager } = await import('@/lib/worktree/launch');
    const mgr = getWorktreeManager(lane.repoPath);
    const worktrees = await mgr.list();
    const worktree = worktrees.find((wt) => wt.path === worktreePath);
    if (!worktree) {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
      return { ok: false, laneId: command.laneId, note: 'Worktree not found on disk.' };
    }

    // Commit any uncommitted changes
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    if (command.commitMessage) {
      try {
        await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
        await execFileAsync('git', ['commit', '-m', command.commitMessage, '--allow-empty'], { cwd: worktreePath });
      } catch { /* nothing to commit */ }
    }

    // Resolve actual branch name from the worktree (may differ from lane.branch
    // when the worktree manager generates its own branch naming convention)
    const actualBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath })).stdout.trim();
    console.log(`[lane-merge] Actual worktree branch: ${actualBranch} (lane.branch: ${lane.branch})`);

    // ── Rebase onto latest baseBranch HEAD ──
    // When parallel agents dispatch from the same HEAD, later branches become
    // stale after earlier merges. Rebasing first auto-resolves same-file-
    // different-section changes that would otherwise look like conflicts.
    let rebaseFailed = false;
    try {
      await execFileAsync('git', ['rebase', lane.baseBranch], { cwd: worktreePath });
      console.log(`[lane-merge] Rebased ${actualBranch} onto ${lane.baseBranch}`);
    } catch {
      // Rebase had true conflicts — abort and fall through to direct merge
      try { await execFileAsync('git', ['rebase', '--abort'], { cwd: worktreePath }); } catch { /* already clean */ }
      rebaseFailed = true;
      console.log(`[lane-merge] Rebase failed for ${actualBranch}, attempting direct merge`);
    }

    // (#482) Typecheck after rebase — catches integration drift that agents
    // can't detect in their isolated branches. Only run if rebase succeeded
    // (if rebase failed, we're about to try direct merge which has its own risks).
    if (!rebaseFailed) {
      const typecheck = await runLaneRebaseTypecheck({
        cwd: worktreePath,
        actualBranch,
        logPrefix: 'lane-merge',
      });
      if (!typecheck.ok) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'typecheck_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Typecheck failed after rebase onto ${lane.baseBranch}. Fix type errors before merging.\n\n${typecheck.output}`,
        };
      }
    }

    // Manual strategy — operator chose to fix conflicts in terminal
    if (command.strategy === 'manual') {
      setLaneStatus(command.laneId, 'awaiting_input', actor, 'manual_resolution');
      return { ok: true, laneId: command.laneId, note: 'Lane parked for manual conflict resolution.' };
    }

    // Tag the tip commit with a [via-o8] suffix so the public changelog
    // can render a "made by o8" pill on entries that shipped through the
    // dispatch loop. Best-effort: any failure here must not block the merge.
    try {
      const { stdout: tipSubject } = await execFileAsync('git', ['log', '-1', '--pretty=%s'], { cwd: worktreePath });
      const subject = tipSubject.trim();
      if (subject && !subject.includes('[via-o8]')) {
        await execFileAsync('git', ['commit', '--amend', '-m', `${subject} [via-o8]`, '--allow-empty'], { cwd: worktreePath });
      }
    } catch { /* best-effort — merge continues regardless */ }

    // F10 — Auto-stash unrelated dirty work on the main repo's working tree
    // before checkout, so an operator with uncommitted edits in unrelated
    // files doesn't have to manually stash before approve_and_merge can
    // succeed. Restored in the finally below regardless of merge outcome.
    let stashKey: string | null = null;
    try {
      const { stdout: porcelain } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        { cwd: lane.repoPath },
      );
      if (porcelain.trim().length > 0) {
        stashKey = `o8-lane-merge-${lane.id}-${Date.now()}`;
        try {
          await execFileAsync(
            'git',
            ['stash', 'push', '--include-untracked', '-m', stashKey],
            { cwd: lane.repoPath },
          );
          console.log(`[lane-merge] Auto-stashed dirty working tree on ${lane.repoPath} as "${stashKey}"`);
        } catch (stashErr) {
          // Stash itself failed — clear the key so finally doesn't try to pop
          // a stash that doesn't exist. Continue with merge attempt; if the WT
          // is truly dirty, the existing F3 dirty-working-tree classification
          // will surface a clean error to the operator.
          stashKey = null;
          console.warn(
            `[lane-merge] Auto-stash failed on ${lane.repoPath} (continuing): ${stashErr instanceof Error ? stashErr.message : String(stashErr)}`,
          );
        }
      }
    } catch { /* status probe failed — skip stash, fall through */ }

    // Perform merge using the actual branch ref
    const savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: lane.repoPath })).stdout.trim();

    // Track whether stash needs popping on the way out. Set false once the
    // finally has run so we don't double-pop on the outer catch.
    let stashPendingPop = stashKey !== null;
    let stashPopFailed = false;
    let stashPopError: string | undefined;
    const popStashIfNeeded = async () => {
      if (!stashPendingPop || !stashKey) return;
      stashPendingPop = false;
      try {
        await execFileAsync('git', ['stash', 'pop'], { cwd: lane.repoPath });
        console.log(`[lane-merge] Popped auto-stash "${stashKey}" on ${lane.repoPath}`);
      } catch (popErr) {
        stashPopFailed = true;
        stashPopError = popErr instanceof Error ? popErr.message : String(popErr);
        console.warn(
          `[lane-merge] Auto-stash pop conflict on ${lane.repoPath} — operator's work parked under stash "${stashKey}". Recover with: git stash list | grep "${stashKey}" then git stash pop <ref>. Error: ${stashPopError}`,
        );
      }
    };

    try {
      await execFileAsync('git', ['checkout', lane.baseBranch], { cwd: lane.repoPath });

    try {
      const mergeArgs = ['merge', '--no-ff', '-m', `Merge lane ${lane.label} (${actualBranch})`];
      if (command.strategy === 'ours' || command.strategy === 'theirs') {
        mergeArgs.push('-X', command.strategy);
      }
      mergeArgs.push(actualBranch);
      await execFileAsync('git', mergeArgs, { cwd: lane.repoPath });
    } catch (mergeErr) {
      // #459 — Real conflict: rollback and escalate via approval card
      // Extract conflict file list before aborting
      let conflictFiles: string[] = [];
      try {
        const { stdout: unmerged } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: lane.repoPath });
        conflictFiles = unmerged.trim().split('\n').filter(Boolean);
      } catch { /* best effort */ }

      try { await execFileAsync('git', ['merge', '--abort'], { cwd: lane.repoPath }); } catch { /* already clean */ }
      await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });
      // Pop the auto-stash now that we're back on the operator's branch so
      // their dirty work is restored before we surface the approval card.
      await popStashIfNeeded();

      const conflictMessage = mergeErr instanceof Error ? mergeErr.message : 'Merge failed.';
      // When `git diff --diff-filter=U` returned zero files, the merge
      // failed for a non-conflict reason (dirty working tree, invalid
      // branch ref, refusing unrelated histories, etc). Calling that a
      // "conflict" with "0 conflicting files" reads as a UI bug; classify
      // it so the operator sees what actually broke.
      const isRealConflict = conflictFiles.length > 0;
      const lowerMsg = conflictMessage.toLowerCase();
      const failureCategory = isRealConflict
        ? 'conflict'
        : lowerMsg.includes('would be overwritten') || lowerMsg.includes('local changes')
          ? 'dirty-working-tree'
          : lowerMsg.includes('refusing to merge unrelated histories')
            ? 'unrelated-histories'
            : lowerMsg.includes('not a valid object name') || lowerMsg.includes('unknown revision')
              ? 'invalid-branch'
              : 'merge-failed';
      const conflictDetail = rebaseFailed
        ? `Rebase failed, merge also failed: ${conflictMessage}`
        : `Merge failed after rebase: ${conflictMessage}`;
      const conflictFileList = isRealConflict
        ? `\n\nConflicting files:\n${conflictFiles.map((f) => `- ${f}`).join('\n')}`
        : '';
      const cardTitle = isRealConflict
        ? `Merge conflict: ${lane.label}`
        : failureCategory === 'dirty-working-tree'
          ? `Merge blocked: ${lane.label} (main has uncommitted changes)`
          : failureCategory === 'unrelated-histories'
            ? `Merge blocked: ${lane.label} (unrelated histories)`
            : failureCategory === 'invalid-branch'
              ? `Merge blocked: ${lane.label} (invalid branch ref)`
              : `Merge failed: ${lane.label}`;
      const cardSummary = isRealConflict
        ? `Merge conflict on ${lane.branch} → ${lane.baseBranch}. ${conflictFiles.length} file${conflictFiles.length === 1 ? '' : 's'} conflicting.`
        : failureCategory === 'dirty-working-tree'
          ? `Cannot merge ${lane.branch} → ${lane.baseBranch}: working tree on ${lane.baseBranch} has uncommitted changes. Commit or stash, then retry.`
          : failureCategory === 'unrelated-histories'
            ? `Cannot merge ${lane.branch} → ${lane.baseBranch}: branches share no common history.`
            : failureCategory === 'invalid-branch'
              ? `Cannot merge ${lane.branch} → ${lane.baseBranch}: branch ref is missing or invalid.`
              : `Merge of ${lane.branch} → ${lane.baseBranch} failed: ${conflictMessage}`;
      const cardNote = isRealConflict
        ? `Merge conflict escalated to operator. ${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}.`
        : `Merge escalated to operator (${failureCategory}): ${conflictMessage}`;

      // Create an approval card so the operator sees the failure instead of silent stall
      return createLaneActionApproval(lane, actor, {
        verb: 'merge',
        commitMessage: command.commitMessage,
        reviewSummary: command.reviewSummary,
        title: cardTitle,
        description: `${conflictDetail}${conflictFileList}\n\nPick a resolution strategy: Ours (keep base), Theirs (keep branch), or Manual (park for terminal fix).`,
        summary: cardSummary,
        risk: 'high' as ApprovalRisk,
        policyRuleId: isRealConflict ? 'merge_conflict_escalation' : 'merge_failure_escalation',
        metadata: {
          ConflictFiles: conflictFiles.join(', ') || (isRealConflict ? 'unknown' : 'n/a'),
          FailureCategory: failureCategory,
        },
        note: cardNote,
        gateResult: { passed: gateResult.passed, violations: gateResult.violations },
        conflictReport: {
          files: conflictFiles,
          mergeError: conflictMessage,
        },
      });
    }

    await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });
    } finally {
      // F10 — Always restore the operator's auto-stashed work, whether the
      // merge succeeded, escalated, or threw. The early-return paths above
      // call popStashIfNeeded() explicitly; this finally is the safety net
      // for the success path and any thrown error.
      await popStashIfNeeded();
    }

    // F10 — If the auto-stash pop conflicted with the merged result (rare:
    // operator's stashed work touched files the lane also touched), the
    // merge has already committed on baseBranch. We surface a non-blocking
    // advisory so they can recover their parked stash by name. Use a
    // standalone approval (not createLaneActionApproval) so it doesn't flip
    // the lane back to awaiting_input — the merge itself succeeded.
    if (stashPopFailed && stashKey) {
      try {
        createApproval({
          source: 'runtime',
          runtime: lane.runtime,
          agent: lane.label || lane.branch,
          sessionKey: lane.sessionKey || `lane:${lane.id}`,
          title: `Auto-stash pop conflict: ${lane.label}`,
          description: `The lane merge succeeded, but restoring your auto-stashed working-tree changes on ${lane.repoPath} hit a conflict. Your work is safe — it's parked under stash "${stashKey}".\n\nRecover with:\n\n    cd ${lane.repoPath}\n    git stash list | grep "${stashKey}"\n    git stash pop <stash-ref>\n\nGit error: ${stashPopError ?? 'unknown'}`,
          summary: `Stash pop conflicted after merging ${lane.branch} — your work is parked under stash "${stashKey}".`,
          risk: 'medium' as ApprovalRisk,
          policyRuleId: 'auto_stash_pop_conflict',
          metadata: {
            Lane: lane.id,
            Branch: lane.branch,
            Base: lane.baseBranch,
            Runtime: lane.runtime,
            StashKey: stashKey,
            StashError: stashPopError ?? 'unknown',
          },
        });
      } catch (advisoryErr) {
        console.warn(
          `[lane-merge] Failed to surface stash-pop-conflict advisory for "${stashKey}": ${advisoryErr instanceof Error ? advisoryErr.message : String(advisoryErr)}`,
        );
      }
    }

    // #534 — push the merge to origin. Failure here must NOT revert the merge:
    // the base branch already has the commit locally, and we want the operator
    // to see "merged locally, push failed" rather than rolling back a valid merge.
    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      await execFileAsync('git', ['push', 'origin', lane.baseBranch], {
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      pushedToOrigin = true;
      console.log(`[lane-merge] Pushed ${lane.baseBranch} to origin after merging ${actualBranch}`);
    } catch (pushErr) {
      pushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
      console.warn(`[lane-merge] Push to origin failed for ${lane.baseBranch} after merging ${actualBranch}: ${pushError}`);
    }

    // Cleanup worktree + prune any other stale worktrees in the background
    await mgr.cleanup(worktree.id, { force: true, deleteBranch: true });
    void mgr.prune().catch(() => {});
    updateLane(command.laneId, { worktreePath: null }, 'system');
    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

    // #538 — Post-merge decomposition pipeline. Scans files touched by the
    // merge commit for ceiling violations and auto-enqueues decomposition
    // packets. Failures are logged and swallowed — the merge is already
    // committed and must not roll back on a governance-layer error.
    let decompositionNote = '';
    try {
      const { enqueueDecompositionsAfterMerge } = await import('@/lib/dispatch/decomposition-pipeline');
      const decomposition = await enqueueDecompositionsAfterMerge({
        repoPath: lane.repoPath,
        runtime: lane.runtime,
      });
      if (decomposition.enqueued > 0) {
        const names = decomposition.candidates
          .map((candidate) => candidate.relativePath)
          .join(', ');
        decompositionNote = ` Enqueued ${decomposition.enqueued} decomposition dispatch${decomposition.enqueued === 1 ? '' : 'es'} for over-ceiling file${decomposition.enqueued === 1 ? '' : 's'}: ${names}.`;
      }
    } catch (decompositionError) {
      console.warn(
        `[lane-merge] Decomposition scan failed for ${lane.repoPath}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
      );
    }

    const updated = getLane(command.laneId);
    const mergeNote = pushedToOrigin
      ? `Merged ${lane.branch} into ${lane.baseBranch} and pushed to origin.${decompositionNote}`
      : `Merged ${lane.branch} into ${lane.baseBranch} LOCALLY — push to origin failed: ${pushError ?? 'unknown error'}. Run \`git push origin ${lane.baseBranch}\` to ship the commit.${decompositionNote}`;
    return {
      ok: true,
      laneId: command.laneId,
      note: mergeNote,
      lane: updated ?? undefined,
      pushedToOrigin,
      pushError,
    };
  } catch (err) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    const message = err instanceof Error ? err.message : 'Merge failed.';
    return { ok: false, laneId: command.laneId, note: message };
  }
}
