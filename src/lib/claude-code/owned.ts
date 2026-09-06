import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  buildClaudeStreamJsonArgs,
  buildClaudeStreamJsonUserPayload,
} from '@/lib/claude-code/interactive-session';
import { claudeReadOnlyLockoutArgs } from '@/lib/claude-code/read-only-args';
import {
  isReadOnlyRuntimeConfig,
  workModeRuntimeConfig,
} from '@/lib/runtimes/shared/owned-session/work-mode';
import {
  createClaudeCodeStreamJsonParser,
  type ClaudeCodeStreamJsonParserEvent,
} from '@/lib/claude-code/stream-json-parser';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { MODEL_IDS } from '@/lib/models';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  OwnedRuntimeAdapter,
  OwnedRunRecord,
  OwnedTailEntry,
  ParsedRunLog,
} from '@/lib/runtimes/shared/owned-session/types';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  buildClaudeCodeWorkerSpawnEnv,
  resolveClaudeCodeWorkerGatewayKey,
  resolveClaudeCodeWorkerSelection,
} from '@/lib/claude-code/worker-profile';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import { prepareMeteredGatewaySession } from '@/lib/claude-code/metered-gateway';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  ClaudeCodeWorkerAuthenticationError,
  prepareClaudeCodeWorkerConfig,
  ensureCodexSubscriptionProxyReady,
} from '@/lib/claude-code/codex-subscription-proxy';

function eventText(event: ClaudeCodeStreamJsonParserEvent): string {
  switch (event.type) {
    case 'delta':
    case 'thinking':
    case 'plan_step':
      return event.text;
    case 'tool_call':
      return event.preview ?? event.name;
    case 'tool_result':
      return event.preview ?? event.output ?? event.name ?? 'Tool result';
    case 'permission_request':
      return event.text;
    case 'usage':
      return `Usage: ${event.inputTokens} input, ${event.outputTokens} output${event.cacheReadTokens ? `, ${event.cacheReadTokens} cache read` : ''}${event.cacheWriteTokens ? `, ${event.cacheWriteTokens} cache write` : ''}`;
    case 'done':
      return event.text;
  }
}

function entryKind(event: ClaudeCodeStreamJsonParserEvent): OwnedTailEntry['kind'] {
  if (event.type === 'tool_call') return 'tool';
  if (event.type === 'tool_result') return 'tool-output';
  if (event.type === 'delta' || event.type === 'thinking' || event.type === 'done') return 'message';
  return 'event';
}

function parseClaudeOwnedRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  const parser = createClaudeCodeStreamJsonParser();
  const events = [...parser.pushChunk(raw), ...parser.flush()];
  const entries = events
    .map((event, index): OwnedTailEntry | null => {
      const text = eventText(event).trim();
      if (!text) return null;
      return {
        id: `${run.id}-${index}`,
        kind: entryKind(event),
        label: event.type,
        text,
        timestamp: run.startedAt,
      };
    })
    .filter((entry): entry is OwnedTailEntry => entry !== null);
  const done = events.find((event): event is Extract<ClaudeCodeStreamJsonParserEvent, { type: 'done' }> =>
    event.type === 'done');
  const usage = [...events].reverse().find(
    (event): event is Extract<ClaudeCodeStreamJsonParserEvent, { type: 'usage' }> => event.type === 'usage',
  );
  const inputTokens = done?.inputTokens ?? usage?.inputTokens ?? 0;
  const cacheReadTokens = done?.cacheReadTokens ?? usage?.cacheReadTokens ?? 0;
  const contextTokens = inputTokens + cacheReadTokens;
  const terminalMissing = !done && Boolean(run.childExit || run.finishedAt)
    && run.outcome !== 'interrupted' && !run.interruptRequestedAt;
  const providerFailed = done?.isError === true || terminalMissing;

  return {
    threadId: done?.sessionId,
    entries,
    outcome: providerFailed ? 'failed' : done ? 'finished' : 'running',
    completedTurn: Boolean(done && !providerFailed),
    ...(providerFailed ? {
      providerFailure: terminalMissing ? {
        subtype: 'missing_result',
        message: 'Worker exited without a terminal result.',
      } : {
        ...(done?.subtype ? { subtype: done.subtype } : {}),
        ...(done?.text.trim() ? { message: done.text.trim() } : {}),
      },
    } : {}),
    ...(contextTokens > 0 ? {
      turnContextUsage: { inputTokens, cacheReadTokens, contextTokens },
    } : {}),
  };
}

