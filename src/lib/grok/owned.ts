/**
 * Grok Build owned-session adapter.
 *
 * Current releases expose an official ACP process with durable session resume.
 * The parser retains the older one-shot JSON contracts so existing archived
 * sessions remain readable after the transport migration.
 */

import path from 'node:path';
import {
  AcpRequestError,
  type AcpInboundRequest,
  type AcpRawNotification,
} from '@/lib/acp/client';
import type { OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import {
  createOwnedAcpSessionStore,
  type OwnedAcpRunRecord,
  type OwnedAcpRuntimeAdapter,
} from '@/lib/runtimes/shared/owned-acp';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import { getDataDir } from '@/lib/data-dir-migration';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function stringifyPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => isRecord(item) ? readString(item, 'text', 'message', 'content') ?? '' : '').filter(Boolean).join(' ');
  }
  if (isRecord(value)) return readString(value, 'summary', 'text', 'message', 'content', 'output') ?? stringifyPreview(value);
  return '';
}

function parseEmbeddedJson(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function grokLaunchArgs(ctx: { prompt: string; model?: string }): string[] {
  return [
    'agent',
    '--always-approve',
    '--no-leader',
    ...(ctx.model ? ['--model', ctx.model] : []),
    'stdio',
  ];
}

export function grokResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  return grokLaunchArgs(ctx);
}

