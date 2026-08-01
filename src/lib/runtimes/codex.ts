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
  RuntimeTelemetry,
} from './types';
// Side-effect import: registers the 'codex' cost parser in the registry.
import '@/lib/runtimes/codex-cost-parser';
import { parseCost } from '@/lib/runtimes/shared/cost-parser-registry';
import { getCodexDiscoveredFleetAdditions, getCodexRolloutPath, getCodexRuntimeTail, queryCodexThreadById } from '@/lib/codex/sessions';
import { getRuntimeRepoReview } from '@/lib/git/runtime-review';
import { monitorUsageDispatch, usageSnapshotFromTelemetry, type UsageSnapshot } from '@/lib/usage-log';

import {
  launchOwnedCodexSession,
  continueOwnedCodexSession,
  interruptOwnedCodexSession,
  getOwnedCodexFleetAdditions,
  getOwnedCodexRuntimeTail,
  getOwnedCodexReviewPacket,
  getOwnedCodexTelemetrySources,
} from '@/lib/codex/owned';
import { resolveDefaultDispatchModelSync, resolveDefaultWorkerEffortSync } from '@/lib/operator/defaults';

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

async function waitForOwnedRunToFinish(sessionKey: string, startedAtMs: number) {
  for (let attempt = 0; attempt < 7200; attempt += 1) {
    const lifecycle = (await getOwnedCodexFleetAdditions({ fresh: true }).catch(() => null))
      ?.agents.find((entry) => entry.sessionKey === sessionKey)?.runtimeSurface?.lifecycle;
    const finishedAtMs = lifecycle?.lastRunFinishedAt ? Date.parse(lifecycle.lastRunFinishedAt) : Number.NaN;
    if (Number.isFinite(finishedAtMs) && finishedAtMs >= startedAtMs && lifecycle?.availability !== 'running') return finishedAtMs;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return Date.now();
}

function scheduleCodexUsageDispatch(
  sessionKey: string,
  startedAtMs: number,
  baseline?: UsageSnapshot,
  laneId?: string,
  model?: string,
  awaitFinishedAtMs?: () => Promise<number>,
) {
  monitorUsageDispatch({
    dispatchKey: `codex:${sessionKey}:${startedAtMs}`,
    runtime: 'codex',
    laneId,
    sessionKey,
    model,
    startedAtMs,
    baseline,
    awaitCompletion: async () => ({
      finishedAtMs: awaitFinishedAtMs ? await awaitFinishedAtMs() : Date.now(),
      snapshot: usageSnapshotFromTelemetry(await codexRuntime.getTelemetry?.(sessionKey)),
    }),
  });
}

/**
 * Map internal fleet AgentSummary to the universal RuntimeSession shape.
 */
function mapAgentToSession(
  agent: { id: string; name: string; sessionKey: string; status: string; currentTask: string; workspace: string; branch: string; model: string; lastEventAt: string; tmuxSession?: string; runtimeSurface?: { ownership?: string; capabilities?: { sendInput?: boolean; interrupt?: boolean; diffContext?: boolean }; lifecycle?: { availability?: string; lastOutcome?: string; lastRunMode?: string; lastRunStartedAt?: string; lastRunFinishedAt?: string; summary?: string }; reviewContext?: { repoSlug?: string; branch?: string; head?: string }; cwd?: string } },
): RuntimeSession {
  const surface = agent.runtimeSurface;
  const ownership = (surface?.ownership ?? 'discovered') as RuntimeSession['ownership'];
  const rawStatus = agent.status;
  const status: RuntimeSession['status'] =
    rawStatus === 'completed' || rawStatus === 'finished' ? 'completed'
    : rawStatus === 'running' || rawStatus === 'launched' ? 'running'
    : rawStatus === 'waiting' || rawStatus === 'blocked' || rawStatus === 'awaiting_input' ? 'waiting'
    : rawStatus === 'reviewing' || rawStatus === 'review_ready' ? 'reviewing'
    : rawStatus === 'failed' || rawStatus === 'error' ? 'failed'
    : rawStatus === 'idle' ? 'idle'
    : 'idle';
  const lifecycleTime = surface?.lifecycle?.lastRunFinishedAt ?? surface?.lifecycle?.lastRunStartedAt;
  const parsedLastActivity = lifecycleTime ? new Date(lifecycleTime) : new Date(agent.lastEventAt);
  const lastActivityAt = Number.isNaN(parsedLastActivity.getTime()) ? new Date() : parsedLastActivity;

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
      canSendInput: surface?.capabilities?.sendInput ?? (ownership !== 'owned'),
      canInterrupt: surface?.capabilities?.interrupt ?? false,
      canReviewDiffs: surface?.capabilities?.diffContext ?? false,
    },
    lastActivityAt,
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
    tmuxSession: agent.tmuxSession,
  };
}

