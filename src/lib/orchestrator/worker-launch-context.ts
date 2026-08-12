import { ORCHESTRATOR_RUNTIME_IDS } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';

const SOURCES = new Set<WorkerLaunchContext['source']>(['desktop', 'cli', 'mcp', 'agent']);
const PRESENTATIONS = new Set<WorkerLaunchContext['presentation']>(['tab', 'split']);
const REPO_CONTEXTS = new Set<WorkerLaunchContext['repoContext']>(['registered', 'transient']);
const WORK_MODES = new Set<NonNullable<WorkerLaunchContext['workMode']>>(['edit', 'read-only']);
const MAX_CALLER_LENGTH = 80;
const MAX_PLACEMENT_ID_LENGTH = 200;

function normalizePlacementId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().slice(0, MAX_PLACEMENT_ID_LENGTH)
    : '';
}

export function normalizeWorkerLaunchContext(value: unknown): WorkerLaunchContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const source = candidate.source;
  const presentation = candidate.presentation;
  const repoContext = candidate.repoContext;
  const workMode = candidate.workMode;
  if (!SOURCES.has(source as WorkerLaunchContext['source'])) return undefined;
  if (!PRESENTATIONS.has(presentation as WorkerLaunchContext['presentation'])) return undefined;
  if (!REPO_CONTEXTS.has(repoContext as WorkerLaunchContext['repoContext'])) return undefined;
  if (workMode !== undefined && !WORK_MODES.has(workMode as NonNullable<WorkerLaunchContext['workMode']>)) {
    return undefined;
  }
  const caller = typeof candidate.caller === 'string'
    ? candidate.caller.trim().slice(0, MAX_CALLER_LENGTH)
    : '';
  const parentWorkspaceId = normalizePlacementId(candidate.parentWorkspaceId);
  const parentThreadId = normalizePlacementId(candidate.parentThreadId);
  return {
    source: source as WorkerLaunchContext['source'],
    presentation: presentation as WorkerLaunchContext['presentation'],
    repoContext: repoContext as WorkerLaunchContext['repoContext'],
    ...(workMode ? { workMode: workMode as NonNullable<WorkerLaunchContext['workMode']> } : {}),
    ...(caller ? { caller } : {}),
    ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
  };
}

/**
 * Bind a launch to its durable parent thread without overwriting an explicit
 * placement supplied by the caller. This is used at mission persistence and
 * again at dispatch so older stored packets gain the same reconnect behavior.
 */
export function bindWorkerLaunchParent(
  context: WorkerLaunchContext | null | undefined,
  parent: { workspaceId?: string | null; threadId?: string | null },
): WorkerLaunchContext | undefined {
  if (!context) return undefined;
  const parentWorkspaceId = context.parentWorkspaceId?.trim()
    || normalizePlacementId(parent.workspaceId);
  const parentThreadId = context.parentThreadId?.trim()
    || normalizePlacementId(parent.threadId);
  return {
    ...context,
    ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
    ...(parentThreadId ? { parentThreadId } : {}),
  };
}

export function workerLaunchOriginLabel(context: WorkerLaunchContext | null | undefined): string | null {
  if (!context) return null;
  const sourceLabel = context.source === 'cli'
    ? 'o8 CLI'
    : context.source === 'mcp'
      ? 'o8 MCP'
      : context.source === 'agent'
        ? 'agent'
        : 'o8 desktop';
  const caller = context.caller?.trim();
  return caller && caller.toLowerCase() !== sourceLabel.toLowerCase()
    ? `${caller} via ${sourceLabel}`
    : sourceLabel;
}

export function shouldPresentWorkerInSplit(context: WorkerLaunchContext | null | undefined): boolean {
  return context?.presentation === 'split' && context.source !== 'desktop';
}

export function runtimeFromWorkerSessionKey(sessionKey: string): OrchestratorRuntime {
  return ORCHESTRATOR_RUNTIME_IDS.find((runtime) => sessionKey.startsWith(`${runtime}:`)
    || sessionKey.startsWith(`${runtime}-owned:`)
    || sessionKey.startsWith(`${runtime}-discovered:`)) ?? 'codex';
}