export const claudeCodeOwnedAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'claude-code',
  surfaceIdPrefix: 'claude-code-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-claude-code'),
  binaryName: 'claude',
  binaryEnvOverride: 'O8_CLAUDE_CODE_BIN',
  binaryExtraEnvOverrides: ['CLAUDE_BIN'],
  isolatedConfigHomeEnv: 'CLAUDE_CONFIG_DIR',
  workerMcpInjection: 'config-file',
  extraSpawnEnv: async (session) => {
    const configuredSource = session.runtimeConfig?.modelSource;
    const source = configuredSource === 'openrouter' || configuredSource === 'codex-subscription'
      ? configuredSource
      : 'native';
    const { configDir: isolatedConfigDir, credentialEnv } = await prepareClaudeCodeWorkerConfig(session.sessionDir, source);
    // Shell scratch must use the same private grant as other runtime state,
    // not a shared system-temp directory outside the worker sandbox.
    const isolatedScratchDir = path.join(isolatedConfigDir, 'tmp');
    await mkdir(isolatedScratchDir, { recursive: true, mode: 0o700 });
    const key = source === 'openrouter' ? await resolveClaudeCodeWorkerGatewayKey() : null;
    if (source === 'openrouter' && !key) {
      throw new Error('This Claude Code worker is pinned to OpenRouter, but its API key is no longer configured. Add the key in Settings > Models > API keys before resuming it.');
    }
    if (source === 'codex-subscription') {
      const connection = await ensureCodexSubscriptionProxyReady();
      return {
        ...buildClaudeCodeWorkerSpawnEnv(
          source,
          session.model,
          connection.clientToken,
          connection.baseUrl,
        ),
        CLAUDE_CONFIG_DIR: isolatedConfigDir,
        CLAUDE_CODE_TMPDIR: isolatedScratchDir,
        ...credentialEnv,
      };
    }
    const env = buildClaudeCodeWorkerSpawnEnv(source, session.model, key);
    if (source === 'openrouter') {
      const costUsd = Number(session.runtimeConfig?.spendCapCostUsd);
      const inputTokens = Number(session.runtimeConfig?.spendCapInputTokens);
      const cap: PacketSpendCap = { carrier: 'openrouter', costUsd, inputTokens };
      if (!Number.isFinite(costUsd) || costUsd <= 0 || !Number.isFinite(inputTokens) || inputTokens <= 0) {
        throw new Error('Metered worker launch refused because its packet spend cap is missing.');
      }
      env.ANTHROPIC_BASE_URL = await prepareMeteredGatewaySession(
        session,
        process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL?.trim() || env.ANTHROPIC_BASE_URL,
        cap,
      );
    }
    env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
    env.CLAUDE_CODE_TMPDIR = isolatedScratchDir;
    return { ...env, ...credentialEnv };
  },
  humanLabel: 'Owned Claude Code',
  squadShortName: 'Claude',
  sessionIdPrefix: 'claude-code-owned-',
  defaultModel: MODEL_IDS.claudeWorkerDefault,
  launchArgs: ({ model, effort, workerMcpConfigPath, runtimeConfig }) => [
    ...buildClaudeStreamJsonArgs(model ?? null, 'bypassPermissions', null, effort),
    // Read-only packets get a CLI-level deny rule for the native write tools.
    // The deny fires under bypassPermissions, so a read-only worker literally
    // cannot call Edit/Write/NotebookEdit/Task — see read-only-args.ts.
    ...claudeReadOnlyLockoutArgs(isReadOnlyRuntimeConfig(runtimeConfig)),
    '--disable-slash-commands',
    ...(workerMcpConfigPath ? ['--mcp-config', workerMcpConfigPath] : []),
  ],
  launchStdin: ({ prompt }) => buildClaudeStreamJsonUserPayload(prompt),
  resumeArgs: () => null,
  parseRunLog: parseClaudeOwnedRunLog,
  launchGroupLabel: 'Stream-json worker turn',
};

