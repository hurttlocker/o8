import type { AgentSummary } from '@/lib/fleet/types';
import { recordLaneEvent } from '@/lib/lane/events';
import { listLanes } from '@/lib/lane/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { continueOwnedCodexSession, setOwnedCodexReviewDisposition } from '@/lib/codex/owned';
import { markRepoOriginConfigured, markRepoOriginMissing } from '@/lib/repos/origin-readiness';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime, type RuntimeId } from '@/lib/runtimes';
import { escalateInterruptOwnedSurface } from '@/lib/runtime/interrupt-escalation';
import { performOwnedActionWithoutInventory } from '@/lib/runtime/owned-actions';
import {
  buildProjectTaskBrief,
  getProjectContext,
  type ProjectContext,
} from '@/lib/projects/context';
import { buildProjectBriefPromptV1 } from '@/lib/prompts/v1';
import { selfHealActiveByKindAndRepo } from '@/lib/supervisor/inbox';
import {
  linkSessionToWorktree,
  prepareLaunchWorktree,
  WorktreeFetchUnreachableError,
  WorktreeOriginMissingError,
  WorktreeRebaseConflictError,
} from '@/lib/worktree';
import type { WorktreeInfo } from '@/lib/worktree/types';

export type RuntimeActionKind = 'steer' | 'stop' | 'send_input' | 'interrupt' | 'watch' | 'resolve' | 'launch';

export interface RuntimeActionRequest {
  action: RuntimeActionKind;
  surfaceId: string;
  clientMutationId?: string;
  message?: string;
  runId?: string;
  cwd?: string;
  attachments?: Array<{
    type?: string;
    mimeType: string;
    fileName: string;
    content: string;
  }>;
  auditSteer?: boolean;
  steerSource?: 'operator' | 'orchestrator' | 'heal-bot';
}

export interface RuntimeActionResult {
  ok: boolean;
  action: RuntimeActionKind;
  surfaceId: string;
  sessionKey?: string;
  runtime: string;
  clientMutationId?: string;
  status: 'queued' | 'completed' | 'unavailable';
  note: string;
  retryable?: boolean;
  reason?: 'surface_not_ready';
  runId?: string;
  aborted?: boolean;
}

export interface RuntimeLaunchRequest {
  runtime: RuntimeId;
  prompt: string;
  model?: string;
  /** Requested reasoning effort — passed to the runtime's launch; per-runtime no-op. */
  effort?: ThinkingEffort;
  clientMutationId?: string;
  cwd?: string;
  repoPath?: string;
  /** Canonical repo root for project context when cwd/repoPath points at an isolated worktree. */
  projectRepoPath?: string;
  taskName?: string;
  /**
   * Pre-assigned lane branch the worktree must check out before the agent
   * spawns. Without this, prepareLaunchWorktree falls back to the legacy
   * `worktree/<agent>/<slug>` placeholder branch and the agent has to
   * self-correct via `git checkout -b <lane.branch>`. Weaker models miss
   * the prompt hint and silently commit on the wrong branch — the lane
   * merge then sees an empty diff. Dispatch passes `lane.branch` here.
   */
  branchName?: string;
  baseBranch?: string;
  isolate?: boolean;
  isolation?: 'main' | 'branch';
  skipSetup?: boolean;
  // When set, the caller already owns a lane for this launch (eg. packet
  // dispatch going through the lane command bus). launchRuntimeSurface will
  // skip its implicit lane creation and leave binding to the caller.
  existingLaneId?: string;
  // When the launch is bound to a packet, include its id so supervisor inbox
  // items surfaced during pre-launch (eg. rebase conflicts) can deep-link
  // back to the packet card. Leave undefined for scratch runs that aren't
  // tied to a packet. Also drives the worktree directory naming (one slot
  // per packet, instead of a shared taskName-derived slot).
  packetId?: string;
}

export interface RuntimeLaunchResult {
  ok: boolean;
  runtime: RuntimeId;
  clientMutationId?: string;
  surfaceId: string;
  note: string;
  cwd: string;
  repoPath: string;
  worktree: WorktreeInfo | null;
  laneId: string | null;
}

const FETCH_UNREACHABLE_COOLDOWN_MS = 5 * 60_000;
const fetchUnreachableFailures = new Map<string, number>();
const loggedOriginMissingRepos = new Set<string>();
const PROJECT_BRIEF_HEADING_PATTERN = /(?:^|\n)##\s+Project Brief\b/i;