function parseTranscriptTimestamp(value?: string, fallbackLabel?: string) {
  const direct = value ? new Date(value) : null;
  if (direct && !Number.isNaN(direct.getTime())) {
    return direct;
  }

  const fromLabel = fallbackLabel ? new Date(fallbackLabel) : null;
  if (fromLabel && !Number.isNaN(fromLabel.getTime())) {
    return fromLabel;
  }

  return new Date();
}

function applyTranscriptWindow<T extends { id: string }>(entries: T[], sinceId?: string, limit?: number) {
  let next = entries;

  if (sinceId) {
    const sinceIndex = next.findIndex((entry) => entry.id === sinceId);
    if (sinceIndex >= 0) {
      next = next.slice(sinceIndex + 1);
    }
  }

  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && next.length > limit) {
    next = next.slice(-limit);
  }

  return next;
}

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  displayName: 'Codex',
  capabilities,

  async discoverSessions(): Promise<RuntimeSession[]> {
    // Discover both user-launched (terminal) and IDE-owned sessions
    const [discovered, owned] = await Promise.allSettled([
      getCodexDiscoveredFleetAdditions({ fresh: true }),
      getOwnedCodexFleetAdditions({ fresh: true }),
    ]);

    const sessions: RuntimeSession[] = [];

    // An owned run is a normal `codex exec` under the hood — it writes its
    // thread into ~/.codex state like any user session, so discovery surfaces
    // the SAME work twice (once as codex-owned:<id>, once as codex:<thread>).
    // Skip the discovered twin; the owned card is the one with full control.
    const ownedThreadIds = owned.status === 'fulfilled'
      ? new Set(owned.value.ownedThreadIds)
      : new Set<string>();

    if (discovered.status === 'fulfilled') {
      for (const agent of discovered.value.agents) {
        const threadId = agent.sessionKey?.replace(/^codex:/, '');
        if (threadId && ownedThreadIds.has(threadId)) continue;
        sessions.push(mapAgentToSession(agent));
      }
    } else {
      console.error('[codex-runtime] discovered-session discovery failed:', discovered.reason);
    }

    if (owned.status === 'fulfilled') {
      for (const agent of owned.value.agents) {
        sessions.push(mapAgentToSession(agent));
      }
    } else {
      console.error('[codex-runtime] owned-session discovery failed:', owned.reason);
    }

    return sessions;
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit?: number): Promise<RuntimeTranscriptEntry[]> {
    // Route to the correct tail reader based on ownership
    const isOwned = sessionKey.startsWith('codex-owned:');
    const tail = isOwned
      ? await getOwnedCodexRuntimeTail(sessionKey)
      : await getCodexRuntimeTail(sessionKey);

    const entries = applyTranscriptWindow(tail.entries, sinceId, limit);

    return entries.map((entry) => ({
      id: entry.id,
      role: entry.kind === 'message' ? 'assistant' as const
        : entry.kind === 'tool' ? 'tool' as const
        : entry.kind === 'tool-output' ? 'system' as const
        : 'system' as const,
      text: entry.text,
      timestamp: parseTranscriptTimestamp(entry.timestamp, entry.timestampLabel),
      toolName: entry.kind === 'tool' ? entry.label : undefined,
    }));
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    // Fall back to the operator's default worker model when the dispatch didn't
    // pin one — that's how "run every worker on my local model" (an
    // `ollama:`/`lmstudio:` default) reaches every dispatch path, scoped to o8
    // workers. A per-mission model still wins.
    const model = opts.model ?? (resolveDefaultDispatchModelSync() || undefined);
    const effort = resolveDefaultWorkerEffortSync('codex', opts.effort);
    const result = await launchOwnedCodexSession({
      cwd: opts.cwd,
      prompt: opts.prompt,
      model,
      effort,
      laneId: opts.laneId,
      packetId: opts.packetId,
    });
    if (result.ok && result.surfaceId) {
      scheduleCodexUsageDispatch(result.surfaceId, startedAtMs, undefined, opts.laneId, model, () =>
        waitForOwnedRunToFinish(result.surfaceId, startedAtMs));
    }
    return {
      ok: result.ok,
      note: result.note,
      sessionKey: result.surfaceId,
    };
  },

  /**
   * TODO(turn-dispatcher): migrate via Wave 2b.
   * Owned-session-store extraction will wire this to dispatchTurn() with
   * mode=['thread-resume'] and a resolveThreadId() that reads the owned
   * session store. Discovered sessions may fall through to 'append-transcript'.
   * Until then this method remains the authoritative resume path for Codex.
   */
  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    const startedAtMs = Date.now();
    const baseline = usageSnapshotFromTelemetry(await codexRuntime.getTelemetry?.(sessionKey));

    // Owned sessions: use existing owned pipeline
    if (sessionKey.startsWith('codex-owned:')) {
      const result = await continueOwnedCodexSession(sessionKey, message);
      scheduleCodexUsageDispatch(sessionKey, startedAtMs, baseline, undefined, undefined, () =>
        waitForOwnedRunToFinish(sessionKey, startedAtMs));
      return { ok: true, note: result.note, sessionKey };
    }

    if (sessionKey.startsWith('codex-live:')) {
      return {
        ok: false,
        note: 'This live Codex terminal has no durable thread binding yet, so resume is unavailable from the sidebar.',
      };
    }

    // Discovered Codex sessions: resume directly via CLI
    const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const os = await import('node:os');
      const { resolveCli, CliNotFoundError } = await import('@/lib/runtimes/shared/cli-resolver');
      let codexBin: string;
      try {
        const resolved = await resolveCli({
          runtimeId: 'codex',
          binaryName: 'codex',
          envOverride: 'O8_CODEX_BIN',
          extraEnvOverrides: ['CODEX_HOME'],
        });
        codexBin = resolved.path;
      } catch (resolveErr) {
        scheduleCodexUsageDispatch(sessionKey, startedAtMs, baseline);
        const note = resolveErr instanceof CliNotFoundError
          ? `Codex binary not found: ${resolveErr.message}`
          : `Failed to resolve Codex binary: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`;
        return { ok: false, note };
      }
      // `-c tools.image_generation=false`: Codex CLI 0.130.0 injects a hosted
      // image tool pinned to nonexistent gpt-image-2 → 400s the turn at spawn.
      // Async execFile: the sync variant blocked the whole Node event loop
      // (every API route, the WS bridge, timers) for up to 120s per resume.
      await promisify(execFile)(codexBin, ['exec', 'resume', threadId, message, '--json', '--dangerously-bypass-approvals-and-sandbox', '-c', 'tools.image_generation=false'], {
        cwd: process.env.HOME || os.homedir(),
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        encoding: 'utf-8',
      });
      scheduleCodexUsageDispatch(sessionKey, startedAtMs, baseline);
      return { ok: true, note: 'Sent to Codex.', sessionKey };
    } catch (err) {
      scheduleCodexUsageDispatch(sessionKey, startedAtMs, baseline);
      return { ok: false, note: err instanceof Error ? err.message : String(err) };
    }
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    if (sessionKey.startsWith('codex-owned:')) {
      const result = await interruptOwnedCodexSession(sessionKey);
      return {
        ok: result.interrupted,
        note: result.note,
        sessionKey,
      };
    }

    const discovered = await getCodexDiscoveredFleetAdditions({ fresh: true });
    const agent = discovered.agents.find((entry) => entry.sessionKey === sessionKey);
    const pidMatch = agent?.runtimeSurface?.sourceLabel.match(/live pid (\d+)/i);
    const pid = pidMatch?.[1] ? Number(pidMatch[1]) : NaN;

    if (!Number.isFinite(pid)) {
      return {
        ok: false,
        note: 'No live Codex PID is attached to this discovered session right now.',
        sessionKey,
      };
    }

    try {
      process.kill(pid, 'SIGINT');
      return {
        ok: true,
        note: `Interrupt sent to local Codex pid ${pid}.`,
        sessionKey,
      };
    } catch (err) {
      return {
        ok: false,
        note: err instanceof Error ? err.message : `Unable to interrupt pid ${pid}.`,
        sessionKey,
      };
    }
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    if (sessionKey.startsWith('codex-live:')) {
      return undefined;
    }

    if (sessionKey.startsWith('codex-owned:')) {
      const telemetrySources = await getOwnedCodexTelemetrySources(sessionKey);
      if (!telemetrySources) {
        return undefined;
      }

      const rolloutPath = telemetrySources.threadId
        ? await getCodexRolloutPath(`codex:${telemetrySources.threadId}`)
        : null;
      const sessionCost = rolloutPath
        ? await parseCost('codex', [rolloutPath])
        : telemetrySources.stdoutPaths.length > 0
          ? await parseCost('codex', telemetrySources.stdoutPaths)
          : null;

      if (!sessionCost) {
        return undefined;
      }

      const totalTokens = sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens;
      return {
        totalTokens,
        estimatedCostUsd: sessionCost.totalCostUsd,
        inputTokens: sessionCost.inputTokens,
        outputTokens: sessionCost.outputTokens,
        cacheReadTokens: sessionCost.cacheReadTokens,
        cacheWriteTokens: sessionCost.cacheWriteTokens,
        model: sessionCost.model ?? undefined,
      };
    }

    const rolloutPath = await getCodexRolloutPath(sessionKey);
    if (!rolloutPath) {
      return undefined;
    }

    const sessionCost = await parseCost('codex', [rolloutPath]);
    if (!sessionCost) {
      return undefined;
    }

    const totalTokens = sessionCost.inputTokens + sessionCost.outputTokens + sessionCost.cacheReadTokens;

    return {
      totalTokens,
      estimatedCostUsd: sessionCost.totalCostUsd,
      inputTokens: sessionCost.inputTokens,
      outputTokens: sessionCost.outputTokens,
      cacheReadTokens: sessionCost.cacheReadTokens,
      cacheWriteTokens: sessionCost.cacheWriteTokens,
      model: sessionCost.model ?? undefined,
    };
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    // Owned sessions: review packet from the owned store.
    if (sessionKey.startsWith('codex-owned:')) {
      try {
        const packet = await getOwnedCodexReviewPacket(sessionKey);
        return (packet.changedFiles ?? []).map((f) => ({
          path: f.path,
          status: (f.status ?? 'modified') as RuntimeChangedFile['status'],
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
        }));
      } catch (err) {
        console.error('[codex-runtime] getChangedFiles failed for owned session:', err);
        return [];
      }
    }

    // Discovered sessions: derive from the thread's cwd. These used to route
    // through the owned store, which always threw ("packet not found") into a
    // silent catch — the review UI showed "no changes" for every
    // user-terminal session despite advertising reviewDiffs.
    try {
      const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
      const thread = await queryCodexThreadById(threadId);
      if (!thread?.cwd) return [];
      const review = await getRuntimeRepoReview(thread.cwd);
      return (review.changedFiles ?? []).map((f) => ({
        path: f.path,
        status: (f.status ?? 'modified') as RuntimeChangedFile['status'],
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      }));
    } catch (err) {
      console.error('[codex-runtime] getChangedFiles failed for discovered session:', err);
      return [];
    }
  },
};
