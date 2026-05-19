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
import type { ApprovalRisk } from '@/lib/approvals/types';
import {
  createLane,
  getLane,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
  appendEvent,
} from '@/lib/lane/registry';
import { getLanePolicy, isProtectedBranch } from '@/lib/lane/policy';
import { getSqlite } from '@/lib/db';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { cleanupRemoteMergeWorktree, fetchWorkerBranch } from '@/lib/lane/remote-fetch';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES } from '@/lib/orchestrator/dispatch';
import { formatOversizedFiles, getOversizedChangedFilesForLane } from '@/lib/lane/file-size-policy';
import { checkExpectedHeadSha, formatHeadShaMismatchNote } from '@/lib/lane/head-sha-lock';
import { runMergeGate, formatMergeGateViolations } from '@/lib/lane/merge-gate';
import { probeNoChangesProduced } from '@/lib/lane/no-changes-produced';
import { runLaneRebaseTypecheck } from '@/lib/lane/rebase-typecheck';
import { PRODUCTION_AGENT_RUNTIME, resolveWorkerRouting } from '@/lib/agents/routing';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { fetchWorkerRun } from '@/lib/worker/runs';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { parseGitDiff } from '@/lib/worktree/diff-parser';

type MergeCommand = Extract<LaneCommand, { verb: 'merge' }>;

// F38 (#1030): the merge handler previously trusted WorktreeManager's in-memory
// list. Dev-bridge restarts wiped that state mid-packet, leaving the lane row
// pointing at a worktree the manager no longer knew about — even though the
// directory and its .git were sitting right there on disk. Bail behavior:
// "Worktree not found on disk" was wrong because nothing actually checked disk.
//
// This helper restores disk truth: it accepts a path and confirms it's a real
// worktree by checking for the directory + an inner .git entry (file pointer
// for linked worktrees, dir for standalone repos). No in-memory state involved.
async function worktreeExistsOnDisk(worktreePath: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const dirStat = await stat(worktreePath);
    if (!dirStat.isDirectory()) return false;
    const gitStat = await stat(`${worktreePath}/.git`);
    return gitStat.isFile() || gitStat.isDirectory();
  } catch {
    return false;
  }
}

async function getDiffForLane(lane: Pick<Lane, 'baseBranch' | 'worktreePath' | 'repoPath'>) {
  const cwd = lane.worktreePath || lane.repoPath;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', `${lane.baseBranch}...HEAD`, '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout.trim();
  } catch {
    try {
      const fallback = await execFileAsync('git', ['diff', 'HEAD~1', '--no-color'], { cwd, maxBuffer: 10 * 1024 * 1024 });
      return fallback.stdout.trim();
    } catch {
      return '';
    }
  }
}

async function recordReviewLessonsForApproval(
  approvalId: string,
  lane: Lane,
  reviewSummary: string | undefined,
  files: ReturnType<typeof parseGitDiff>,
) {
  const summary = reviewSummary?.trim();
  if (!summary) {
    return;
  }

  const findings = extractReviewFindings(summary);
  const patterns = extractReviewPatterns(summary, findings);
  const conflictZones = buildConflictZonesFromDiffFiles(files);
  const approved = /\b(approve|approved|looks correct|ready to merge|ship it)\b/i.test(summary)
    ? true
    : /\b(request changes|reject|den(y|ied)|not ready|blocked)\b/i.test(summary)
      ? false
      : findings.length === 0;

  recordApprovalAudit(approvalId, 'orchestrator_review', 'orchestrator', summary, {
    findings: findings.length > 0 ? findings : undefined,
    reviewer: 'orchestrator',
    approved,
    patterns: patterns.length > 0 ? patterns : undefined,
    conflictZones: conflictZones.length > 0 ? conflictZones : undefined,
  });

  if (!lane.packetId || !lane.sessionKey) {
    return;
  }

  try {
    const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
    await capturePacketCompletionContext(lane.packetId, lane.sessionKey);
  } catch (error) {
    console.error(`[context-relay] Failed to refresh reviewed packet context for ${lane.packetId}:`, error);
  }
}

