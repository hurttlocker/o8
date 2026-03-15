/**
 * Codex Runtime Adapter
 *
 * Wraps existing codex/sessions.ts and codex/owned.ts behind the
 * universal AgentRuntime contract. No rewrite — delegates to existing code.
 */

import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTranscriptEntry,
  RuntimeChangedFile,
  RuntimeActionResult,
  LaunchOptions,
} from './types';
import { getCodexDiscoveredFleetAdditions, getCodexRuntimeTail } from '@/lib/codex/sessions';
import {
  launchOwnedCodexSession,
  continueOwnedCodexSession,
  interruptOwnedCodexSession,
  getOwnedCodexFleetAdditions,
  getOwnedCodexRuntimeTail,
  getOwnedCodexReviewPacket,
} from '@/lib/codex/owned';

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: false,
  streaming: true,
};

/**
 * Map internal fleet AgentSummary to the universal RuntimeSession shape.
 */
function mapAgentToSession(
  agent: { id: string; name: string; sessionKey: string; status: string; currentTask: string; workspace: string; branch: string; model: string; lastEventAt: string; runtimeSurface?: { ownership?: string; capabilities?: { sendInput?: boolean; interrupt?: boolean; diffContext?: boolean }; lifecycle?: { availability?: string; lastOutcome?: string; lastRunMode?: string; lastRunStartedAt?: string; lastRunFinishedAt?: string; summary?: string }; reviewContext?: { repoSlug?: string; branch?: string; head?: string }; cwd?: string } },
): RuntimeSession {
  const surface = agent.runtimeSurface;
  const ownership = (surface?.ownership ?? 'discovered') as RuntimeSession['ownership'];
  const status = (['running', 'idle', 'waiting', 'reviewing', 'failed'].includes(agent.status)
    ? agent.status
    : 'idle') as RuntimeSession['status'];

  return {
    sessionKey: agent.sessionKey,
    runtimeId: 'codex',
    displayName: agent.name,
    cwd: surface?.cwd ?? agent.workspace,
    branch: surface?.reviewContext?.branch ?? agent.branch,
    headSha: surface?.reviewContext?.head,
    repoSlug: surface?.reviewContext?.repoSlug,
    status,
    ownership,
    sessionCapabilities: {
      canSendInput: surface?.capabilities?.sendInput ?? false,
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt: new Date(agent.lastEventAt),
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

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  displayName: 'Codex',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    // Discover both user-launched (terminal) and IDE-owned sessions
    const [discovered, owned] = await Promise.allSettled([
      getCodexDiscoveredFleetAdditions(),
      getOwnedCodexFleetAdditions(),
    ]);

    const sessions: RuntimeSession[] = [];

    if (discovered.status === 'fulfilled') {
      for (const agent of discovered.value.agents) {
        sessions.push(mapAgentToSession(agent));
      }
    }

    if (owned.status === 'fulfilled') {
      for (const agent of owned.value.agents) {
        sessions.push(mapAgentToSession(agent));
      }
    }

    return sessions;
  },

  async readTranscript(sessionKey: string, _sinceId?: string, _limit?: number): Promise<RuntimeTranscriptEntry[]> {
    // Route to the correct tail reader based on ownership
    const isOwned = sessionKey.startsWith('codex-owned:');
    const tail = isOwned
      ? await getOwnedCodexRuntimeTail(sessionKey)
      : await getCodexRuntimeTail(sessionKey);

    return tail.entries.map((entry) => ({
      id: entry.id,
      role: entry.kind === 'message' ? 'assistant' as const
        : entry.kind === 'tool' ? 'tool' as const
        : entry.kind === 'tool-output' ? 'tool' as const
        : 'system' as const,
      text: entry.text,
      timestamp: new Date(entry.timestampLabel ?? Date.now()),
      toolName: entry.kind === 'tool' ? entry.label : undefined,
    }));
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedCodexSession({ cwd: opts.cwd, prompt: opts.prompt });
    return {
      ok: result.ok,
      note: result.note,
      sessionKey: result.surfaceId,
    };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const result = await continueOwnedCodexSession(sessionKey, message);
    return {
      ok: true,
      note: result.note,
      sessionKey,
    };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const result = await interruptOwnedCodexSession(sessionKey);
    return {
      ok: result.interrupted,
      note: result.note,
      sessionKey,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    try {
      const packet = await getOwnedCodexReviewPacket(sessionKey);
      return (packet.changedFiles ?? []).map((f) => ({
        path: f.path,
        status: (f.status ?? 'modified') as RuntimeChangedFile['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
    } catch {
      return [];
    }
  },
};
