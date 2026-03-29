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
} from './types';
import {
  createLane,
  getLane,
  updateLane,
  setLaneStatus,
  attachSession,
  archiveLane,
} from './registry';
import { getLanePolicy, isProtectedBranch } from './policy';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval } from '@/lib/approvals/store';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';

export async function dispatch(command: LaneCommand): Promise<LaneCommandResult> {
  const actor: LaneEventActor = command.actor ?? 'user';

  switch (command.verb) {
    case 'open_lane': {
      const existing = (await import('./registry')).findLaneByRepoAndBranch(
        command.repoPath,
        command.branch,
      );
      if (existing) {
        return { ok: true, laneId: existing.id, note: 'Lane already exists for this repo and branch.', lane: existing };
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
          baseBranch: lane.baseBranch,
          isolate: !lane.worktreePath,
          skipSetup: true,
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
        });

        if (!result.ok) {
          setLaneStatus(command.laneId, 'paused', 'system', 'relaunch_failed');
          return { ok: false, laneId: command.laneId, note: result.note };
        }

        attachSession(command.laneId, result.surfaceId, actor);
        setLaneStatus(command.laneId, 'running', actor, 'resumed');
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

      const updated = setLaneStatus(command.laneId, 'reviewing', actor, 'review_requested');
      return { ok: true, laneId: command.laneId, note: 'Review requested.', lane: updated ?? undefined };
    }

    case 'create_pr': {
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to create PR from. Lane is on the main working tree.' };

      // Policy gate — require approval for PR creation
      const prPolicy = evaluatePolicy(buildPolicyContext('lane_command', { verb: 'create_pr', laneId: command.laneId }));
      if (prPolicy.requiresApproval && actor !== 'user') {
        const approval = createApproval({
          source: 'runtime',
          runtime: lane.runtime,
          agent: lane.label || lane.branch,
          sessionKey: lane.sessionKey || `lane:${lane.id}`,
          title: 'Create pull request',
          description: command.reviewSummary || `Create PR from lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Create PR: ${lane.branch} → ${lane.baseBranch}`,
          risk: prPolicy.risk,
          policyRuleId: prPolicy.ruleId,
          metadata: {
            Lane: lane.id,
            Branch: lane.branch,
            Base: lane.baseBranch,
            Runtime: lane.runtime,
          },
          continuation: {
            kind: 'lane',
            laneId: command.laneId,
            verb: 'create_pr',
            commitMessage: command.commitMessage,
          },
        });
        setLaneStatus(command.laneId, 'awaiting_input', actor, 'approval_required');
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
        return { ok: false, laneId: command.laneId, note: `Approval required: ${prPolicy.reason}`, approvalId: approval.id };
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
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };

      // Policy gate — require approval for merge
      const mergePolicy = evaluatePolicy(buildPolicyContext('lane_command', { verb: 'merge', laneId: command.laneId }));
      if (mergePolicy.requiresApproval && actor !== 'user') {
        const approval = createApproval({
          source: 'runtime',
          runtime: lane.runtime,
          agent: lane.label || lane.branch,
          sessionKey: lane.sessionKey || `lane:${lane.id}`,
          title: 'Merge lane',
          description: command.reviewSummary || `Merge lane "${lane.label}" (${lane.branch} → ${lane.baseBranch})`,
          summary: `Merge: ${lane.branch} → ${lane.baseBranch}`,
          risk: mergePolicy.risk,
          policyRuleId: mergePolicy.ruleId,
          metadata: {
            Lane: lane.id,
            Branch: lane.branch,
            Base: lane.baseBranch,
            Runtime: lane.runtime,
          },
          continuation: {
            kind: 'lane',
            laneId: command.laneId,
            verb: 'merge',
            commitMessage: command.commitMessage,
          },
        });
        setLaneStatus(command.laneId, 'awaiting_input', actor, 'approval_required');
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
        return { ok: false, laneId: command.laneId, note: `Approval required: ${mergePolicy.reason}`, approvalId: approval.id };
      }

      setLaneStatus(command.laneId, 'merging', actor, 'merging');

      try {
        const { getWorktreeManager } = await import('@/lib/worktree/launch');
        const mgr = getWorktreeManager(lane.repoPath);
        const worktrees = await mgr.list();
        const worktree = worktrees.find((wt) => wt.path === lane.worktreePath);
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
            await execFileAsync('git', ['add', '-A'], { cwd: lane.worktreePath });
            await execFileAsync('git', ['commit', '-m', command.commitMessage, '--allow-empty'], { cwd: lane.worktreePath });
          } catch { /* nothing to commit */ }
        }

        // Pre-check for conflicts
        try {
          await execFileAsync('git', ['merge-tree', '--write-tree', lane.baseBranch, lane.branch], { cwd: lane.repoPath });
        } catch {
          setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_conflicts');
          return { ok: false, laneId: command.laneId, note: 'Merge conflicts detected. Resolve manually or create a PR instead.' };
        }

        // Perform merge
        const savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: lane.repoPath })).stdout.trim();
        await execFileAsync('git', ['checkout', lane.baseBranch], { cwd: lane.repoPath });

        try {
          await execFileAsync('git', ['merge', '--no-ff', '-m', `Merge lane ${lane.label} (${lane.branch})`, lane.branch], { cwd: lane.repoPath });
        } catch (mergeErr) {
          // Rollback
          try { await execFileAsync('git', ['merge', '--abort'], { cwd: lane.repoPath }); } catch { /* already clean */ }
          await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });
          setLaneStatus(command.laneId, 'reviewing', 'system', 'merge_failed');
          const message = mergeErr instanceof Error ? mergeErr.message : 'Merge failed.';
          return { ok: false, laneId: command.laneId, note: message };
        }

        await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });

        // Cleanup worktree
        await mgr.cleanup(worktree.id, { force: true, deleteBranch: true });
        updateLane(command.laneId, { worktreePath: null }, 'system');
        setLaneStatus(command.laneId, 'completed', actor, 'merged');

        const updated = getLane(command.laneId);
        return { ok: true, laneId: command.laneId, note: `Merged ${lane.branch} into ${lane.baseBranch}.`, lane: updated ?? undefined };
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