function buildLanePolicyContext(
  lane: Pick<Lane, 'id' | 'repoPath'>,
  verb: 'create_pr' | 'merge',
  actor: LaneEventActor,
  opts?: { orchestratorReviewed?: boolean; fileSizeLimitExceeded?: boolean; gatePassed?: boolean },
) {
  // Auto-approve when:
  //   (a) headless auto-review is active, OR
  //   (b) the orchestrator already reviewed and approved the packet, OR
  //   (c) the merge gate fully passed (no security / budget / integrity
  //       violations) AND the caller is the orchestrator. F18 (#994):
  //       previously every clean orchestrator-driven merge still asked
  //       for an operator click; this lets the gate's pass verdict
  //       carry the trust forward.
  const autoReview = actor === 'orchestrator'
    && (
      isLaneAutoReviewInProgress(lane.id)
      || opts?.orchestratorReviewed === true
      || opts?.gatePassed === true
    );
  return buildPolicyContext('lane_command', {
    verb,
    laneId: lane.id,
    autoReview,
    fileSizeLimitExceeded: opts?.fileSizeLimitExceeded === true,
  }, {
    workspacePath: lane.repoPath,
  });
}

function isLaneAutoReviewInProgress(laneId: string) {
  try {
    const row = getSqlite()
      .prepare(`SELECT 1 FROM review_queue WHERE lane_id = ? AND status = 'in_progress' LIMIT 1`)
      .get(laneId);
    return Boolean(row);
  } catch {
    return false;
  }
}

