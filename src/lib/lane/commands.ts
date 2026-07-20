/**
 * Lane Command Bus
 *
 * Single entry point for all lane mutations. Human UI, Claude orchestrator,
 * and automations all call the same verbs.
 *
 * Verbs: open_lane, bind_worktree, launch_session, attach_session,
 *        send_turn, interrupt, request_review, complete, archive
 */

import type {
  LaneCommand,
  LaneCommandResult,
  LaneEventActor,
  Lane,
} from '@/lib/lane/types';
import {
  createLane,
  getLane,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
  appendEvent,
} from '@/lib/lane/registry';
import { buildLanePolicyContext, createLaneActionApproval } from '@/lib/lane/commands-approval';
import { launchSession } from '@/lib/lane/commands-launch';
import { performRemoteCustomerMerge } from '@/lib/lane/commands-remote-merge';
import { worktreeExistsOnDisk } from '@/lib/lane/commands-worktree';
import { parsePullRequestNumber } from '@/lib/lane/pr-number';
import { rebindLaneSessionIfChanged } from '@/lib/lane/session-rebind';
import { isProtectedBranch } from '@/lib/lane/policy';
import { evaluatePolicy } from '@/lib/approvals/policies';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/dispatch';
import { assessDurableApprovedReview, hasDurableApprovedReview } from '@/lib/lane/durable-review-approval';
import { decideSurfaceMerge } from '@/lib/lane/surface-merge-decision';
import { resolveRequireApprovalSync } from '@/lib/operator/defaults';
import { formatOversizedFiles, getOversizedChangedFilesForLane } from '@/lib/lane/file-size-policy';
import { runMergeGate, formatMergeGateViolations } from '@/lib/lane/merge-gate';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import { performWorktreeSideMerge } from '@/lib/lane/worktree-side-merge';
import { dogfoodPrOnlyActive, DOGFOOD_PR_ONLY_NOTE } from '@/lib/lane/dogfood-guard';
import { resolveWorkerRouting } from '@/lib/agents/routing';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

/**
 * #2 Stage 5b — worker-context merge governance. A dispatched worker that calls
 * `o8 packet approve-merge` cannot merge its own work to main; this raises an
 * operator approval card (the SAME primitive + lane-merge continuation as the
 * file-size gate above). When the operator approves it, /api/panel/approvals
 * dispatches the continuation through the full merge gate. Capability symmetry
 * for the agent, the review-inversion moat intact for the operator.
 */
export async function raiseWorkerMergeApproval(
  lane: Lane,
  input: { commitMessage?: string; expectedHeadSha?: string; reviewSummary?: string } = {},
): Promise<LaneCommandResult> {
  return createLaneActionApproval(lane, 'orchestrator', {
    verb: 'merge',
    commitMessage: input.commitMessage,
    expectedHeadSha: input.expectedHeadSha,
    reviewSummary: input.reviewSummary,
    title: 'Worker requested merge to main',
    description: 'A dispatched worker reached the merge step via `o8 packet approve-merge`. Per governance a worker cannot merge its own work to main — approve to run the merge through the gate, or reject to send it back.',
    summary: `Worker merge request: ${lane.branch} → ${lane.baseBranch}`,
    risk: 'medium',
    policyRuleId: 'worker-merge-governance',
    note: 'Worker-initiated merge held for operator approval.',
  });
}