function fetchCooldownRetrySeconds(repoPath: string): number | null {
  const lastFailureMs = fetchUnreachableFailures.get(repoPath);
  if (!lastFailureMs) return null;
  const remainingMs = FETCH_UNREACHABLE_COOLDOWN_MS - (Date.now() - lastFailureMs);
  if (remainingMs <= 0) {
    fetchUnreachableFailures.delete(repoPath);
    return null;
  }
  return Math.ceil(remainingMs / 1000);
}

function recordFetchUnreachable(repoPath: string): void {
  fetchUnreachableFailures.set(repoPath, Date.now());
}

function auditRuntimeSteer(payload: RuntimeActionRequest, sessionKey: string): void {
  if (payload.auditSteer === false || (payload.action !== 'steer' && payload.action !== 'send_input')) return;
  const message = payload.message?.trim();
  if (!message) return;
  try {
    const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey && candidate.packetId);
    if (!lane?.packetId) return;
    recordLaneEvent(lane.id, 'steered_packet', 'orchestrator', {
      packetId: lane.packetId,
      source: payload.steerSource ?? 'operator',
      message,
    });
  } catch {
    // Runtime action delivery should not fail because lane audit storage is temporarily unavailable.
  }
}

function clearFetchUnreachable(repoPath: string): void {
  fetchUnreachableFailures.delete(repoPath);
}

function summarizeTaskName(prompt: string) {
  // #533 — orchestrator prompts start with `## Task\n\n<actual content>`, so
  // picking "the first non-empty line" every time collapsed every dispatch
  // to the literal word "task" and left every worktree in the same directory
  // and branch. Skip pure markdown headings and bullet markers, and fall
  // back to the first content line. Strip any residual heading markers on
  // whatever we picked so the slug reflects the task, not the scaffolding.
  const lines = prompt.split('\n').map((line) => line.trim()).filter(Boolean);
  const headingPattern = /^#{1,6}\s+\S/;
  const listPattern = /^[-*]\s+\S|^\d+\.\s+\S/;
  const firstContent =
    lines.find((line) => !headingPattern.test(line) && !listPattern.test(line)) ??
    lines.find(Boolean) ??
    'agent-task';
  const cleaned = firstContent
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+\.\s+/, '');
  return cleaned.replace(/\s+/g, ' ').slice(0, 80);
}

