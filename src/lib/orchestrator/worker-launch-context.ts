import type { OrchestratorRuntime, WorkerLaunchContext } from '@/lib/orchestrator/types';

const SOURCES = new Set<WorkerLaunchContext['source']>(['desktop', 'cli', 'mcp', 'agent']);
const PRESENTATIONS = new Set<WorkerLaunchContext['presentation']>(['tab', 'split']);
const REPO_CONTEXTS = new Set<WorkerLaunchContext['repoContext']>(['registered', 'transient']);
const WORK_MODES = new Set<NonNullable<WorkerLaunchContext['workMode']>>(['edit', 'read-only']);
const MAX_CALLER_LENGTH = 80;

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
  return {
    source: source as WorkerLaunchContext['source'],
    presentation: presentation as WorkerLaunchContext['presentation'],
    repoContext: repoContext as WorkerLaunchContext['repoContext'],
    ...(workMode ? { workMode: workMode as NonNullable<WorkerLaunchContext['workMode']> } : {}),
    ...(caller ? { caller } : {}),
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
  const runtimes: OrchestratorRuntime[] = ['claude-code', 'gemini', 'opencode', 'cursor', 'grok', 'codex'];
  return runtimes.find((runtime) => sessionKey.startsWith(`${runtime}:`)
    || sessionKey.startsWith(`${runtime}-owned:`)
    || sessionKey.startsWith(`${runtime}-discovered:`)) ?? 'codex';
}