async function createLaneActionApproval(
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
    expectedHeadSha?: string;
    reviewSummary?: string;
    title: string;
    description: string;
    summary: string;
    risk: ApprovalRisk;
    policyRuleId: string;
    metadata?: Record<string, string>;
    note: string;
    gateResult?: import('@/lib/approvals/types').ApprovalGateResult;
    conflictReport?: import('@/lib/approvals/types').ApprovalConflictReport;
    strategy?: import('@/lib/approvals/types').MergeStrategy;
  },
): Promise<LaneCommandResult> {
  const rawDiff = await getDiffForLane(lane);
  const files = parseGitDiff(rawDiff);
  const approval = createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: lane.label || lane.branch,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: input.title,
    description: input.description,
    summary: input.summary,
    diff: {
      path: 'multi-file',
      after: rawDiff || undefined,
      files,
    },
    gateResult: input.gateResult,
    conflictReport: input.conflictReport,
    risk: input.risk,
    policyRuleId: input.policyRuleId,
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Base: lane.baseBranch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
      ...(input.expectedHeadSha ? { 'Expected HEAD': input.expectedHeadSha } : {}),
      ...input.metadata,
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
      expectedHeadSha: input.expectedHeadSha,
      strategy: input.strategy,
    },
  });
  await recordReviewLessonsForApproval(approval.id, lane, input.reviewSummary, files);
  setLaneStatus(lane.id, 'awaiting_input', actor, 'approval_required');
  void publishRealtimeMutation({
    mutation: {
      mutationId: `approval-create-${approval.id}`,
      source: 'desktop',
      action: 'approve',
      sessionKey: approval.sessionKey,
      surfaceId: approval.sessionKey,
      status: 'pending',
      note: `Approval required: ${approval.title}`,
      createdAt: new Date().toISOString(),
    },
    refreshTargets: ['global', 'mobileInbox'],
    sessionKeys: [approval.sessionKey],
    fresh: true,
  });
  return { ok: false, laneId: lane.id, note: input.note, approvalId: approval.id };
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
        if (existing.runtime !== PRODUCTION_AGENT_RUNTIME) {
          return {
            ok: false,
            laneId: existing.id,
            note: `Production agent spawning is restricted to Codex. Existing lane ${existing.id} is ${existing.runtime}; archive or migrate it before launching new work.`,
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
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (lane.runtime !== PRODUCTION_AGENT_RUNTIME) {
        return {
          ok: false,
          laneId: command.laneId,
          note: `Production agent spawning is restricted to Codex. ${lane.runtime} is scaffolded for later but cannot launch yet.`,
          lane,
        };
      }

      const policy = getLanePolicy(lane.branch);
      if (!policy.branchWritable && !policy.requiresApproval) {
        return { ok: false, laneId: command.laneId, note: `Branch ${lane.branch} is not writable.` };
      }

      setLaneStatus(command.laneId, 'launching', actor, 'launching_session');

      try {
        const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
        const result = await launchRuntimeSurface({
          runtime: lane.runtime,
          prompt: command.prompt,
          repoPath: lane.worktreePath ?? lane.repoPath,
          projectRepoPath: lane.repoPath,
          // Bind the worktree to the lane's branch so the agent lands on
          // the correct branch from turn 0. Without this the manager fell
          // back to `worktree/<agent>/<slug>` and the agent had to self-
          // correct via `git checkout -b <lane.branch>` — weaker models
          // missed the hint and silently committed to the wrong branch.
          branchName: lane.branch,
          baseBranch: lane.baseBranch,
          model: command.model,
          isolate: !lane.worktreePath,
          skipSetup: true,
          existingLaneId: command.laneId,
          packetId: lane.packetId ?? undefined,
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'idle', 'system', 'launch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        if (result.worktree?.path && !lane.worktreePath) {
          updateLane(command.laneId, { worktreePath: result.worktree.path }, 'system');
        }
        setLaneStatus(command.laneId, 'running', actor, 'session_launched');

        // Register with supervisor for completion detection + stuck monitoring.
        // The supervisor runs in the ws-server process — use HTTP, not direct import.
        try {
          const wsPort = process.env.WS_PORT || '3002';
          await fetch(`http://127.0.0.1:${wsPort}/supervisor/watch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getOrCreateWsToken()}` },
            body: JSON.stringify({
              surfaceId: result.surfaceId,
              repoPath: lane.repoPath,
              name: lane.label || lane.branch,
              prompt: command.prompt,
            }),
            signal: AbortSignal.timeout(3000),
          });
        } catch (regErr) {
          console.warn(`[lane] Failed to register agent with supervisor:`, regErr);
        }

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: result.note, lane: updated ?? undefined };
      } catch (err) {
        setLaneStatus(command.laneId, 'idle', 'system', 'launch_error');
        const message = err instanceof Error ? err.message : 'Launch failed.';
        return { ok: false, laneId: command.laneId, note: message };
      }
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
          const wsPort = process.env.WS_PORT || '3002';
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
          await execFileAsync(
            'git',
            [
              'add',
              '-A',
              '--',
              '.',
              ':!node_modules',
              ':!.next',
              ':!dist',
              ':!out',
              ':!coverage',
              ':!artifacts',
              ':!.cortex-worktrees',
            ],
            { cwd: reviewCwd, maxBuffer: 10 * 1024 * 1024 },
          );
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
      const prPolicy = evaluatePolicy(buildLanePolicyContext(lane, 'create_pr', actor));
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
          '--body', `Automated PR from lane \`${lane.id}\`.\n\nRuntime: ${lane.runtime}\nPacket: ${lane.packetId ?? 'none'}`,
        ], { cwd: lane.repoPath });

        const prUrl = prResult.stdout.trim();
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
      const gateResult = runMergeGate(lane, undefined, command.orchestratorReviewed === true);
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
          gateResult: { passed: gateResult.passed, violations: gateResult.violations },
        });
      }

      // Policy gate — require approval for merge
      const mergePolicy = evaluatePolicy(buildLanePolicyContext(lane, 'merge', actor, {
        orchestratorReviewed: command.orchestratorReviewed,
        gatePassed: gateResult.passed,
      }));
      if (mergePolicy.requiresApproval && actor !== 'user') {
        return createLaneActionApproval(lane, actor, {
          verb: 'merge',
          commitMessage: command.commitMessage,
          expectedHeadSha: command.expectedHeadSha,
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
        if (!(await worktreeExistsOnDisk(worktreePath))) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Worktree not found on disk: ${worktreePath}`,
          };
        }

        // F38 (#1030): keep the manager handle + worktreeId derived from the
        // path so the post-merge cleanup at the end of this block still works.
        // The lookup-by-find from the in-memory list is gone, but cleanup() is
        // keyed by worktreeId (basename of the path).
        const { getWorktreeManager } = await import('@/lib/worktree/launch');
        const mgr = getWorktreeManager(lane.repoPath);
        const worktreeId = worktreePath.split('/').filter(Boolean).pop()!;

        // Commit any uncommitted changes
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);

        const headLock = await checkExpectedHeadSha(worktreePath, command.expectedHeadSha);
        if (!headLock.ok) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'head_sha_drift');
          appendEvent(command.laneId, 'merge_head_drift', actor, {
            expectedHeadSha: headLock.expectedHeadSha,
            currentHeadSha: headLock.currentHeadSha,
            branch: lane.branch,
            baseBranch: lane.baseBranch,
            packetId: lane.packetId,
          });
          return {
            ok: false,
            laneId: command.laneId,
            note: formatHeadShaMismatchNote(headLock),
            expectedHeadSha: headLock.expectedHeadSha,
            currentHeadSha: headLock.currentHeadSha,
          };
        }

        if (command.commitMessage) {
          try {
            // F32 fix (#1024): only commit if there are actual uncommitted
            // changes. Previously this used --allow-empty, which created a
            // duplicate feat commit every merge call — even when Codex had
            // already committed the work. Result: 3-4 commits per packet on
            // main with the same message + a final merge commit.
            await execFileAsync('git', ['add', '-A'], { cwd: worktreePath });
            const { stdout: porcelain } = await execFileAsync(
              'git', ['status', '--porcelain'],
              { cwd: worktreePath, timeout: 5000 },
            );
            if (porcelain.trim()) {
              await execFileAsync('git', ['commit', '-m', command.commitMessage], { cwd: worktreePath });
            }
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

        // F19 — Fetch the lane branch from the clone into main repo before merge.
        // After F2/F8 (912d65a7), each codex packet runs in an APFS-CoW clone with
        // its OWN .git directory. The branch only exists as a ref inside the clone
        // — main never sees it. The merge step below runs in lane.repoPath (main),
        // so without this fetch, `git merge <branch>` fails with "not something we
        // can merge". We use +ref:ref to force-update so a stale prior attempt
        // doesn't block.
        if (worktreePath !== lane.repoPath) {
          try {
            await execFileAsync('git', ['fetch', worktreePath, `+${actualBranch}:${actualBranch}`], { cwd: lane.repoPath });
            console.log(`[lane-merge] Fetched ${actualBranch} from clone ${worktreePath} into ${lane.repoPath}`);
          } catch (fetchErr) {
            console.error(`[lane-merge] Failed to fetch ${actualBranch} from clone:`, fetchErr instanceof Error ? fetchErr.message : String(fetchErr));
            return {
              ok: false,
              laneId: command.laneId,
              note: `Failed to fetch ${actualBranch} from worktree clone before merge: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
            };
          }
        }

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
            expectedHeadSha: command.expectedHeadSha,
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
        await mgr.cleanup(worktreeId, { force: true, deleteBranch: true });
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