async function resolveProjectContextForLaunch(
  payload: RuntimeLaunchRequest,
  repoPath: string,
): Promise<ProjectContext | null> {
  const contextRepoPath = payload.projectRepoPath?.trim() || repoPath;
  try {
    return await getProjectContext({ repoPath: contextRepoPath });
  } catch (error) {
    console.warn(
      '[runtime-actions] Project context unavailable for launch:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function buildLaunchPromptWithProjectBrief(
  payload: RuntimeLaunchRequest,
  prompt: string,
  repoPath: string,
): Promise<{ prompt: string; projectContext: ProjectContext | null }> {
  const projectContext = await resolveProjectContextForLaunch(payload, repoPath);
  if (PROJECT_BRIEF_HEADING_PATTERN.test(prompt)) {
    return { prompt, projectContext };
  }

  if (!projectContext) {
    return { prompt, projectContext: null };
  }

  const projectBrief = buildProjectTaskBrief(projectContext, {
    repoPath: payload.projectRepoPath?.trim() || repoPath,
    taskTitle: payload.taskName?.trim() || summarizeTaskName(prompt),
    taskBody: prompt,
  });

  return {
    projectContext,
    prompt: buildProjectBriefPromptV1(projectBrief, prompt),
  };
}

export async function launchRuntimeSurface(payload: RuntimeLaunchRequest): Promise<RuntimeLaunchResult> {
  const runtimeId = payload.runtime;
  const prompt = payload.prompt?.trim();
  const repoPath = payload.repoPath?.trim() || payload.cwd?.trim();

  if (!runtimeId) {
    throw new Error('runtime is required');
  }
  if (!prompt) {
    throw new Error('prompt is required');
  }
  if (!repoPath) {
    throw new Error('repoPath or cwd is required');
  }

  const runtime = getRuntime(runtimeId);
  if (!runtime) {
    throw new Error(`Runtime ${runtimeId} is not registered.`);
  }
  if (!runtime.capabilities.launch) {
    throw new Error(`Runtime ${runtimeId} does not support launch.`);
  }

  const { prompt: launchPrompt, projectContext } = await buildLaunchPromptWithProjectBrief(payload, prompt, repoPath);
  const supportsWorktrees = runtimeId === 'codex'
    || runtimeId === 'claude-code'
    || runtimeId === 'gemini'
    || runtimeId === 'opencode'
    || runtimeId === 'pi';

  // A plain folder (never git-inited) can't host worktrees — and every launch
  // died at `git rev-parse --show-toplevel` with NO surfaced error (#1551,
  // live-hit 2026-07-12: a fresh laptop's first project folder, "hey" eaten
  // silently, no agent could spawn at all). Degrade instead of dying: launch
  // the runtime directly in the folder, no isolation, and say so in the note.
  // `.git` may be a FILE in a linked worktree, so existsSync covers both.
  const { existsSync: launchDirHasGit } = await import('node:fs');
  const { join: joinLaunchPath } = await import('node:path');
  const repoIsGit = launchDirHasGit(joinLaunchPath(repoPath, '.git'));
  if (!repoIsGit) {
    console.warn(`[runtime-launch] ${repoPath} is not a git repository — launching ${runtimeId} directly in the folder (no isolation, no branch)`);
  }

  // Create a worktree when: explicitly requested via isolate flag, OR when not skipping setup.
  // This allows dispatch to request isolation (isolate: true) while skipping env setup (skipSetup: true).
  const shouldCreateWorktree = supportsWorktrees && repoIsGit && (payload.isolate || !payload.skipSetup);
  if (shouldCreateWorktree) {
    const retryInSeconds = fetchCooldownRetrySeconds(repoPath);
    if (retryInSeconds != null) {
      throw new Error(`Launch blocked: fetch_unreachable cooldown for ${repoPath}; retry in ${retryInSeconds}s`);
    }
  }
  const repoEntry = shouldCreateWorktree
    ? await import('@/lib/repos/registry').then((m) => m.findRepoByLocalPath(repoPath)).catch(() => null)
    : null;
  let launchWorktree: Awaited<ReturnType<typeof prepareLaunchWorktree>> = null;
  if (shouldCreateWorktree) {
    try {
      launchWorktree = await prepareLaunchWorktree({
        repoRoot: repoPath,
        agentType: runtimeId,
        taskName: payload.taskName?.trim() || summarizeTaskName(prompt),
        branchName: payload.branchName?.trim() || undefined,
        baseBranch: payload.baseBranch?.trim() || undefined,
        isolate: payload.isolate,
        skipSetup: payload.skipSetup,
        envMode: repoEntry?.setup.envMode,
        envFiles: repoEntry?.setup.envFiles,
        isolationPreference: repoEntry?.setup.workspaceIsolationPreference,
        packetId: payload.packetId,
      });
      if (launchWorktree?.worktree) {
        clearFetchUnreachable(repoPath);
        markRepoOriginConfigured(repoPath);
        const healed = selfHealActiveByKindAndRepo('fetch_unreachable', repoPath);
        if (healed > 0) {
          console.log(`[supervisor-inbox] Self-healed ${healed} fetch_unreachable item(s) for ${repoPath} after clean rebase.`);
        }
      }
    } catch (err) {
      // Rebase-before-launch failed. Don't spawn codex into a broken tree —
      // instead, mark any existing lane as awaiting_input so the operator
      // sees it, and enqueue a supervisor inbox item describing the conflict.
      if (err instanceof WorktreeRebaseConflictError) {
        const baseBranchForInbox = err.baseBranch;
        const conflictFiles = err.conflictFiles;
        const conflictBranch = err.branch;

        if (payload.existingLaneId) {
          try {
            const { setLaneStatus } = await import('@/lib/lane/registry');
            setLaneStatus(payload.existingLaneId, 'awaiting_input', 'system', 'rebase_conflict');
          } catch (laneErr) {
            console.warn(
              `[worktree-rebase] Failed to mark lane ${payload.existingLaneId} as awaiting_input: ${laneErr instanceof Error ? laneErr.message : laneErr}`,
            );
          }
        } else {
          // Scratch launches have no lane — log explicitly so the trail is
          // obvious. The supervisor inbox row (below) + thrown error (further
          // down) are the only surfaces operators will see.
          console.warn(
            `[worktree-rebase] Scratch ${runtimeId} launch blocked by rebase conflict onto origin/${baseBranchForInbox} (no lane to mark, branch ${conflictBranch}).`,
          );
        }

        try {
          const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
          enqueueInboxItem({
            repoPath,
            packetId: payload.packetId ?? null,
            kind: 'merge_blocked',
            payload: {
              stage: 'pre_launch_rebase',
              baseBranch: baseBranchForInbox,
              branch: conflictBranch,
              conflictFiles,
              laneId: payload.existingLaneId ?? null,
              packetId: payload.packetId ?? null,
              runtime: runtimeId,
              errorMessage: err.message,
              errorExcerpt: conflictFiles.length > 0
                ? `Rebase onto origin/${baseBranchForInbox} failed. ${conflictFiles.length} conflicting file${conflictFiles.length === 1 ? '' : 's'}: ${conflictFiles.slice(0, 5).join(', ')}${conflictFiles.length > 5 ? '…' : ''}`
                : `Rebase onto origin/${baseBranchForInbox} failed. ${err.message}`,
            },
            status: 'human_required',
          });
        } catch (inboxErr) {
          console.warn(
            `[worktree-rebase] Failed to enqueue supervisor inbox item: ${inboxErr instanceof Error ? inboxErr.message : inboxErr}`,
          );
        }

        // Scratch runs (no existingLaneId) surface rebase failures via the
        // thrown error only — there's no lane to mark awaiting_input. The
        // supervisor inbox item above is still enqueued so the operator sees
        // it. Never swallow silently.
        throw new Error(
          `Rebase onto origin/${baseBranchForInbox} failed before launching ${runtimeId}. Resolve the conflict manually and retry.${conflictFiles.length > 0 ? ` Conflicting files: ${conflictFiles.join(', ')}` : ''}`,
        );
      }

      if (err instanceof WorktreeOriginMissingError) {
        markRepoOriginMissing(repoPath);
        if (!loggedOriginMissingRepos.has(repoPath)) {
          loggedOriginMissingRepos.add(repoPath);
          console.warn(`[supervisor-inbox] Repo ${repoPath} has no origin remote; skipping inbox escalation.`);
        }
        throw new Error(`Cannot launch ${runtimeId}: origin remote is not configured for ${repoPath}. Configure origin and retry.`);
      }

      // Fetch unreachable + stale local ref. Don't branch from a stale base —
      // same policy as a rebase conflict: mark the lane, surface an inbox row
      // (kind: fetch_unreachable), and throw loudly. The operator can run
      // `git fetch` manually, reconnect, and retry the launch.
      if (err instanceof WorktreeFetchUnreachableError) {
        recordFetchUnreachable(repoPath);
        markRepoOriginConfigured(repoPath);
        const baseBranchForInbox = err.baseBranch;
        const conflictBranch = err.branch;
        const localRefAgeMinutes = Number.isFinite(err.localRefAgeMs)
          ? Math.round(err.localRefAgeMs / 60_000)
          : null;

        if (payload.existingLaneId) {
          try {
            const { setLaneStatus } = await import('@/lib/lane/registry');
            setLaneStatus(payload.existingLaneId, 'awaiting_input', 'system', 'fetch_unreachable');
          } catch (laneErr) {
            console.warn(
              `[worktree-rebase] Failed to mark lane ${payload.existingLaneId} as awaiting_input: ${laneErr instanceof Error ? laneErr.message : laneErr}`,
            );
          }
        } else {
          console.warn(
            `[worktree-rebase] Scratch ${runtimeId} launch blocked by fetch_unreachable on origin/${baseBranchForInbox} (no lane to mark, branch ${conflictBranch}).`,
          );
        }

        const stalenessLabel = localRefAgeMinutes == null
          ? 'local ref missing or unreadable'
          : `local ref is ${localRefAgeMinutes} min old`;

        try {
          const { enqueueInboxItem } = await import('@/lib/supervisor/inbox');
          enqueueInboxItem({
            repoPath,
            packetId: payload.packetId ?? null,
            kind: 'fetch_unreachable',
            payload: {
              stage: 'pre_launch_fetch',
              baseBranch: baseBranchForInbox,
              branch: conflictBranch,
              laneId: payload.existingLaneId ?? null,
              packetId: payload.packetId ?? null,
              runtime: runtimeId,
              localRefAgeMs: Number.isFinite(err.localRefAgeMs) ? err.localRefAgeMs : null,
              fetchErrorMessage: err.fetchErrorMessage,
              errorMessage: err.message,
              errorExcerpt: `Fetch origin ${baseBranchForInbox} unreachable and ${stalenessLabel}. Reconnect and retry.`,
            },
            status: 'human_required',
          });
        } catch (inboxErr) {
          console.warn(
            `[worktree-rebase] Failed to enqueue fetch_unreachable inbox item: ${inboxErr instanceof Error ? inboxErr.message : inboxErr}`,
          );
        }

        throw new Error(
          `Cannot launch ${runtimeId}: fetch origin ${baseBranchForInbox} failed and ${stalenessLabel}. Reconnect and retry.`,
        );
      }

      throw err;
    }
  }

  const cwd = launchWorktree?.cwd ?? repoPath;
  const result = await runtime.launch({
    cwd,
    prompt: launchPrompt,
    model: payload.model,
    effort: payload.effort,
    worktreeFlag: launchWorktree?.claudeWorktreeFlag,
    worktreePath: launchWorktree?.worktree?.path,
    laneId: payload.existingLaneId ?? undefined,
  });

  if (!result.ok || !result.sessionKey) {
    throw new Error(result.note || `Unable to launch ${runtimeId}.`);
  }

  if (launchWorktree?.worktree) {
    await linkSessionToWorktree(repoPath, launchWorktree.worktree.id, result.sessionKey);
  }

  // Wrap every launch in a lane so the governance layer is universal and the
  // session retires automatically when its work lands. Packet dispatch passes
  // `existingLaneId` to opt out — it already created a lane upstream and will
  // attach the session itself. We only auto-wrap launches that got a worktree;
  // un-isolated scratch runs still fall through without a lane.
  let laneId: string | null = payload.existingLaneId ?? null;
  const laneRuntime: OrchestratorRuntime | null = ORCHESTRATOR_RUNTIMES[runtimeId as OrchestratorRuntime]
    ? runtimeId as OrchestratorRuntime
    : null;
  if (!laneId && launchWorktree?.worktree && laneRuntime) {
    try {
      const { createLane, attachSession } = await import('@/lib/lane/registry');
      const implicitLabel = payload.taskName?.trim() || summarizeTaskName(prompt);
      const lane = createLane({
        repoPath,
        projectId: projectContext?.id ?? null,
        branch: launchWorktree.worktree.branch,
        baseBranch: payload.baseBranch?.trim() || 'main',
        runtime: laneRuntime,
        label: implicitLabel,
        ownership: 'managed',
        worktreePath: launchWorktree.worktree.path,
        actor: 'user',
      });
      attachSession(lane.id, result.sessionKey, 'system');
      laneId = lane.id;
    } catch (err) {
      // Lane wrap is best-effort — never block a successful launch if the
      // governance layer has a hiccup. The reaper + manual archive paths can
      // still reconcile later.
      console.warn('[runtime-actions] Failed to wrap launch in lane:', err instanceof Error ? err.message : err);
    }
  }

  return {
    ok: true,
    runtime: runtimeId,
    clientMutationId: payload.clientMutationId,
    surfaceId: result.sessionKey,
    note: launchWorktree?.worktree
      ? `${result.note} Worktree: ${launchWorktree.worktree.branch} at ${launchWorktree.worktree.path}.`
      : result.note,
    cwd,
    repoPath,
    worktree: launchWorktree?.worktree ?? null,
    laneId,
  };
}

function findRuntimeAgent(snapshot: Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>, surfaceId: string) {
  return snapshot.agents.find(
    (agent) => agent.sessionKey === surfaceId || agent.runtimeSurface?.id === surfaceId || agent.id === surfaceId,
  );
}

function unavailable(
  agent: AgentSummary,
  action: RuntimeActionKind,
  note: string,
  clientMutationId?: string,
  options: Pick<RuntimeActionResult, 'retryable' | 'reason'> = {},
): RuntimeActionResult {
  return {
    ok: false,
    action,
    surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
    runtime: agent.runtime,
    clientMutationId,
    status: 'unavailable',
    note,
    ...options,
  };
}

function ownedCodexSurfaceNotReady(
  agent: AgentSummary,
  action: RuntimeActionKind,
  clientMutationId?: string,
): RuntimeActionResult {
  return unavailable(
    agent,
    action,
    'This worker is still finishing its current turn. The message can be delivered when it is ready.',
    clientMutationId,
    { retryable: true, reason: 'surface_not_ready' },
  );
}

function isOwnedCodexSurfaceNotReadyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /still has an active run|does not have a thread id yet/i.test(message);
}

function actionUnavailable(
  payload: RuntimeActionRequest,
  surfaceId: string,
  runtime: string,
  note: string,
): RuntimeActionResult {
  return {
    ok: false,
    action: payload.action,
    surfaceId,
    runtime,
    clientMutationId: payload.clientMutationId,
    status: 'unavailable',
    note,
  };
}

export async function performRuntimeAction(payload: RuntimeActionRequest): Promise<RuntimeActionResult> {
  const surfaceId = payload.surfaceId?.trim();
  // Fix #3: return structured error instead of throwing across the API boundary (CLAUDE.md rule)
  if (!surfaceId) {
    return actionUnavailable(payload, '', '', 'surfaceId is required');
  }

  // Try cached snapshot first to avoid expensive full re-discovery on every action.
  // Only fall back to a fresh fetch if the agent isn't in cache (e.g. just spawned).
  const cached = await getRuntimeInventorySnapshot();
  let agent = findRuntimeAgent(cached, surfaceId);
  if (!agent) {
    const fresh = await getRuntimeInventorySnapshot({ fresh: true });
    agent = findRuntimeAgent(fresh, surfaceId);
  }
  if (!agent) {
    const ownedResult = await performOwnedActionWithoutInventory(payload, surfaceId);
    if (ownedResult) return ownedResult;
    // Fix #3: return structured error instead of throwing across the API boundary
    return actionUnavailable(payload, surfaceId, '', 'Runtime surface not found.');
  }

  const isOwnedCodexSteer = agent.runtime === 'codex'
    && agent.runtimeSurface?.ownership === 'owned'
    && (payload.action === 'steer' || payload.action === 'send_input');
  if (isOwnedCodexSteer) {
    const fresh = await getRuntimeInventorySnapshot({ fresh: true });
    agent = findRuntimeAgent(fresh, surfaceId) ?? agent;
  }

  const runtimeSurface = agent.runtimeSurface;
  if (!runtimeSurface) {
    return actionUnavailable(payload, agent.sessionKey, agent.runtime, 'Runtime surface metadata is unavailable.');
  }
  if (!isOwnedCodexSteer) {
    auditRuntimeSteer(payload, agent.sessionKey);
  }

  switch (agent.runtime) {
    case 'codex': {
      if (runtimeSurface.ownership !== 'owned') {
        const runtime = getRuntime('codex');
        if (!runtime) {
          return unavailable(agent, payload.action, 'Codex runtime is not registered.');
        }

        if (payload.action === 'steer' || payload.action === 'send_input') {
          const message = payload.message?.trim();
          if (!message) {
            return unavailable(agent, payload.action, 'message is required to steer a Codex session', payload.clientMutationId);
          }
          const result = await runtime.resume(agent.sessionKey, message);
          return {
            ok: result.ok,
            action: payload.action,
            surfaceId: runtimeSurface.id,
            sessionKey: result.sessionKey ?? agent.sessionKey,
            runtime: agent.runtime,
            clientMutationId: payload.clientMutationId,
            status: result.ok ? 'queued' : 'unavailable',
            note: result.note,
          };
        }

        if (payload.action === 'stop' || payload.action === 'interrupt') {
          if (!runtimeSurface.capabilities.interrupt) {
            return unavailable(
              agent,
              payload.action,
              'No live Codex process is attached to this discovered session, so there is nothing to interrupt.',
            );
          }
          const result = await runtime.interrupt(agent.sessionKey);
          return {
            ok: result.ok,
            action: payload.action,
            surfaceId: runtimeSurface.id,
            runtime: agent.runtime,
            clientMutationId: payload.clientMutationId,
            status: result.ok ? 'completed' : 'unavailable',
            note: result.note,
            aborted: result.ok,
          };
        }

        return unavailable(
          agent,
          payload.action,
          'This Codex surface was discovered from a local terminal. Only steer and interrupt are supported while the live pid is still attached.',
        );
      }

      if (payload.action === 'steer' || payload.action === 'send_input') {
        const message = payload.message?.trim();
        if (!message) {
          return unavailable(agent, payload.action, 'message is required to resume an owned Codex session', payload.clientMutationId);
        }
        if (!runtimeSurface.capabilities.sendInput) {
          return ownedCodexSurfaceNotReady(agent, payload.action, payload.clientMutationId);
        }
        let result: Awaited<ReturnType<typeof continueOwnedCodexSession>>;
        try {
          result = await continueOwnedCodexSession(runtimeSurface.id, message);
        } catch (error) {
          if (isOwnedCodexSurfaceNotReadyError(error)) {
            return ownedCodexSurfaceNotReady(agent, payload.action, payload.clientMutationId);
          }
          throw error;
        }
        if (result.ok) {
          auditRuntimeSteer(payload, agent.sessionKey);
        }
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          sessionKey: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.ok ? 'queued' : 'unavailable',
          note: result.note,
        };
      }

      if (payload.action === 'stop' || payload.action === 'interrupt') {
        if (!runtimeSurface.capabilities.interrupt) {
          return unavailable(
            agent,
            payload.action,
            'No active IDE-owned Codex run is currently in flight, so there is nothing to interrupt.',
          );
        }
        const result = await escalateInterruptOwnedSurface(runtimeSurface.id);
        if (!result) {
          return unavailable(agent, payload.action, 'Owned Codex interrupt target could not be resolved.');
        }
        return {
          ok: result.confirmedDead,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: result.confirmedDead ? 'completed' : 'unavailable',
          note: result.note,
          aborted: result.confirmedDead,
        };
      }

      if (payload.action === 'watch' || payload.action === 'resolve') {
        const result = await setOwnedCodexReviewDisposition(
          runtimeSurface.id,
          payload.action === 'resolve' ? 'resolved' : 'watching',
        );
        return {
          ok: true,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'completed',
          note: result.note,
        };
      }

      return unavailable(
        agent,
        payload.action,
        'This IDE-owned Codex surface supports launch/resume/interrupt and review-state disposition changes only in the bounded owned-session lane for now.',
      );
    }
    default: {
      // Registry-based dispatch for all other runtimes (claude-code, aider, etc.)
      const runtime = getRuntime(agent.runtime);
      if (!runtime) {
        return unavailable(agent, payload.action, `Runtime action ${payload.action} is not supported for ${agent.runtime}.`);
      }

      if (payload.action === 'steer' || payload.action === 'send_input') {
        const message = payload.message?.trim();
        if (!message) return unavailable(agent, payload.action, 'message is required', payload.clientMutationId);
        if (!runtime.capabilities.resume) {
          return unavailable(agent, payload.action, `${agent.runtime} does not support resume/steer.`);
        }
        const result = await runtime.resume(agent.sessionKey, message);
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          sessionKey: result.sessionKey ?? agent.sessionKey,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'queued',
          note: result.note,
        };
      }

      if (payload.action === 'stop' || payload.action === 'interrupt') {
        const ownedResult = await performOwnedActionWithoutInventory(payload, runtimeSurface.id);
        if (ownedResult) return ownedResult;
        if (!runtime.capabilities.interrupt) {
          return unavailable(agent, payload.action, `${agent.runtime} does not support interrupt.`);
        }
        const result = await runtime.interrupt(agent.sessionKey);
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'completed',
          note: result.note,
          aborted: result.ok,
        };
      }

      return unavailable(agent, payload.action, `Runtime action ${payload.action} is not wired for ${agent.runtime} yet.`);
    }
  }
}

/**
 * Launch a new owned Codex session from mobile.
 * Doesn't require an existing surface — creates one from scratch.
 */
export async function launchCodexFromMobile(cwd: string, prompt: string): Promise<RuntimeActionResult> {
  const result = await launchRuntimeSurface({ runtime: 'codex', cwd, prompt });
  return {
    ok: result.ok,
    action: 'launch',
    surfaceId: result.surfaceId,
    runtime: 'codex',
    clientMutationId: result.clientMutationId,
    status: 'queued',
    note: result.note,
  };
}
