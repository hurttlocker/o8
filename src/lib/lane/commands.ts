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
} from '@/lib/lane/types';
import {
  createLane,
  getLane,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
} from '@/lib/lane/registry';
import { getLanePolicy, isProtectedBranch } from '@/lib/lane/policy';
import { evaluatePolicy } from '@/lib/approvals/policies';
import { buildLanePolicyContext, createLaneActionApproval } from '@/lib/lane/commands/approvals';
import { handleMergeCommand } from '@/lib/lane/commands/merge';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export async function dispatch(command: LaneCommand): Promise<LaneCommandResult> {
  const actor: LaneEventActor = command.actor ?? 'user';

  switch (command.verb) {
    case 'open_lane': {
      const existing = (await import('@/lib/lane/registry')).findLaneByRepoAndBranch(
        command.repoPath,
        command.branch,
      );
      if (existing) {
        const updatedExisting = command.packetId && existing.packetId !== command.packetId
          ? updateLane(existing.id, { packetId: command.packetId }, actor) ?? existing
          : existing;
        return { ok: true, laneId: updatedExisting.id, note: 'Lane already exists for this repo and branch.', lane: updatedExisting };
      }

      const lane = createLane({
        repoPath: command.repoPath,
        branch: command.branch,
        baseBranch: command.baseBranch,
        runtime: command.runtime,
        label: command.label,
        packetId: command.packetId,
        ownership: command.ownership,
        actor,
      });

      return { ok: true, laneId: lane.id, note: `Lane opened: ${lane.label}`, lane };
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
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const baseBranch = lane.baseBranch || 'main';
        const { stdout: countStdout } = await execFileAsync(
          'git',
          ['rev-list', '--count', `${baseBranch}..HEAD`],
          { cwd: reviewCwd, maxBuffer: 10 * 1024 * 1024 },
        );
        const commitsAhead = Number.parseInt(countStdout.trim(), 10);
        if (Number.isFinite(commitsAhead) && commitsAhead === 0) {
          console.warn(`[lane] request_review: ${command.laneId} has 0 commits ahead of ${baseBranch} — runtime reported success but produced no diff. Marking failed.`);
          const failed = setLaneStatus(command.laneId, 'paused', 'system', 'empty_diff');
          return {
            ok: false,
            laneId: command.laneId,
            note: `Runtime reported completion but the worktree has zero commits ahead of ${baseBranch}. No review packet opened.`,
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
        // Resolve worktree ID from the worktree manager
        const { getWorktreeManager } = await import('@/lib/worktree/launch');
        const mgr = getWorktreeManager(lane.repoPath);
        const worktrees = await mgr.list();
        const worktree = worktrees.find((wt) => wt.path === lane.worktreePath);
        if (!worktree) {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'worktree_not_found');
          return { ok: false, laneId: command.laneId, note: 'Worktree not found on disk.' };
        }

        // Commit any uncommitted changes first
        if (command.commitMessage) {
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            await execFileAsync('git', ['add', '-A'], { cwd: lane.worktreePath });
            await execFileAsync('git', ['commit', '-m', command.commitMessage, '--allow-empty'], { cwd: lane.worktreePath });
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
      return handleMergeCommand(command, actor);
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
