import type { OwnedFleetAdditions, OwnedSessionStore } from './owned-session';
import { parseCost } from './cost-parser-registry';
import type {
  AgentRuntime,
  RuntimeActionResult,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
} from '../types';

export interface DeclarativeAgentRuntimeOptions {
  runtimeId: string;
  displayName: string;
  surfaceIdPrefix: string;
  supportsResume: boolean;
  costTelemetry: boolean;
}

function mapAgentToSession(
  runtimeId: string,
  agent: OwnedFleetAdditions['agents'][number],
): RuntimeSession {
  const surface = agent.runtimeSurface;
  const rawStatus = agent.status;
  const status: RuntimeSession['status'] =
    rawStatus === 'running' ? 'running'
    : rawStatus === 'waiting' || rawStatus === 'blocked' ? 'waiting'
    : rawStatus === 'reviewing' || rawStatus === 'huddling' ? 'reviewing'
    : rawStatus === 'failed' ? 'failed'
    : 'idle';
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const parsedLastActivity = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);

  return {
    sessionKey: agent.sessionKey,
    runtimeId,
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status,
    ownership: 'owned',
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(parsedLastActivity.getTime()) ? new Date() : parsedLastActivity,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle?.availability ? {
      availability: surface.lifecycle.availability,
      lastOutcome: surface.lifecycle.lastOutcome,
      lastRunMode: surface.lifecycle.lastRunMode,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
    tmuxSession: agent.tmuxSession,
  };
}

function transcriptTimestamp(value?: string, fallbackLabel?: string): Date {
  const direct = value ? new Date(value) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const fallback = fallbackLabel ? new Date(fallbackLabel) : null;
  return fallback && !Number.isNaN(fallback.getTime()) ? fallback : new Date();
}

function transcriptWindow(
  entries: RuntimeTranscriptEntry[],
  sinceId?: string,
  limit?: number,
): RuntimeTranscriptEntry[] {
  let next = entries;
  if (sinceId) {
    const sinceIndex = next.findIndex((entry) => entry.id === sinceId);
    if (sinceIndex >= 0) next = next.slice(sinceIndex + 1);
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && next.length > limit) {
    next = next.slice(-limit);
  }
  return next;
}

export function createDeclarativeAgentRuntime(
  options: DeclarativeAgentRuntimeOptions,
  store: OwnedSessionStore,
): AgentRuntime {
  const runtime: AgentRuntime = {
    id: options.runtimeId,
    displayName: options.displayName,
    capabilities: {
      discover: true,
      readTranscript: true,
      launch: true,
      resume: options.supportsResume,
      interrupt: true,
      reviewDiffs: true,
      costTelemetry: options.costTelemetry,
      streaming: true,
    },

    async discoverSessions(): Promise<RuntimeSession[]> {
      const fleet = await store.getFleetAdditions({ fresh: true });
      return fleet.agents.map((agent) => mapAgentToSession(options.runtimeId, agent));
    },

    async readTranscript(sessionKey, sinceId, limit): Promise<RuntimeTranscriptEntry[]> {
      if (!sessionKey.startsWith(options.surfaceIdPrefix)) return [];
      const tail = await store.getRuntimeTail(sessionKey);
      return transcriptWindow(tail.entries.map((entry) => ({
        id: entry.id,
        role: entry.kind === 'message' ? 'assistant' : entry.kind === 'tool' ? 'tool' : 'system',
        text: entry.text,
        timestamp: transcriptTimestamp(entry.timestamp, entry.timestampLabel),
        toolName: entry.kind === 'tool' ? entry.label : undefined,
      })), sinceId, limit);
    },

    async launch(opts): Promise<RuntimeActionResult> {
      const result = await store.launch({
        cwd: opts.cwd,
        prompt: opts.prompt,
        laneId: opts.laneId,
        packetId: opts.packetId,
        model: opts.model,
        effort: opts.effort,
      });
      return { ok: result.ok, note: result.note, sessionKey: result.surfaceId };
    },

    async resume(sessionKey, message): Promise<RuntimeActionResult> {
      if (!options.supportsResume) {
        return { ok: false, note: `${options.displayName} runs are one-shot and cannot be resumed.`, sessionKey };
      }
      if (!sessionKey.startsWith(options.surfaceIdPrefix)) {
        return { ok: false, note: `${options.displayName} can only resume owned sessions.`, sessionKey };
      }
      const result = await store.resume(sessionKey, message);
      return { ok: result.ok, note: result.note, sessionKey };
    },

    async interrupt(sessionKey): Promise<RuntimeActionResult> {
      if (!sessionKey.startsWith(options.surfaceIdPrefix)) {
        return { ok: false, note: `${options.displayName} can only interrupt owned sessions.`, sessionKey };
      }
      const result = await store.interrupt(sessionKey);
      return { ok: result.interrupted, note: result.note, sessionKey };
    },

    async getChangedFiles(sessionKey): Promise<RuntimeChangedFile[]> {
      try {
        const packet = await store.getReviewPacket(sessionKey);
        return (packet.changedFiles ?? []).map((file) => ({
          path: file.path,
          status: (file.status ?? 'modified') as RuntimeChangedFile['status'],
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        }));
      } catch {
        return [];
      }
    },
  };

  if (options.costTelemetry) {
    runtime.getTelemetry = async (sessionKey): Promise<RuntimeTelemetry | undefined> => {
      if (!sessionKey.startsWith(options.surfaceIdPrefix)) return undefined;
      const sources = await store.getTelemetrySources(sessionKey);
      if (!sources?.stdoutPaths.length) return undefined;
      const cost = await parseCost(options.runtimeId, sources.stdoutPaths).catch(() => null);
      if (!cost) return undefined;
      return {
        totalTokens: cost.inputTokens + cost.outputTokens,
        estimatedCostUsd: cost.totalCostUsd,
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
        cacheReadTokens: cost.cacheReadTokens,
        cacheWriteTokens: cost.cacheWriteTokens,
        model: cost.model ?? undefined,
      };
    };
  }

  return runtime;
}