export async function dispatch(command: LaneCommand): Promise<LaneCommandResult> {
  const actor: LaneEventActor = command.actor ?? 'user';

  switch (command.verb) {
    case 'open_lane': {
      const workerRouting = resolveWorkerRouting({
        requestedRuntime: command.runtime,
        source: 'lane-open',
      });
      const existing = (await import('@/lib/lane/registry')).findLaneByRepoAndBranch(
        command.repoPath,
        command.branch,
      );
      if (existing) {
        if (!listDispatchableRuntimes({ includeExperimental: true }).includes(existing.runtime)) {
          return {
            ok: false,
            laneId: existing.id,
            note: `Runtime "${existing.runtime}" is not dispatchable (existing lane ${existing.id}). Dispatchable: ${listDispatchableRuntimes({ includeExperimental: true }).join(', ')}. Archive or migrate the lane before launching new work.`,
            lane: existing,
          };
        }
        const updatedExisting = command.packetId && existing.packetId !== command.packetId
          ? updateLane(existing.id, { packetId: command.packetId }, actor) ?? existing
          : existing;
        return { ok: true, laneId: updatedExisting.id, note: 'Lane already exists for this repo and branch.', lane: updatedExisting };
      }

      const lane = createLane({
        repoPath: command.repoPath,
        projectId: command.projectId,
        branch: command.branch,
        baseBranch: command.baseBranch,
        runtime: workerRouting.selectedRuntime,
        label: command.label,
        packetId: command.packetId,
        ownership: command.ownership,
        actor,
      });

      return { ok: true, laneId: lane.id, note: `Lane opened: ${lane.label}. ${workerRouting.reason}`, lane };
    }

    case 'bind_worktree': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = updateLane(
        command.laneId,
        { worktreePath: command.worktreePath },
        actor,
      );
      return { ok: true, laneId: command.laneId, note: `Worktree bound: ${command.worktreePath}`, lane: updated ?? undefined };
    }

    case 'launch_session': {
      return launchSession(command, actor);
    }

    case 'attach_session': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      const updated = attachSession(command.laneId, command.sessionKey, actor);
      return { ok: true, laneId: command.laneId, note: `Session attached: ${command.sessionKey}`, lane: updated ?? undefined };
    }

    case 'send_turn': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session on this lane.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = await performRuntimeAction({
          action: 'steer',
          surfaceId: lane.sessionKey,
          message: command.message,
        });

        if (result.ok) {
          rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
          setLaneStatus(command.laneId, 'running', actor, 'turn_sent');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Send failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'interrupt': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.sessionKey) return { ok: false, laneId: command.laneId, note: 'No active session to interrupt.' };

      try {
        const { performRuntimeAction } = await import('@/lib/runtime/actions');
        const result = await performRuntimeAction({
          action: 'interrupt',
          surfaceId: lane.sessionKey,
        });

        if (result.ok) {
          setLaneStatus(command.laneId, 'paused', actor, 'interrupted');
        }

        return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Interrupt failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'stop': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // 1) Flag the packet operator-stopped FIRST, inside the control-plane lock.
      //    The order is the correctness point: interrupting the session can end it
      //    and trip a stall/ralph requeue, and a concurrent dispatch tick reads
      //    state under the same lock — setting operatorStopped + held atomically
      //    here means getDispatchBlocker rejects every relaunch path before the
      //    interrupt can race a re-dispatch in. (2026-06-22)
      if (lane.packetId) {
        try {
          const { withLockedState } = await import('@/lib/orchestrator/control-plane');
          await withLockedState((state) => {
            const packet = state.packets.find((candidate) => candidate.id === lane.packetId);
            if (!packet) return;
            packet.operatorStopped = true;
            packet.queueState = 'held';
            packet.status = 'blocked';
            packet.blockedReason = 'operator_stopped';
            packet.lastEventAt = new Date().toISOString();
            packet.lastEventLabel = 'operator_stopped';
          });
        } catch (err) {
          console.warn('[lane] stop: could not mark packet operator-stopped', err);
        }
      }

      // 2) Interrupt the live session if one exists. Truthful status matters:
      //    only show paused after the runtime confirms the worker is gone.
      let stopOk = true;
      let stopNote = 'No active session was attached.';
      if (lane.sessionKey) {
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          const result = await performRuntimeAction({ action: 'stop', surfaceId: lane.sessionKey });
          stopOk = result.ok || result.status === 'completed';
          stopNote = result.note;
        } catch (err) {
          stopOk = false;
          stopNote = err instanceof Error ? err.message : 'Interrupt failed.';
        }
      }

      if (!stopOk) {
        appendEvent(command.laneId, 'interrupt_failed', actor, {
          packetId: lane.packetId,
          sessionKey: lane.sessionKey,
          note: stopNote,
        });
        setLaneStatus(command.laneId, 'running', actor, 'interrupt_failed');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Stop guard is held, but the live worker did not exit: ${stopNote}`,
          lane: getLane(command.laneId) ?? undefined,
        };
      }

      setLaneStatus(command.laneId, 'paused', actor, 'operator_stopped');
      return {
        ok: true,
        laneId: command.laneId,
        note: 'Agent stopped. It will not auto-redispatch — reset or relaunch to continue.',
        lane: getLane(command.laneId) ?? undefined,
      };
    }

    case 'resume': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // If lane has a live session, resume it with a message
      if (lane.sessionKey && command.message) {
        try {
          const { performRuntimeAction } = await import('@/lib/runtime/actions');
          const result = await performRuntimeAction({
            action: 'steer',
            surfaceId: lane.sessionKey,
            message: command.message,
          });
          if (result.ok) {
            rebindLaneSessionIfChanged(command.laneId, lane.sessionKey, result.sessionKey, actor);
            setLaneStatus(command.laneId, 'running', actor, 'resumed');
          }
          return { ok: result.ok, laneId: command.laneId, note: result.note, lane: getLane(command.laneId) ?? undefined };
        } catch {
          // Session dead — fall through to re-launch
        }
      }

      // No session or session dead — re-launch in the same worktree
      const prompt = command.message || 'Continue the previous task. Check what was done and what remains.';
      setLaneStatus(command.laneId, 'launching', actor, 'relaunching');

      try {
        const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
        const result = await launchRuntimeSurface({
          runtime: lane.runtime,
          prompt,
          repoPath: lane.worktreePath ?? lane.repoPath,
          projectRepoPath: lane.repoPath,
          baseBranch: lane.baseBranch,
          isolate: false,
          skipSetup: true,
          existingLaneId: command.laneId,
          packetId: lane.packetId ?? undefined,
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        setLaneStatus(command.laneId, 'running', actor, 'resumed');

        // Register with supervisor (ws-server process) via HTTP
        try {
          const { wsPort } = resolvePortInfo();
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({ surfaceId: result.surfaceId, repoPath: lane.repoPath, name: lane.label || lane.branch, prompt }),
            signal: AbortSignal.timeout(3000),
          });
        } catch { /* best effort */ }

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `Resumed in ${lane.worktreePath ?? lane.repoPath}.`, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_error');
        const message = err instanceof Error ? err.message : 'Resume failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'request_review': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      // #454 — Guard: auto-commit dirty worktrees before allowing review transition
      const reviewCwd = lane.worktreePath ?? lane.repoPath;
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: reviewCwd,
          maxBuffer: 10 * 1024 * 1024,
        });
        if (porcelain.trim().length > 0) {
          console.log(`[lane] request_review: dirty worktree detected in ${reviewCwd}, auto-committing`);
          await execFileAsync('git', ['add', '-A', '--', '.'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
          // Unstage o8-injected worktree artifacts so they never land in the review
          // commit: the safety-hook `.claude/settings.json` (otherwise blows the
          // diff-budget merge gate) and the `node_modules` symlink (otherwise pollutes
          // the target repo's main). Use `git reset` to unstage rather than a negative
          // `git add` pathspec — the latter errors ("paths are ignored") when an ignored
          // dir like node_modules exists in the worktree.
          await execFileAsync('git', ['reset', '-q', '--', '.claude', 'node_modules'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
          await execFileAsync('git', ['commit', '-m', 'auto-commit: agent work before review'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
        }
      } catch (err) {
        console.warn(`[lane] request_review: git status/commit check failed for ${reviewCwd}:`, err);
        // Non-fatal — proceed with the review transition even if the commit check fails
      }

      // Empty-commit guard — if the worktree has zero commits ahead of base
      // AND the working tree is clean, the runtime reported success but produced
      // no diff. Surface this as a failed lane with a clear note instead of
      // opening an empty review packet. (Observed with Gemini 3.1 Pro: emitted
      // a clean <self-review> block but never actually landed a commit.)
      try {
        const baseBranch = lane.baseBranch || 'main';
        const probe = await probeNoChangesProduced(reviewCwd, baseBranch);
        if (probe.noChangesProduced) {
          const { parkHuddleReadyZeroDiffLane } = await import('@/lib/orchestrator/huddle-zero-diff');
          const huddlePark = await parkHuddleReadyZeroDiffLane(lane);
          if (huddlePark.parked) {
            console.warn(`[lane] request_review: ${command.laneId} produced no diff after huddle report — parking for orchestrator.`);
            return {
              ok: false,
              laneId: command.laneId,
              note: 'huddle_ready',
              lane: huddlePark.lane ?? undefined,
            };
          }
          console.warn(`[lane] request_review: ${command.laneId} has 0 commits ahead of ${baseBranch} — runtime reported success but produced no diff. Marking failed.`);
          const failed = setLaneStatus(command.laneId, 'failed', 'system', 'zero_diff_failed');
          return {
            ok: false,
            laneId: command.laneId,
            note: 'no_changes_produced',
            lane: failed ?? undefined,
          };
        }
      } catch (err) {
        console.warn(`[lane] request_review: empty-commit check failed for ${reviewCwd}:`, err);
        // Non-fatal — proceed; the review panel will show an empty diff at worst
      }

      const updated = setLaneStatus(command.laneId, 'reviewing', actor, 'review_requested');
      return { ok: true, laneId: command.laneId, note: 'Review requested.', lane: updated ?? undefined };
    }

    case 'create_pr': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to create PR from. Lane is on the main working tree.' };

      // Policy gate — require approval for PR creation
      const hasApprovedReview = actor === 'user' ? true : await hasDurableApprovedReview(lane);
      const prPolicy = evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', actor, {
        hasApprovedReview,
      }));
      if (prPolicy.requiresApproval && actor !== 'user') {
        return createLaneActionApproval(lane, actor, {
          verb: 'create_pr',
          commitMessage: command.commitMessage,
          reviewSummary: command.reviewSummary,
          title: 'Create pull request',
          description: command.reviewSummary || `Create PR from lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Create PR: ${lane.branch} → ${lane.baseBranch}`,
          risk: prPolicy.risk,
          policyRuleId: prPolicy.ruleId,
          note: `Approval required: ${prPolicy.reason}`,
        });
      }

      if (prPolicy.ruleId === 'auto_approve_orchestrator_review') {
        console.log(`[headless] Auto-approved orchestrator review for lane ${lane.id} (create_pr)`);
      }

      setLaneStatus(command.laneId, 'merging', actor, 'creating_pr');

      try {
        if (!lane.worktreePath || !(await worktreeExistsOnDisk(lane.worktreePath))) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Worktree not found on disk: ${lane.worktreePath ?? '<unset>'}`,
          };
        }

        // Commit any uncommitted changes first.
        // F32 (#1024): match the merge-path fix — only commit when there are
        // real uncommitted changes. --allow-empty here created duplicate
        // commits on every create_pr call when Codex had already committed.
        if (command.commitMessage) {
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('git', ['add', '-A'], { cwd: lane.worktreePath });
            const { stdout: porcelain } = await execFileAsync(
              'git', ['status', '--porcelain'],
              { cwd: lane.worktreePath, timeout: 5000 },
            );
            if (porcelain.trim()) {
              await execFileAsync('git', ['commit', '-m', command.commitMessage], { cwd: lane.worktreePath });
            }
          } catch {
            // May fail if nothing to commit — that's fine
          }
        }

        // Push branch
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('git', ['push', '-u', 'origin', lane.branch], { cwd: lane.worktreePath });

        // Create PR via gh CLI
        const prTitle = lane.label || `${lane.branch}`;
        const prResult = await execFileAsync('gh', [
          'pr', 'create',
          '--base', lane.baseBranch,
          '--head', lane.branch,
          '--title', prTitle,
          '--body', command.reviewSummary?.trim() || `Automated PR from lane \`${lane.id}\`.\n\nRuntime: ${lane.runtime}\nPacket: ${lane.packetId ?? 'none'}`,
        ], { cwd: lane.repoPath });

        const prUrl = prResult.stdout.trim();
        const prNumber = parsePullRequestNumber(prUrl);
        updateLane(command.laneId, {
          ...(prNumber !== null ? { prNumber } : {}),
          outcome: 'pr_opened',
          outcomeNote: `Pull request opened: ${prUrl}`,
        }, actor);
        setLaneStatus(command.laneId, 'reviewing', actor, 'pr_created');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `PR created: ${prUrl}`, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'pr_failed');
        const message = err instanceof Error ? err.message : 'PR creation failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
    }

    case 'merge': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      // #1173 — PR-only wall: refuse merge while the autonomous dogfood loop is driving.
      if (dogfoodPrOnlyActive()) return { ok: false, laneId: command.laneId, note: DOGFOOD_PR_ONLY_NOTE };
      const isRemoteCustomerLane = (lane.runtime as string) === 'remote-customer';
      if (!lane.worktreePath && !isRemoteCustomerLane) {
        return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };
      }

      // submit_review persists its ApprovalRecord before updating mission state.
      // Read that durable row before every budget check so an accepted finding
      // waives the same HEAD atomically from the merge gate's perspective.
      const durableReview = await assessDurableApprovedReview(lane);
      const orchestratorReviewedForBudget = command.orchestratorReviewed === true
        || durableReview.diffBudgetWaived;
      const oversizedFiles = await getOversizedChangedFilesForLane(lane);
      if (oversizedFiles.length > 0) {
        const largestFile = oversizedFiles[0];
        const fileSizePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
          orchestratorReviewed: orchestratorReviewedForBudget,
          fileSizeLimitExceeded: true,
        }));

        if (fileSizePolicy.requiresApproval && actor !== 'user') {
          return createLaneActionApproval(lane, actor, {
            verb: 'merge',
            commitMessage: command.commitMessage,
            expectedHeadSha: command.expectedHeadSha,
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
              'Original line count': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.originalLineCount),
              'Net line change': largestFile.originalLineCount === null ? 'unknown' : String(largestFile.lineCount - largestFile.originalLineCount),
              Threshold: String(FILE_SIZE_BLOCK_THRESHOLD_LINES),
            },
            note: `Approval required: ${fileSizePolicy.reason}`,
          });
        }
      }

      // ── Merge gate enforcement ──
      // Runs security, budget, and integrity checks. Block-level violations
      // force human approval regardless of auto-review status.
      //
      // When the orchestrator has already approved the review, pass that
      // through — the gate downgrades budget violations to warn so a
      // human-in-the-loop refactor with intentional large deletions can
      // land. Security + integrity always stay block-level. See F25 / #1001.
      const gateResult = await runMergeGate(lane, undefined, orchestratorReviewedForBudget);
      if (!gateResult.passed && actor !== 'user') {
        const blockCount = gateResult.violations.filter((v) => v.severity === 'block').length;
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: `Merge gate: ${blockCount} violation${blockCount === 1 ? '' : 's'}`,
          description: formatMergeGateViolations(gateResult.violations),
          summary: `Merge blocked: ${lane.branch} → ${lane.baseBranch}`,
          risk: 'high',
          policyRuleId: 'merge-gate-violation',
          note: 'Merge gate enforcement: human review required.',
          gateResult: { passed: gateResult.passed, violations: gateResult.violations, diffBase: gateResult.diffBase },
        });
      }

      // Durable approved-review precondition. Computed after the merge gate so
      // block-level gate findings still force an operator card regardless of review.
      let hasApprovedReview = actor === 'user' ? true : durableReview.approved;
      let surfaceReasons: string[] = [];
      if (actor !== 'user' && resolveRequireApprovalSync() === 'surface') {
        const surfaceDecision = await decideSurfaceMerge(lane, {
          passed: gateResult.passed,
          violations: gateResult.violations,
          diffBase: gateResult.diffBase,
        });
        hasApprovedReview = surfaceDecision.hasApprovedReview;
        surfaceReasons = surfaceDecision.reasons;
      }

      // Policy gate — require approval for merge
      const mergePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
        orchestratorReviewed: orchestratorReviewedForBudget,
        gatePassed: gateResult.passed,
        hasApprovedReview,
        surfaceReviewRequired: surfaceReasons.length > 0,
      }));
      const routesToDispatcher = mergePolicy.ruleId === 'surface-dispatcher-review';
      const dispatcherApprovalSatisfied = routesToDispatcher && command.surfaceDispatcherApproved === true;
      if (mergePolicy.requiresApproval && actor !== 'user' && !dispatcherApprovalSatisfied) {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
          reviewSummary: command.reviewSummary,
          title: routesToDispatcher ? 'Dispatcher review requested' : 'Merge lane',
          description: routesToDispatcher
            ? `This packet needs review before merge: ${surfaceReasons.join(' ')}`
            : command.reviewSummary || `Merge lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: routesToDispatcher
            ? `Review requested: ${lane.branch} → ${lane.baseBranch}`
            : `Merge: ${lane.branch} → ${lane.baseBranch}`,
          risk: mergePolicy.risk,
          policyRuleId: mergePolicy.ruleId,
          metadata: routesToDispatcher ? { 'Surface reasons': surfaceReasons.join(' | ') } : undefined,
          note: routesToDispatcher
            ? 'Review-worthy merge routed to the packet dispatcher.'
            : `Approval required: ${mergePolicy.reason}`,
        });
      }

      if (dispatcherApprovalSatisfied) {
        console.log(`[surface-approval] Dispatcher explicitly approved merge for lane ${lane.id}.`);
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

      if (!(await worktreeExistsOnDisk(worktreePath))) {
        setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
        return {
          ok: false,
          laneId: command.laneId,
          note: `Worktree not found on disk: ${worktreePath}`,
        };
      }

      return performWorktreeSideMerge({
        lane,
        command,
        actor,
        gateResult: { passed: gateResult.passed, violations: gateResult.violations },
        createLaneActionApproval,
      });
    }

    case 'complete': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };

      if (isProtectedBranch(lane.baseBranch) && lane.worktreePath) {
        // Protected target — require PR instead of direct complete
        setLaneStatus(command.laneId, 'reviewing', actor, 'review_required');
        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: 'Protected branch. Use create_pr or merge to complete.', lane: updated ?? undefined };
      }

      const updated = setLaneStatus(command.laneId, 'completed', actor, 'completed');
      return { ok: true, laneId: command.laneId, note: 'Lane completed.', lane: updated ?? undefined };
    }

    case 'archive': {
      const updated = archiveLane(command.laneId, actor);
      if (!updated) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      return { ok: true, laneId: command.laneId, note: 'Lane archived.', lane: updated };
    }

    default: {
      const _exhaustive: never = command;
      return { ok: false, laneId: '', note: `Unknown verb: ${(_exhaustive as LaneCommand).verb}` };
    }
  }
}