const claudeCodeOwnedStore = createOwnedSessionStore(claudeCodeOwnedAdapter);

export function invalidateOwnedClaudeCodeFleetCache(): void {
  claudeCodeOwnedStore.invalidateFleetCache();
}

export async function archiveOwnedClaudeCodeSession(surfaceId: string) {
  return claudeCodeOwnedStore.archiveSession(surfaceId);
}

export async function ownedClaudeCodeSessionState(surfaceId: string) {
  return claudeCodeOwnedStore.sessionState(surfaceId);
}

export async function sweepOrphanedClaudeCodeSessions(activeSurfaceIds: Set<string>, maxAgeMs: number) {
  return claudeCodeOwnedStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs);
}

export async function getOwnedClaudeCodeTelemetrySources(surfaceId: string) {
  return claudeCodeOwnedStore.getTelemetrySources(surfaceId);
}

export async function launchOwnedClaudeCodeSession(request: {
  cwd: string;
  prompt: string;
  clientMutationId?: string;
  model?: string;
  claudeCodeModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
  effort?: ThinkingEffort;
  laneId?: string;
  packetId?: string;
  spendCap?: PacketSpendCap;
  /** Durable packet work mode; 'read-only' hardens argv and the OS sandbox. */
  workMode?: WorkerWorkMode;
}) {
  const selection = resolveClaudeCodeWorkerSelection({
    carrier: request.claudeCodeCarrier,
    model: request.claudeCodeModel,
  });
  const selectedModel = selection.model ?? request.model;
  const meteredDefaults = selection.source === 'openrouter' && !request.spendCap
    ? getOperatorDefaultsSync().values
    : null;
  const spendCap = selection.source === 'openrouter'
    ? request.spendCap ?? {
        carrier: 'openrouter' as const,
        costUsd: meteredDefaults!.meteredPacketCostCapUsd,
        inputTokens: meteredDefaults!.meteredPacketInputTokenCap,
      }
    : undefined;
  if (selection.source === 'openrouter' && !await resolveClaudeCodeWorkerGatewayKey()) {
    return {
      ok: false,
      runtime: 'claude-code',
      surfaceId: '',
      sideEffect: 'none' as const,
      note: 'Claude Code gateway workers require an OpenRouter API key in Settings > Models > API keys. No worker was started.',
    };
  }
  if (selection.source === 'codex-subscription') {
    try {
      await ensureCodexSubscriptionProxyReady();
    } catch (error) {
      return {
        ok: false,
        runtime: 'claude-code',
        surfaceId: '',
        sideEffect: 'none' as const,
        note: error instanceof Error ? error.message : 'The Codex subscription carrier is unavailable. No worker was started.',
      };
    }
  }
  try {
    return await claudeCodeOwnedStore.launch({
      ...request,
      model: selectedModel ?? undefined,
      runtimeConfig: {
        modelSource: selection.source,
        ...(spendCap ? {
          spendCapCostUsd: String(spendCap.costUsd),
          spendCapInputTokens: String(spendCap.inputTokens),
        } : {}),
        // Pinned like the carrier so retry/rerun of a read-only packet keeps
        // launching read-only even if the caller forgets to re-supply it.
        ...workModeRuntimeConfig(request.workMode),
      },
    });
  } catch (error) {
    if (!(error instanceof ClaudeCodeWorkerAuthenticationError)) throw error;
    if (request.laneId) {
      recordLaneEvent(request.laneId, 'worker_not_authenticated', 'system', {
        runtime: 'claude-code',
        code: error.code,
        reason: error.reason,
        note: error.message,
      });
    }
    return {
      ok: false,
      runtime: 'claude-code',
      surfaceId: '',
      sideEffect: 'none' as const,
      note: `${error.message} No worker was started. Sign in with the operator Claude CLI, then retry the packet.`,
    };
  }
}

export async function getOwnedClaudeCodeFleetAdditions(options?: { fresh?: boolean }) {
  return claudeCodeOwnedStore.getFleetAdditions(options);
}

export async function getOwnedClaudeCodeRuntimeTail(surfaceId: string, limit?: number) {
  return claudeCodeOwnedStore.getRuntimeTail(surfaceId, limit);
}
