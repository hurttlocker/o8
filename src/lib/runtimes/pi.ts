import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTelemetry,
  RuntimeTranscriptEntry,
} from './types';
import { parsePiSessionCost } from '@/lib/runtimes/pi-cost-parser';
import { resolveCli, CliNotFoundError } from '@/lib/runtimes/shared/cli-resolver';
import { ownedTailToRuntimeTranscript } from '@/lib/runtimes/shared/owned-transcript';
import {
  getOwnedPiFleetAdditions,
  getOwnedPiReviewPacket,
  getOwnedPiRuntimeTail,
  getOwnedPiTelemetrySources,
  interruptOwnedPiSession,
  launchOwnedPiSession,
  steerOwnedPiSession,
} from '@/lib/pi/owned';

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

type OwnedAgentLike = Awaited<ReturnType<typeof getOwnedPiFleetAdditions>>['agents'][number];

async function piBinaryPresent(): Promise<boolean> {
  try {
    await resolveCli({
      runtimeId: 'pi',
      binaryName: 'pi',
      envOverride: 'O8_PI_BIN',
      versionArgs: ['--version'],
    });
    return true;
  } catch (error) {
    if (error instanceof CliNotFoundError) return false;
    return false;
  }
}

function mapAgentToSession(agent: OwnedAgentLike): RuntimeSession {
  const surface = agent.runtimeSurface;
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const lastActivityAt = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'pi',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status: agent.status === 'running' ? 'running' : 'reviewing',
    ownership: 'owned',
    sessionCapabilities: {
      canSendInput: surface?.capabilities.sendInput ?? true,
      canInterrupt: surface?.capabilities.interrupt ?? false,
      canReviewDiffs: surface?.capabilities.diffContext ?? false,
    },
    lastActivityAt: Number.isNaN(lastActivityAt.getTime()) ? new Date() : lastActivityAt,
    initialTask: agent.currentTask,
    model: agent.model,
    lifecycle: surface?.lifecycle ? {
      availability: surface.lifecycle.availability ?? 'ready-for-resume',
      lastOutcome: surface.lifecycle.lastOutcome,
      lastRunMode: surface.lifecycle.lastRunMode,
      lastRunStartedAt: surface.lifecycle.lastRunStartedAt,
      lastRunFinishedAt: surface.lifecycle.lastRunFinishedAt,
      summary: surface.lifecycle.summary,
    } : undefined,
  };
}

export const piRuntime: AgentRuntime = {
  id: 'pi',
  displayName: 'Pi',
  capabilities,
  dispatchCapability: {
    modes: ['thread-resume'],
    resolveThreadId: async (sessionKey) => {
      const sources = await getOwnedPiTelemetrySources(sessionKey).catch(() => null);
      return sources?.threadId ?? null;
    },
  },

  async discoverSessions(): Promise<RuntimeSession[]> {
    if (!(await piBinaryPresent())) return [];
    const owned = await getOwnedPiFleetAdditions().catch((error) => {
      console.warn('[pi-runtime] owned-session discovery failed:', error);
      return null;
    });
    return owned ? owned.agents.map(mapAgentToSession) : [];
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    if (!sessionKey.startsWith('pi-owned:')) return [];
    const tail = await getOwnedPiRuntimeTail(sessionKey);
    return ownedTailToRuntimeTranscript(tail, sinceId, limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedPiSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      clientMutationId: opts.clientMutationId,
      model: opts.model,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    return { ok: result.ok, note: result.note, sessionKey: result.surfaceId };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('pi-owned:')) {
      return { ok: false, note: 'Pi runtime only supports resume for owned sessions (pi-owned: prefix).' };
    }
    const result = await steerOwnedPiSession(sessionKey, message);
    return { ok: result.ok, note: result.note, sessionKey };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('pi-owned:')) {
      return { ok: false, note: 'Pi runtime only supports interrupt for owned sessions (pi-owned: prefix).', sessionKey };
    }
    const result = await interruptOwnedPiSession(sessionKey);
    return { ok: result.interrupted, note: result.note, sessionKey };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    try {
      const packet = await getOwnedPiReviewPacket(sessionKey);
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
    const sources = await getOwnedPiTelemetrySources(sessionKey);
    if (!sources?.stdoutPaths.length) return undefined;
    const cost = await parsePiSessionCost(sources.stdoutPaths, { fallbackModel: null }).catch(() => null);
    if (!cost) return undefined;
    return {
      totalTokens: cost.inputTokens + cost.outputTokens,
      estimatedCostUsd: cost.totalCostUsd,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      cacheReadTokens: cost.cacheReadTokens,
      cacheWriteTokens: cost.cacheWriteTokens,
      costSource: cost.totalCostUsd > 0 ? 'gateway' : 'unknown',
      model: cost.model ?? undefined,
    };
  },
};
