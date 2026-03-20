/**
 * OpenClaw Runtime Adapter
 *
 * Wraps existing OpenClaw gateway integration behind the universal
 * AgentRuntime contract. Delegates to openclaw/chat.ts for actions.
 */

import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTranscriptEntry,
  RuntimeChangedFile,
  RuntimeActionResult,
  RuntimeTelemetry,
  LaunchOptions,
} from './types';
import {
  getSessionTranscript,
  steerOpenClawSession,
  abortOpenClawSession,
} from '@/lib/openclaw/chat';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

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

async function resolveOpenClawLaunchSurface() {
  const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
  const primary = snapshot.meta.primarySessionKey
    ? snapshot.agents.find((agent) => agent.runtime === 'openclaw' && agent.sessionKey === snapshot.meta.primarySessionKey)
    : null;

  return primary
    ?? snapshot.agents.find((agent) => agent.runtime === 'openclaw' && agent.isCurrentSession)
    ?? snapshot.agents.find((agent) => agent.runtime === 'openclaw')
    ?? null;
}

export const openclawRuntime: AgentRuntime = {
  id: 'openclaw',
  displayName: 'OpenClaw',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    const snapshot = await getRuntimeInventorySnapshot();

    return snapshot.agents
      .filter((agent) => agent.runtime === 'openclaw')
      .map((agent) => ({
        sessionKey: agent.sessionKey,
        runtimeId: 'openclaw' as const,
        displayName: agent.name,
        cwd: agent.runtimeSurface?.cwd ?? agent.workspace,
        branch: agent.runtimeSurface?.reviewContext?.branch ?? agent.branch,
        headSha: agent.runtimeSurface?.reviewContext?.head,
        repoSlug: agent.runtimeSurface?.reviewContext?.repoSlug,
        status: (['running', 'idle', 'waiting', 'reviewing', 'failed'].includes(agent.status)
          ? agent.status
          : 'idle') as RuntimeSession['status'],
        ownership: 'provider' as const,
        sessionCapabilities: {
          canSendInput: agent.runtimeSurface?.capabilities?.sendInput ?? true,
          canInterrupt: agent.runtimeSurface?.capabilities?.interrupt ?? true,
          canReviewDiffs: agent.runtimeSurface?.capabilities?.diffContext ?? true,
        },
        lastActivityAt: new Date(),
        initialTask: agent.currentTask,
        model: agent.model,
        browserSurface: agent.browserSurface ?? agent.runtimeSurface?.browserSurface,
      }));
  },

  async readTranscript(sessionKey: string, _sinceId?: string, limit = 12): Promise<RuntimeTranscriptEntry[]> {
    const result = await getSessionTranscript(sessionKey, limit);
    return result.map((entry) => ({
      id: entry.id,
      role: entry.role as RuntimeTranscriptEntry['role'],
      text: entry.text,
      timestamp: new Date(entry.timestamp ?? Date.now()),
    }));
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const target = await resolveOpenClawLaunchSurface();
    if (!target) {
      return {
        ok: false,
        note: 'No live OpenClaw session is available to receive a task dispatch right now.',
      };
    }

    const repoHint = opts.cwd ? `Repository: ${opts.cwd}\n\n` : '';
    await steerOpenClawSession(target.sessionKey, `${repoHint}${opts.prompt}`, []);

    return {
      ok: true,
      note: `Dispatched task to ${target.name} on ${target.sessionKey}. OpenClaw launch currently reuses the live mirrored session instead of creating a new owned surface.`,
      sessionKey: target.sessionKey,
    };
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    await steerOpenClawSession(sessionKey, message, []);
    return {
      ok: true,
      note: 'Sent.',
      sessionKey,
    };
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const result = await abortOpenClawSession(sessionKey);
    return {
      ok: true,
      note: result.aborted
        ? 'Stop request sent to the active run.'
        : 'No active run was in flight.',
      sessionKey,
    };
  },

  async getChangedFiles(): Promise<RuntimeChangedFile[]> {
    // OpenClaw review context comes through the fleet snapshot, not per-session query
    return [];
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    const snapshot = await getRuntimeInventorySnapshot();
    const agent = snapshot.agents.find((a) => a.sessionKey === sessionKey);
    if (!agent?.tokenUsage) return undefined;
    return {
      totalTokens: agent.tokenUsage.totalTokens ?? undefined,
      remainingTokens: agent.tokenUsage.remainingTokens ?? undefined,
      estimatedCostUsd: agent.cost?.sessionUsd,
    };
  },
};
