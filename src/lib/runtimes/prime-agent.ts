import type {
  AgentRuntime,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
  LaunchOptions,
} from './types';
import { parsePrimeAgentSessionCost } from '@/lib/runtimes/prime-agent-cost-parser';
import { CliNotFoundError, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import {
  continueOwnedPrimeAgentSession,
  getOwnedPrimeAgentFleetAdditions,
  getOwnedPrimeAgentReviewPacket,
  getOwnedPrimeAgentRuntimeTail,
  getOwnedPrimeAgentTelemetrySources,
  interruptOwnedPrimeAgentSession,
  launchOwnedPrimeAgentSession,
} from '@/lib/prime-agent/owned';

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: true,
  streaming: true,
};

type OwnedAgentLike = Awaited<ReturnType<typeof getOwnedPrimeAgentFleetAdditions>>['agents'][number];

async function hasPrimeAgentCli(): Promise<boolean> {
  try {
    await resolveCli({
      runtimeId: 'prime-agent',
      binaryName: 'prime-agent',
      envOverride: 'O8_PRIME_AGENT_BIN',
    });
    return true;
  } catch (error) {
    if (error instanceof CliNotFoundError) return false;
    throw error;
  }
}

function mapStatus(rawStatus: string): RuntimeSession['status'] {
  return rawStatus === 'completed' || rawStatus === 'finished' ? 'completed'
    : rawStatus === 'running' || rawStatus === 'launched' ? 'running'
    : rawStatus === 'waiting' || rawStatus === 'blocked' || rawStatus === 'awaiting_input' ? 'waiting'
    : rawStatus === 'reviewing' || rawStatus === 'review_ready' ? 'reviewing'
    : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
    : 'idle';
}

function mapAgentToSession(agent: OwnedAgentLike): RuntimeSession {
  const surface = agent.runtimeSurface;
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const lastActivityAt = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'prime-agent',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status: mapStatus(agent.status),
    ownership: (surface?.ownership ?? 'owned') as RuntimeSession['ownership'],
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(lastActivityAt.getTime()) ? new Date() : lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle ? {
      availability: (surface.lifecycle.availability ?? 'running') as 'awaiting-thread' | 'running' | 'ready-for-resume',
      lastOutcome: surface.lifecycle.lastOutcome as 'finished' | 'interrupted' | 'failed' | undefined,
      lastRunMode: surface.lifecycle.lastRunMode as 'launch' | 'resume' | undefined,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
  };
}

function parseTranscriptTimestamp(value?: string, fallbackLabel?: string) {
  const direct = value ? new Date(value) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const fromLabel = fallbackLabel ? new Date(fallbackLabel) : null;
  if (fromLabel && !Number.isNaN(fromLabel.getTime())) return fromLabel;
  return new Date();
}

function applyTranscriptWindow<T extends { id: string }>(entries: T[], sinceId?: string, limit?: number) {
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

export const primeAgentRuntime: AgentRuntime = {
  id: 'prime-agent',
  displayName: 'Prime Agent',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    if (!await hasPrimeAgentCli()) return [];
    const owned = await getOwnedPrimeAgentFleetAdditions().catch((error) => {
      console.warn('[prime-agent-runtime] discoverSessions owned fleet failed:', error);
      return null;
    });
    return owned?.agents.map((agent) => mapAgentToSession(agent as OwnedAgentLike)) ?? [];
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return [];
    const tail = await getOwnedPrimeAgentRuntimeTail(sessionKey);
    return applyTranscriptWindow(tail.entries, sinceId, limit).map((entry) => ({
      id: entry.id,
      role: entry.kind === 'message' ? 'assistant' as const
        : entry.kind === 'tool' ? 'tool' as const
        : 'system' as const,
      text: entry.text,
      timestamp: parseTranscriptTimestamp(entry.timestamp, entry.timestampLabel),
      toolName: entry.kind === 'tool' ? entry.label : undefined,
    }));
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedPrimeAgentSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    return { ok: result.ok, note: result.note, sessionKey: result.surfaceId };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('prime-agent-owned:')) {
      return { ok: false, note: 'Prime Agent runtime only supports owned session resume.' };
    }
    const result = await continueOwnedPrimeAgentSession(sessionKey, message);
    return { ok: result.ok, note: result.note, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('prime-agent-owned:')) {
      return { ok: false, note: 'Only owned Prime Agent sessions can be interrupted.', sessionKey };
    }
    const result = await interruptOwnedPrimeAgentSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return [];
    try {
      const packet = await getOwnedPrimeAgentReviewPacket(sessionKey);
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

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    if (!sessionKey.startsWith('prime-agent-owned:')) return undefined;
    const sources = await getOwnedPrimeAgentTelemetrySources(sessionKey);
    if (!sources || sources.stdoutPaths.length === 0) return undefined;
    const sessionCost = await parsePrimeAgentSessionCost(sources.stdoutPaths).catch(() => null);
    if (!sessionCost) return undefined;
    return {
      totalTokens: sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens,
      estimatedCostUsd: sessionCost.totalCostUsd,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      cacheReadTokens: sessionCost.cacheReadTokens,
      cacheWriteTokens: sessionCost.cacheWriteTokens,
      model: sessionCost.model ?? undefined,
    };
  },
};
