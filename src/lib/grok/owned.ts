/**
 * Grok Build owned-session adapter.
 *
 * Headless mode uses `grok -p <prompt> --json-schema <schema>`. The schema is
 * intentionally permissive: it asks Grok for structured final output while the
 * parser remains defensive around streamed tool and status events.
 */

import os from 'node:os';
import path from 'node:path';
import type { OwnedRuntimeAdapter, OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';

const GROK_RESULT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    status: { type: 'string' },
    usage: {
      type: 'object',
      properties: {
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
        totalCostUsd: { type: 'number' },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});

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

export function grokLaunchArgs(ctx: { prompt: string; model?: string }): string[] {
  return [
    '-p', ctx.prompt,
    '--json-schema', GROK_RESULT_SCHEMA,
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

export function grokResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  return [
    '-p', ctx.prompt,
    '--session', ctx.threadId,
    '--json-schema', GROK_RESULT_SCHEMA,
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

export function grokParseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
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

  for (const [lineIndex, rawLine] of raw.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{')) {
      entries.push({
        id: `${run.id}:noise:${noiseIndex += 1}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 400),
        timestamp: fallbackTs,
        timestampLabel: formatClock(fallbackTs),
      });
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = String(parsed.type ?? parsed.event ?? '').toLowerCase();
    const ts = readString(parsed, 'timestamp', 'created_at') ?? fallbackTs;
    const tsLabel = formatClock(ts) ?? formatClock(fallbackTs);

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

const GROK_STDERR_NOISE_PATTERNS: RegExp[] = [
  /\[debug\]/i,
  /checking for updates/i,
  /loaded.*mcp/i,
];

const grokStore = createOwnedSessionStore({
  runtimeId: 'grok',
  surfaceIdPrefix: 'grok-owned:',
  rootEnvVar: 'O8_OWNED_GROK_ROOT',
  rootDefault: path.join(os.homedir(), '.o8', 'owned-grok'),
  binaryName: 'grok',
  binaryEnvOverride: 'O8_GROK_BIN',
  binaryExtraEnvOverrides: ['GROK_BUILD_BIN'],
  humanLabel: 'Owned Grok Build',
  squadShortName: 'Grok',
  sessionIdPrefix: 'grok-owned-',
  launchArgs: grokLaunchArgs,
  resumeArgs: grokResumeArgs,
  parseRunLog: grokParseRunLog,
  stderrNoise: GROK_STDERR_NOISE_PATTERNS,
} satisfies OwnedRuntimeAdapter);

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