function formatLaneCommandError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const stderr = 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '').trim() : '';
  const stdout = 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '').trim() : '';

  return stderr || stdout || error.message;
}

async function performRemoteCustomerMerge(
  lane: Lane,
  command: MergeCommand,
  actor: LaneEventActor,
): Promise<LaneCommandResult> {
  const workerRun = fetchWorkerRun(lane.id);
  if (!workerRun?.remoteBranch) {
    setLaneStatus(command.laneId, 'reviewing', 'system', 'remote_branch_missing');
    return { ok: false, laneId: command.laneId, note: 'No remote branch recorded for this lane.' };
  }

  const fetched = await fetchWorkerBranch(lane.repoPath, workerRun.remoteBranch, workerRun.id);
  if (!fetched.ok) {
    console.warn(`[remote-merge] ${fetched.note}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: fetched.note };
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  let savedBranch: string | null = null;

  try {
    savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: lane.repoPath,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();

    if (command.commitMessage) {
      try {
        // F32 (#1024): same fix as the local-merge path. --allow-empty here
        // created duplicate commits when the remote worker had already
        // committed. Porcelain check first, commit only when dirty.
        await execFileAsync('git', ['add', '-A'], { cwd: fetched.tempWorktreePath });
        const { stdout: porcelain } = await execFileAsync(
          'git', ['status', '--porcelain'],
          { cwd: fetched.tempWorktreePath, timeout: 5000 },
        );
        if (porcelain.trim()) {
          await execFileAsync('git', ['commit', '-m', command.commitMessage], {
            cwd: fetched.tempWorktreePath,
          });
        }
      } catch { /* nothing to commit */ }
    }

    const actualBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: fetched.tempWorktreePath,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();
    console.log(`[remote-merge] Actual worktree branch: ${actualBranch} (base ref: ${fetched.baseRef})`);

    let rebaseFailed = false;
    try {
      await execFileAsync('git', ['rebase', lane.baseBranch], { cwd: fetched.tempWorktreePath });
      console.log(`[remote-merge] Rebased ${actualBranch} onto ${lane.baseBranch}`);
    } catch {
      try {
        await execFileAsync('git', ['rebase', '--abort'], { cwd: fetched.tempWorktreePath });
      } catch {
        // already clean
      }
      rebaseFailed = true;
      console.log(`[remote-merge] Rebase failed for ${actualBranch}, attempting direct merge`);
    }

    if (!rebaseFailed) {
      const typecheck = await runLaneRebaseTypecheck({
        cwd: fetched.tempWorktreePath,
        actualBranch,
        logPrefix: 'remote-merge',
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

    if (command.strategy === 'manual') {
      setLaneStatus(command.laneId, 'reviewing', 'system', 'manual_resolution_unsupported');
      return {
        ok: false,
        laneId: command.laneId,
        note: 'Manual conflict resolution is not supported for remote-customer merges.',
      };
    }

    await execFileAsync('git', ['checkout', lane.baseBranch], { cwd: lane.repoPath });

    try {
      const mergeArgs = ['merge', '--no-ff', '-m', `Merge lane ${lane.label} (${actualBranch})`];
      if (command.strategy === 'ours' || command.strategy === 'theirs') {
        mergeArgs.push('-X', command.strategy);
      }
      mergeArgs.push(actualBranch);
      await execFileAsync('git', mergeArgs, { cwd: lane.repoPath });
    } catch (mergeErr) {
      let conflictFiles: string[] = [];
      try {
        const { stdout: unmerged } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=U'], {
          cwd: lane.repoPath,
        });
        conflictFiles = unmerged.trim().split('\n').filter(Boolean);
      } catch {
        // best effort
      }

      try {
        await execFileAsync('git', ['merge', '--abort'], { cwd: lane.repoPath });
      } catch {
        // already clean
      }

      const mergeMessage = formatLaneCommandError(mergeErr);
      const conflictLabel = rebaseFailed
        ? `Rebase failed, merge also failed: ${mergeMessage}`
        : `Merge failed after rebase: ${mergeMessage}`;
      const conflictSuffix = conflictFiles.length > 0
        ? `\n\nConflicting files:\n${conflictFiles.map((file) => `- ${file}`).join('\n')}`
        : '';
      console.warn(`[remote-merge] ${conflictLabel}`);
      setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_conflict');
      return {
        ok: false,
        laneId: command.laneId,
        note: `${conflictLabel}${conflictSuffix}`,
      };
    }

    let pushedToOrigin = false;
    let pushError: string | undefined;
    try {
      await execFileAsync('git', ['push', 'origin', lane.baseBranch], {
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      pushedToOrigin = true;
      console.log(`[remote-merge] Pushed ${lane.baseBranch} to origin after merging ${actualBranch}`);
    } catch (pushErr) {
      pushError = formatLaneCommandError(pushErr);
      console.warn(`[remote-merge] Push to origin failed for ${lane.baseBranch} after merging ${actualBranch}: ${pushError}`);
    }

    try {
      await execFileAsync('git', ['push', 'origin', '--delete', workerRun.remoteBranch], {
        cwd: lane.repoPath,
        timeout: 60_000,
      });
      console.log(`[remote-merge] Deleted remote branch ${workerRun.remoteBranch}`);
    } catch (deleteErr) {
      console.warn(
        `[remote-merge] Failed to delete remote branch ${workerRun.remoteBranch}: ${formatLaneCommandError(deleteErr)}`,
      );
    }

    setLaneStatus(command.laneId, 'completed', actor, pushedToOrigin ? 'merged_pushed' : 'merged');

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
        `[remote-merge] Decomposition scan failed for ${lane.repoPath}: ${decompositionError instanceof Error ? decompositionError.message : String(decompositionError)}`,
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
  } catch (error) {
    const message = formatLaneCommandError(error);
    console.error(`[remote-merge] Merge failed for lane ${lane.id}: ${message}`);
    setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_error');
    return { ok: false, laneId: command.laneId, note: message };
  } finally {
    if (savedBranch) {
      try {
        await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });
      } catch (restoreError) {
        console.warn(`[remote-merge] Failed to restore branch ${savedBranch}: ${formatLaneCommandError(restoreError)}`);
      }
    }

    try {
      await cleanupRemoteMergeWorktree(fetched.tempWorktreePath);
    } catch (cleanupError) {
      console.warn(
        `[remote-merge] Failed to clean up temp worktree ${fetched.tempWorktreePath}: ${formatLaneCommandError(cleanupError)}`,
      );
    }
  }
}