export function grokParseRunLog(raw: string, run: OwnedAcpRunRecord): ParsedRunLog {
  const fallbackTs = run.finishedAt ?? run.startedAt;
  const entries: OwnedTailEntry[] = [{
    id: `${run.id}:prompt`,
    kind: 'event',
    label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
    text: compactText(run.prompt, 400),
    timestamp: run.startedAt,
    timestampLabel: formatClock(run.startedAt),
  }];
  let threadId: string | undefined;
  let completedTurn = false;
  let noiseIndex = 0;
  let acpMessage: { index: number; text: string; timestamp: string; timestampLabel?: string } | null = null;
  const flushAcpMessage = () => {
    if (!acpMessage?.text.trim()) {
      acpMessage = null;
      return;
    }
    entries.push({
      id: `${run.id}:acp-message:${acpMessage.index}`,
      kind: 'message',
      label: 'Grok',
      text: compactText(acpMessage.text, 2_000),
      timestamp: acpMessage.timestamp,
      timestampLabel: acpMessage.timestampLabel,
    });
    acpMessage = null;
  };

  const wholeDocument = (() => {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  })();
  const records = wholeDocument
    ? [{ lineIndex: 0, parsed: wholeDocument }]
    : raw.split('\n').flatMap((rawLine, lineIndex) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return [];
      if (!trimmed.startsWith('{')) {
        entries.push({
          id: `${run.id}:noise:${noiseIndex += 1}`,
          kind: 'event',
          label: 'Runtime',
          text: compactText(trimmed, 400),
          timestamp: fallbackTs,
          timestampLabel: formatClock(fallbackTs),
        });
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return isRecord(parsed) ? [{ lineIndex, parsed }] : [];
      } catch {
        return [];
      }
    });

  for (const { lineIndex, parsed } of records) {
    const type = String(parsed.type ?? parsed.event ?? '').toLowerCase();
    const ts = readString(parsed, 'timestamp', 'created_at') ?? fallbackTs;
    const tsLabel = formatClock(ts) ?? formatClock(fallbackTs);

    if (parsed.method === 'session/update') {
      const params = isRecord(parsed.params) ? parsed.params : null;
      const update = isRecord(params?.update) ? params.update : null;
      const sessionId = readString(params, 'sessionId');
      if (sessionId) threadId = sessionId;
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = isRecord(update.content) ? update.content : null;
        const text = typeof content?.text === 'string' ? content.text : '';
        if (text) {
          acpMessage ??= { index: lineIndex, text: '', timestamp: ts, timestampLabel: tsLabel };
          acpMessage.text += text;
        }
        continue;
      }
      if (update?.sessionUpdate === 'tool_call') {
        flushAcpMessage();
        entries.push({
          id: `${run.id}:acp-tool:${readString(update, 'toolCallId') ?? lineIndex}`,
          kind: 'tool',
          label: readString(update, 'title', 'kind') ?? 'tool',
          text: compactText(stringifyPreview(update.rawInput ?? {}), 800),
          timestamp: ts,
          timestampLabel: tsLabel,
        });
      } else if (update?.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        flushAcpMessage();
        entries.push({
          id: `${run.id}:acp-tool-result:${readString(update, 'toolCallId') ?? lineIndex}`,
          kind: 'tool-output',
          label: readString(update, 'title') ?? 'Tool output',
          text: compactText(extractText(update.content) || stringifyPreview(update.content ?? {}), 800),
          timestamp: ts,
          timestampLabel: tsLabel,
        });
      }
      continue;
    }

    if (parsed.method === '_x.ai/session_notification') {
      const params = isRecord(parsed.params) ? parsed.params : null;
      const update = isRecord(params?.update) ? params.update : null;
      const sessionId = readString(params, 'sessionId');
      if (sessionId) threadId = sessionId;
      if (update?.sessionUpdate === 'turn_completed') {
        flushAcpMessage();
        completedTurn = true;
        const usage = isRecord(update.usage) ? update.usage : null;
        const input = usage?.inputTokens;
        const output = usage?.outputTokens;
        const cacheRead = usage?.cachedReadTokens;
        const costTicks = usage?.costUsdTicks;
        const cost = typeof costTicks === 'number' ? costTicks / 10_000_000_000 : null;
        const bits = [
          typeof input === 'number' ? `${input} in` : null,
          typeof output === 'number' ? `${output} out` : null,
          typeof cacheRead === 'number' && cacheRead > 0 ? `${cacheRead} cached` : null,
          cost !== null ? `$${cost.toFixed(6)}` : null,
        ].filter(Boolean);
        entries.push({
          id: `${run.id}:acp-usage:${lineIndex}`,
          kind: 'event',
          label: 'Turn completed',
          text: bits.length ? `Usage • ${bits.join(' • ')}` : 'Run completed.',
          timestamp: ts,
          timestampLabel: tsLabel,
        });
      }
      continue;
    }

    if (parsed.method === 'o8/session.prompt.settled') {
      flushAcpMessage();
      const params = isRecord(parsed.params) ? parsed.params : null;
      completedTurn = params?.outcome === 'finished';
      continue;
    }

    flushAcpMessage();

    const rootSessionId = readString(parsed, 'session_id', 'sessionId', 'thread_id', 'threadId');
    if (rootSessionId) threadId = rootSessionId;
    const structuredOutput = parseEmbeddedJson(parsed.structuredOutput) ?? parseEmbeddedJson(parsed.text);
    const rootSummary = readString(structuredOutput, 'summary', 'text', 'message', 'response');
    const stopReason = readString(parsed, 'stopReason', 'stop_reason');
    if (!type && (structuredOutput || stopReason)) {
      completedTurn = Boolean(structuredOutput || stopReason === 'end_turn');
      if (rootSummary) {
        entries.push({
          id: `${run.id}:result-text:${lineIndex}`,
          kind: 'message',
          label: 'Grok',
          text: compactText(rootSummary, 500),
          timestamp: ts,
          timestampLabel: tsLabel,
        });
      }
      const usage = isRecord(parsed.usage) ? parsed.usage : null;
      const input = usage?.input_tokens ?? usage?.inputTokens;
      const output = usage?.output_tokens ?? usage?.outputTokens;
      const cost = parsed.total_cost_usd ?? parsed.totalCostUsd;
      const bits = [
        typeof input === 'number' ? `${input} in` : null,
        typeof output === 'number' ? `${output} out` : null,
        typeof cost === 'number' ? `$${cost.toFixed(6)}` : null,
      ].filter(Boolean);
      entries.push({
        id: `${run.id}:result:${lineIndex}`,
        kind: 'event',
        label: 'Turn completed',
        text: bits.length ? `Usage • ${bits.join(' • ')}` : 'Run completed.',
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'init' || type === 'session' || type === 'start') {
      const id = readString(parsed, 'session_id', 'sessionId', 'thread_id', 'threadId', 'id');
      if (id) threadId = id;
      continue;
    }

    if (type === 'assistant' || type === 'message' || type === 'content') {
      const role = String(parsed.role ?? '').toLowerCase();
      if (role === 'user' || role === 'operator') continue;
      const text = compactText(readString(parsed, 'text', 'message', 'content', 'summary') ?? extractText(parsed.content), 500);
      if (!text) continue;
      entries.push({
        id: `${run.id}:message:${lineIndex}`,
        kind: 'message',
        label: 'Grok',
        text,
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'tool_use' || type === 'tool_call' || type === 'tool') {
      const name = readString(parsed, 'tool', 'name', 'tool_name') ?? 'tool';
      entries.push({
        id: `${run.id}:tool:${readString(parsed, 'id', 'call_id') ?? lineIndex}`,
        kind: 'tool',
        label: name,
        text: compactText(stringifyPreview(parsed.input ?? parsed.arguments ?? parsed.args ?? {}), 400),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'tool_result' || type === 'tool_output') {
      const text = compactText(readString(parsed, 'output', 'result', 'content') ?? extractText(parsed.output ?? parsed.result), 500);
      if (!text) continue;
      entries.push({
        id: `${run.id}:tool-output:${readString(parsed, 'id', 'call_id') ?? lineIndex}`,
        kind: 'tool-output',
        label: 'Tool output',
        text,
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'result' || type === 'done' || type === 'complete' || type === 'completed' || readString(parsed, 'summary')) {
      completedTurn = true;
      const text = readString(parsed, 'summary', 'text', 'message', 'response');
      if (text) {
        entries.push({
          id: `${run.id}:result-text:${lineIndex}`,
          kind: 'message',
          label: 'Grok',
          text: compactText(text, 500),
          timestamp: ts,
          timestampLabel: tsLabel,
        });
      }
      const usage = isRecord(parsed.usage) ? parsed.usage : isRecord(parsed.stats) ? parsed.stats : null;
      const input = usage?.input_tokens ?? usage?.inputTokens;
      const output = usage?.output_tokens ?? usage?.outputTokens;
      const bits = [
        typeof input === 'number' ? `${input} in` : null,
        typeof output === 'number' ? `${output} out` : null,
      ].filter(Boolean);
      entries.push({
        id: `${run.id}:result:${lineIndex}`,
        kind: 'event',
        label: 'Turn completed',
        text: bits.length ? `Usage • ${bits.join(' • ')}` : 'Run completed.',
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'error') {
      entries.push({
        id: `${run.id}:error:${lineIndex}`,
        kind: 'event',
        label: 'Error',
        text: compactText(readString(parsed, 'message', 'error', 'detail') ?? stringifyPreview(parsed), 500),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
    }
  }

  flushAcpMessage();

  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : run.finishedAt
          ? 'failed'
          : 'running'
    : run.outcome;

  return { threadId, entries, outcome, completedTurn };
}

function grokPermission(request: AcpInboundRequest): unknown {
  if (request.method !== 'session/request_permission') {
    throw new AcpRequestError(-32601, `Unsupported ACP request: ${request.method}`);
  }
  const options = Array.isArray(request.params.options) ? request.params.options : [];
  const allowOnce = options.find((option) => (
    option
    && typeof option === 'object'
    && !Array.isArray(option)
    && (option as Record<string, unknown>).kind === 'allow_once'
    && typeof (option as Record<string, unknown>).optionId === 'string'
  )) as Record<string, unknown> | undefined;
  return allowOnce
    ? { outcome: { outcome: 'selected', optionId: allowOnce.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function grokAcpSummary(notification: AcpRawNotification): string | null {
  if (notification.method !== 'session/update') return null;
  const update = isRecord(notification.params.update) ? notification.params.update : null;
  if (update?.sessionUpdate !== 'agent_message_chunk') return null;
  const content = isRecord(update.content) ? update.content : null;
  return typeof content?.text === 'string' && content.text.trim() ? content.text.trim() : null;
}

function persistGrokNotification(notification: AcpRawNotification): boolean {
  if (notification.method !== 'session/update') return true;
  const update = isRecord(notification.params.update) ? notification.params.update : null;
  return update?.sessionUpdate !== 'available_commands_update';
}

const grokStore = createOwnedAcpSessionStore({
  runtimeId: 'grok',
  surfaceIdPrefix: 'grok-owned:',
  rootEnvVar: 'O8_OWNED_GROK_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-grok'),
  binaryName: 'grok',
  humanLabel: 'Owned Grok Build',
  squadShortName: 'Grok',
  sessionIdPrefix: 'grok-owned-',
  defaultModel: 'grok-4.6',
  async resolveLaunch(session) {
    const resolved = await resolveCli({
      runtimeId: 'grok',
      binaryName: 'grok',
      envOverride: 'O8_GROK_BIN',
      extraEnvOverrides: ['GROK_BUILD_BIN'],
    });
    return {
      command: resolved.path,
      args: grokLaunchArgs({ prompt: session.latestPrompt, model: session.model }),
      commandIdentity: path.basename(resolved.path),
      version: resolved.version,
      env: { FORCE_COLOR: '0', NO_COLOR: '1' },
    };
  },
  validateInitialize(result) {
    if (result.protocolVersion !== 1) {
      throw new Error(`Grok ACP protocol ${result.protocolVersion} is incompatible; expected 1.`);
    }
    return { version: result.agentInfo?.version };
  },
  supportsResume(result) {
    const capabilities = isRecord(result.agentCapabilities?.sessionCapabilities)
      ? result.agentCapabilities.sessionCapabilities
      : null;
    return Boolean(capabilities && 'resume' in capabilities);
  },
  handleRequest: grokPermission,
  shouldPersistNotification: persistGrokNotification,
  notificationSummary: grokAcpSummary,
  parseRunLog: grokParseRunLog,
} satisfies OwnedAcpRuntimeAdapter);

export const launchOwnedGrokSession = grokStore.launch.bind(grokStore);
export const continueOwnedGrokSession = grokStore.resume.bind(grokStore);
export const interruptOwnedGrokSession = grokStore.interrupt.bind(grokStore);
export const getOwnedGrokFleetAdditions = grokStore.getFleetAdditions.bind(grokStore);
export const getOwnedGrokRuntimeTail = grokStore.getRuntimeTail.bind(grokStore);
export const getOwnedGrokReviewPacket = grokStore.getReviewPacket.bind(grokStore);
export const getOwnedGrokTelemetrySources = grokStore.getTelemetrySources.bind(grokStore);
export const setOwnedGrokReviewDisposition = grokStore.setReviewDisposition.bind(grokStore);
export const invalidateOwnedGrokFleetCache = grokStore.invalidateFleetCache.bind(grokStore);
export const archiveOwnedGrokSession = grokStore.archiveSession.bind(grokStore);
export const ownedGrokSessionState = grokStore.sessionState.bind(grokStore);
export const sweepOrphanedGrokSessions = grokStore.sweepOrphanedSessions.bind(grokStore);
