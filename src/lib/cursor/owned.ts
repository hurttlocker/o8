/**
 * Cursor CLI owned-session adapter.
 *
 * Headless mode uses `cursor-agent -p <prompt> --output-format stream-json`.
 * Cursor persists auth through its normal subscription login, or via
 * CURSOR_API_KEY in CI/worktree-safe runs.
 */

import os from 'node:os';
import path from 'node:path';
import type { OwnedRuntimeAdapter, OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';

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
  if (isRecord(value)) return readString(value, 'text', 'message', 'content', 'output') ?? stringifyPreview(value);
  return '';
}

export function cursorLaunchArgs(ctx: { prompt: string; model?: string }): string[] {
  return [
    '-p', ctx.prompt,
    '--output-format', 'stream-json',
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

export function cursorResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  return [
    '-p', ctx.prompt,
    '--resume', ctx.threadId,
    '--output-format', 'stream-json',
    ...(ctx.model ? ['--model', ctx.model] : []),
  ];
}

export function cursorParseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
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

    if (type === 'assistant' || type === 'message' || type === 'content' || type === 'delta') {
      const role = String(parsed.role ?? '').toLowerCase();
      if (role === 'user' || role === 'operator') continue;
      const text = compactText(readString(parsed, 'text', 'message', 'content') ?? extractText(parsed.content ?? parsed.delta), 500);
      if (!text) continue;
      entries.push({
        id: `${run.id}:message:${lineIndex}`,
        kind: 'message',
        label: 'Cursor',
        text,
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    if (type === 'tool_use' || type === 'tool_call' || type === 'tool') {
      const name = readString(parsed, 'tool', 'name', 'tool_name') ?? 'tool';
      const input = parsed.input ?? parsed.arguments ?? parsed.args ?? {};
      entries.push({
        id: `${run.id}:tool:${readString(parsed, 'id', 'call_id') ?? lineIndex}`,
        kind: 'tool',
        label: name,
        text: compactText(stringifyPreview(input), 400),
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

    if (type === 'result' || type === 'done' || type === 'complete' || type === 'completed') {
      completedTurn = true;
      const text = readString(parsed, 'text', 'message', 'response');
      if (text) {
        entries.push({
          id: `${run.id}:result-text:${lineIndex}`,
          kind: 'message',
          label: 'Cursor',
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

const CURSOR_STDERR_NOISE_PATTERNS: RegExp[] = [
  /\[debug\]/i,
  /checking for updates/i,
  /loaded.*mcp/i,
];

const cursorStore = createOwnedSessionStore({
  runtimeId: 'cursor',
  surfaceIdPrefix: 'cursor-owned:',
  rootEnvVar: 'O8_OWNED_CURSOR_ROOT',
  rootDefault: path.join(os.homedir(), '.o8', 'owned-cursor'),
  binaryName: 'cursor-agent',
  binaryEnvOverride: 'O8_CURSOR_BIN',
  binaryExtraEnvOverrides: ['CURSOR_AGENT_BIN'],
  humanLabel: 'Owned Cursor',
  squadShortName: 'Cursor',
  sessionIdPrefix: 'cursor-owned-',
  launchArgs: cursorLaunchArgs,
  resumeArgs: cursorResumeArgs,
  parseRunLog: cursorParseRunLog,
  stderrNoise: CURSOR_STDERR_NOISE_PATTERNS,
} satisfies OwnedRuntimeAdapter);

export const launchOwnedCursorSession = cursorStore.launch.bind(cursorStore);
export const continueOwnedCursorSession = cursorStore.resume.bind(cursorStore);
export const interruptOwnedCursorSession = cursorStore.interrupt.bind(cursorStore);
export const getOwnedCursorFleetAdditions = cursorStore.getFleetAdditions.bind(cursorStore);
export const getOwnedCursorRuntimeTail = cursorStore.getRuntimeTail.bind(cursorStore);
export const getOwnedCursorReviewPacket = cursorStore.getReviewPacket.bind(cursorStore);
export const getOwnedCursorTelemetrySources = cursorStore.getTelemetrySources.bind(cursorStore);
export const setOwnedCursorReviewDisposition = cursorStore.setReviewDisposition.bind(cursorStore);
export const invalidateOwnedCursorFleetCache = cursorStore.invalidateFleetCache.bind(cursorStore);
export const archiveOwnedCursorSession = cursorStore.archiveSession.bind(cursorStore);
export const ownedCursorSessionState = cursorStore.sessionState.bind(cursorStore);
export const sweepOrphanedCursorSessions = cursorStore.sweepOrphanedSessions.bind(cursorStore);
