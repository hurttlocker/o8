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
} from '@/lib/lane/registry';
import { getLanePolicy, isProtectedBranch } from '@/lib/lane/policy';
import { getSqlite } from '@/lib/db';
import { evaluatePolicy, buildPolicyContext } from '@/lib/approvals/policies';
import { createApproval, recordApprovalAudit } from '@/lib/approvals/store';
import { FILE_SIZE_BLOCK_THRESHOLD_LINES, FILE_SIZE_WAIVERS } from '@/lib/orchestrator/dispatch';
import { runMergeGate, formatMergeGateViolations } from '@/lib/lane/merge-gate';
import { buildConflictZonesFromDiffFiles, extractReviewFindings, extractReviewPatterns } from '@/lib/orchestrator/review-lessons';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { parseGitDiff } from '@/lib/worktree/diff-parser';

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
  opts?: { orchestratorReviewed?: boolean; fileSizeLimitExceeded?: boolean },
) {
  // Auto-approve when: (a) headless auto-review is active, or
  // (b) the orchestrator already reviewed and approved the packet.
  const autoReview = actor === 'orchestrator'
    && (isLaneAutoReviewInProgress(lane.id) || opts?.orchestratorReviewed === true);
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

function formatOversizedFiles(files: Array<{ path: string; lineCount: number }>) {
  if (files.length === 0) {
    return 'none';
  }

  const labels = files.map((file) => `${file.path} (${file.lineCount}L)`);
  if (labels.length <= 4) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 4).join(', ')} (+${labels.length - 4} more)`;
}

async function getOversizedChangedFilesForLane(
  lane: Pick<Lane, 'baseBranch' | 'worktreePath'>,
) {
  if (!lane.worktreePath) {
    return [];
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync('git', ['diff', '--name-only', `${lane.baseBranch}...HEAD`], {
      cwd: lane.worktreePath,
      maxBuffer: 4 * 1024 * 1024,
    });
    const changedFiles = Array.from(new Set(
      result.stdout
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
    ));

    const lineCounts = await Promise.allSettled(
      changedFiles.map(async (filePath) => {
        const wcResult = await execFileAsync('wc', ['-l', filePath], {
          cwd: lane.worktreePath!,
          maxBuffer: 256 * 1024,
        });
        const match = wcResult.stdout.match(/^\s*(\d+)/);
        if (!match) {
          return null;
        }

        return {
          path: filePath,
          lineCount: Number.parseInt(match[1], 10),
        };
      }),
    );

    return lineCounts
      .flatMap((entry) => (entry.status === 'fulfilled' && entry.value ? [entry.value] : []))
      .filter((file) => !FILE_SIZE_WAIVERS.has(file.path) && file.lineCount > FILE_SIZE_BLOCK_THRESHOLD_LINES)
      .sort((left, right) => right.lineCount - left.lineCount || left.path.localeCompare(right.path));
  } catch {
    return [];
  }
}

async function createLaneActionApproval(
  lane: Lane,
  actor: LaneEventActor,
  input: {
    verb: 'merge' | 'create_pr';
    commitMessage?: string;
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
      ...input.metadata,
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: input.verb,
      commitMessage: input.commitMessage,
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
          await execFileAsync('git', ['add', '-A'], { cwd: reviewCwd, maxBuffer: 10 * 1024 * 1024 });
          await execFileAsync('git', ['commit', '-m', 'auto-commit: agent work before review'], {
            cwd: reviewCwd,
            maxBuffer: 10 * 1024 * 1024,
          });
        }
      } catch (err) {
        console.warn(`[lane] request_review: git status/commit check failed for ${reviewCwd}:`, err);
        // Non-fatal — proceed with the review transition even if the commit check fails
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
      const lane = getLane(command.laneId);
      if (!lane) return { ok: false, laneId: command.laneId, note: 'Lane not found.' };
      if (!lane.worktreePath) return { ok: false, laneId: command.laneId, note: 'No worktree to merge. Lane is on the main working tree.' };

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

        // Resolve actual branch name from the worktree (may differ from lane.branch
        // when the worktree manager generates its own branch naming convention)
        const actualBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: lane.worktreePath })).stdout.trim();
        console.log(`[lane-merge] Actual worktree branch: ${actualBranch} (lane.branch: ${lane.branch})`);

        // ── Rebase onto latest baseBranch HEAD ──
        // When parallel agents dispatch from the same HEAD, later branches become
        // stale after earlier merges. Rebasing first auto-resolves same-file-
        // different-section changes that would otherwise look like conflicts.
        let rebaseFailed = false;
        try {
          await execFileAsync('git', ['rebase', lane.baseBranch], { cwd: lane.worktreePath });
          console.log(`[lane-merge] Rebased ${actualBranch} onto ${lane.baseBranch}`);
        } catch {
          // Rebase had true conflicts — abort and fall through to direct merge
          try { await execFileAsync('git', ['rebase', '--abort'], { cwd: lane.worktreePath }); } catch { /* already clean */ }
          rebaseFailed = true;
          console.log(`[lane-merge] Rebase failed for ${actualBranch}, attempting direct merge`);
        }

        // (#482) Typecheck after rebase — catches integration drift that agents
        // can't detect in their isolated branches. Only run if rebase succeeded
        // (if rebase failed, we're about to try direct merge which has its own risks).
        if (!rebaseFailed) {
          try {
            await execFileAsync('npx', ['tsc', '--noEmit'], {
              cwd: lane.worktreePath!,
              timeout: 120_000,
              maxBuffer: 4 * 1024 * 1024,
            });
            console.log(`[lane-merge] Typecheck passed for ${actualBranch}`);
          } catch (tscErr) {
            const tscOutput = tscErr instanceof Error && 'stdout' in tscErr
              ? String((tscErr as { stdout: unknown }).stdout).slice(0, 2000)
              : tscErr instanceof Error && 'stderr' in tscErr
                ? String((tscErr as { stderr: unknown }).stderr).slice(0, 2000)
                : 'Unknown typecheck error';
            console.error(`[lane-merge] Typecheck failed for ${actualBranch}:\n${tscOutput}`);
            setLaneStatus(command.laneId, 'reviewing', 'system', 'typecheck_failed');
            return {
              ok: false,
              laneId: command.laneId,
              note: `Typecheck failed after rebase onto ${lane.baseBranch}. Fix type errors before merging.\n\n${tscOutput}`,
            };
          }
        }

        // Manual strategy — operator chose to fix conflicts in terminal
        if (command.strategy === 'manual') {
          setLaneStatus(command.laneId, 'awaiting_input', actor, 'manual_resolution');
          return { ok: true, laneId: command.laneId, note: 'Lane parked for manual conflict resolution.' };
        }

        // Perform merge using the actual branch ref
        const savedBranch = (await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: lane.repoPath })).stdout.trim();
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

          const conflictMessage = mergeErr instanceof Error ? mergeErr.message : 'Merge failed.';
          const conflictDetail = rebaseFailed
            ? `Rebase failed, merge also failed: ${conflictMessage}`
            : `Merge failed after rebase: ${conflictMessage}`;
          const conflictFileList = conflictFiles.length > 0
            ? `\n\nConflicting files:\n${conflictFiles.map((f) => `- ${f}`).join('\n')}`
            : '';

          // Create an approval card so the operator sees the conflict instead of silent stall
          return createLaneActionApproval(lane, actor, {
            verb: 'merge',
            commitMessage: command.commitMessage,
            reviewSummary: command.reviewSummary,
            title: `Merge conflict: ${lane.label}`,
            description: `${conflictDetail}${conflictFileList}\n\nPick a resolution strategy: Ours (keep base), Theirs (keep branch), or Manual (park for terminal fix).`,
            summary: `Merge conflict on ${lane.branch} → ${lane.baseBranch}. ${conflictFiles.length} file${conflictFiles.length === 1 ? '' : 's'} conflicting.`,
            risk: 'high' as ApprovalRisk,
            policyRuleId: 'merge_conflict_escalation',
            metadata: {
              ConflictFiles: conflictFiles.join(', ') || 'unknown',
            },
            note: `Merge conflict escalated to operator. ${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}.`,
            gateResult: { passed: gateResult.passed, violations: gateResult.violations },
            conflictReport: {
              files: conflictFiles,
              mergeError: conflictMessage,
            },
          });
        }

        await execFileAsync('git', ['checkout', savedBranch], { cwd: lane.repoPath });

        // Cleanup worktree + prune any other stale worktrees in the background
        await mgr.cleanup(worktree.id, { force: true, deleteBranch: true });
        void mgr.prune().catch(() => {});
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
