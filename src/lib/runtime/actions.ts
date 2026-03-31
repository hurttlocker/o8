import type { AgentSummary } from '@/lib/fleet/types';
import { continueOwnedCodexSession, interruptOwnedCodexSession, setOwnedCodexReviewDisposition } from '@/lib/codex/owned';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getRuntime, type RuntimeId } from '@/lib/runtimes';
import { linkSessionToWorktree, prepareLaunchWorktree } from '@/lib/worktree';
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
}

export interface RuntimeActionResult {
  ok: boolean;
  action: RuntimeActionKind;
  surfaceId: string;
  runtime: string;
  clientMutationId?: string;
  status: 'queued' | 'completed' | 'unavailable';
  note: string;
  runId?: string;
  aborted?: boolean;
}

export interface RuntimeLaunchRequest {
  runtime: RuntimeId;
  prompt: string;
  clientMutationId?: string;
  cwd?: string;
  repoPath?: string;
  taskName?: string;
  baseBranch?: string;
  isolate?: boolean;
  isolation?: 'main' | 'branch';
  skipSetup?: boolean;
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
}

function summarizeTaskName(prompt: string) {
  const compact = prompt
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?? 'agent-task';

  return compact.replace(/\s+/g, ' ').slice(0, 80);
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

  const supportsWorktrees = runtimeId === 'codex' || runtimeId === 'claude-code';

  // Create a worktree when: explicitly requested via isolate flag, OR when not skipping setup.
  // This allows dispatch to request isolation (isolate: true) while skipping env setup (skipSetup: true).
  const shouldCreateWorktree = supportsWorktrees && (payload.isolate || !payload.skipSetup);
  const repoEntry = shouldCreateWorktree ? await findRepoByLocalPath(repoPath).catch(() => null) : null;
  const launchWorktree = shouldCreateWorktree
    ? await prepareLaunchWorktree({
        repoRoot: repoPath,
        agentType: runtimeId,
        taskName: payload.taskName?.trim() || summarizeTaskName(prompt),
        baseBranch: payload.baseBranch?.trim() || undefined,
        isolate: payload.isolate,
        skipSetup: payload.skipSetup,
        envMode: repoEntry?.setup.envMode,
        envFiles: repoEntry?.setup.envFiles,
      })
    : null;

  const cwd = launchWorktree?.cwd ?? repoPath;
  const result = await runtime.launch({
    cwd,
    prompt,
    worktreeFlag: launchWorktree?.claudeWorktreeFlag,
    worktreePath: launchWorktree?.worktree?.path,
  });

  if (!result.ok || !result.sessionKey) {
    throw new Error(result.note || `Unable to launch ${runtimeId}.`);
  }

  if (launchWorktree?.worktree) {
    await linkSessionToWorktree(repoPath, launchWorktree.worktree.id, result.sessionKey);
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
  };
}

function findRuntimeAgent(snapshot: Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>, surfaceId: string) {
  return snapshot.agents.find(
    (agent) => agent.sessionKey === surfaceId || agent.runtimeSurface?.id === surfaceId || agent.id === surfaceId,
  );
}

function unavailable(agent: AgentSummary, action: RuntimeActionKind, note: string): RuntimeActionResult {
  return {
    ok: false,
    action,
    surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
    runtime: agent.runtime,
    clientMutationId: undefined,
    status: 'unavailable',
    note,
  };
}

export async function performRuntimeAction(payload: RuntimeActionRequest): Promise<RuntimeActionResult> {
  const surfaceId = payload.surfaceId?.trim();
  if (!surfaceId) {
    throw new Error('surfaceId is required');
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
    throw new Error('Runtime surface not found.');
  }

  const runtimeSurface = agent.runtimeSurface;
  if (!runtimeSurface) {
    throw new Error('Runtime surface metadata is unavailable.');
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
            throw new Error('message is required to steer a Codex session');
          }
          const result = await runtime.resume(agent.sessionKey, message);
          return {
            ok: result.ok,
            action: payload.action,
            surfaceId: runtimeSurface.id,
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
          throw new Error('message is required to resume an owned Codex session');
        }
        if (!runtimeSurface.capabilities.sendInput) {
          return unavailable(
            agent,
            payload.action,
            'This IDE-owned Codex surface cannot accept the next input yet. Wait for the active run to settle or for the session thread id to be discovered first.',
          );
        }
        const result = await continueOwnedCodexSession(runtimeSurface.id, message);
        return {
          ok: true,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'queued',
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
        const result = await interruptOwnedCodexSession(runtimeSurface.id);
        return {
          ok: result.interrupted,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'completed',
          note: result.note,
          aborted: result.interrupted,
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
        if (!message) throw new Error('message is required');
        if (!runtime.capabilities.resume) {
          return unavailable(agent, payload.action, `${agent.runtime} does not support resume/steer.`);
        }
        const result = await runtime.resume(agent.sessionKey, message);
        return {
          ok: result.ok,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          clientMutationId: payload.clientMutationId,
          status: 'queued',
          note: result.note,
        };
      }

      if (payload.action === 'stop' || payload.action === 'interrupt') {
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
