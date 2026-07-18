/**
 * opencode owned-session adapter
 *
 * Wires the opencode CLI into the shared owned-session primitive.
 * Creates/resumes sessions under ~/.o8/owned-opencode/ and surfaces
 * them in the fleet as "opencode-owned:" prefixed entries.
 *
 * Binary: `opencode` (npm `opencode-ai`).
 * Local install: 1.4.3. Upstream: 1.14.18.
 * TODO(opencode-1.14): audit flag changes when upgrading beyond 1.4.3.
 *
 * Headless coding mode:
 *   opencode run "<prompt>" --format json --model <provider>/<model>
 *
 * Resume: opencode run "<prompt>" --format json --session <ses_xxx>
 *
 * JSON output: newline-delimited JSON (JSONL). Schema is less stable than
 * Codex — parser is fully defensive: unknown event types become `kind:'event'`
 * entries and never crash.
 */

import os from 'node:os';
import path from 'node:path';
import type { OwnedRuntimeAdapter, OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import { MODEL_IDS } from '@/lib/models';

// ── Constants ─────────────────────────────────────────────────────────────────

const OPENCODE_OWNED_ROOT = process.env.O8_OWNED_OPENCODE_ROOT
  ?? path.join(os.homedir(), '.o8', 'owned-opencode');

const OPENCODE_DEFAULT_MODEL = MODEL_IDS.opencodeDefault;

/** Stderr patterns that are non-fatal noise for opencode. */
export const OPENCODE_STDERR_NOISE_PATTERNS: RegExp[] = [
  /\[opencode\]\s+loading config from/i,
  /warn:\s+mcp server '[^']+' not connected/i,
  /warn:\s+failed to connect to mcp server/i,
  /warn:\s+no model specified/i,
  /debug:/i,
  /opencode\/storage/i,
];

// ── JSON event helpers ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeStringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function readStr(rec: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!rec) return undefined;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// ── Build argv ─────────────────────────────────────────────────────────────────

export function opencodeLaunchArgs(ctx: { cwd: string; prompt: string; model?: string }): string[] {
  const model = ctx.model?.trim() || OPENCODE_DEFAULT_MODEL;
  return [
    'run',
    ctx.prompt,
    '--format', 'json',
    '--model', model,
  ];
}

export function opencodeResumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] {
  // threadId is the `ses_` prefixed session UUID from the `init` event.
  const args: string[] = [
    'run',
    ctx.prompt,
    '--format', 'json',
    '--session', ctx.threadId,
  ];
  if (ctx.model?.trim()) {
    args.push('--model', ctx.model.trim());
  }
  return args;
}

// ── JSONL log parser ───────────────────────────────────────────────────────────

/**
 * Parse opencode's JSONL stdout into normalized tail entries.
 *
 * opencode's JSON event schema (based on 1.4.3 observations + Wave 1 research):
 *   {"type":"init","sessionId":"ses_xxx"}
 *   {"type":"message","role":"assistant","content":"..."}
 *   {"type":"tool_use","tool":"read"|"write"|"edit"|"shell"|"grep",...,"input":{...}}
 *   {"type":"tool_result","output":"...", "result":"..."}
 *   {"type":"result","usage":{"inputTokens":N,"outputTokens":N,"totalCostUsd":X},"finishReason":"stop"}
 *
 * Any event with an unrecognized `type` is recorded as `kind:'event'` — we
 * never throw on an unknown shape.
 */
export function opencodeParseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
  // Seed with a prompt entry so the transcript shows what was asked.
  const entries: OwnedTailEntry[] = [
    {
      id: `${run.id}:prompt`,
      kind: 'event',
      label: run.mode === 'launch' ? 'Launch prompt' : 'Resume prompt',
      text: compactText(run.prompt, 400),
      timestamp: run.startedAt,
      timestampLabel: formatClock(run.startedAt),
    },
  ];

  let threadId: string | undefined;
  let completedTurn = false;
  let noiseIndex = 0;
  const fallbackTs = run.finishedAt ?? run.startedAt;

  for (const [lineIndex, rawLine] of raw.split('\n').entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    // Skip non-JSON lines (stderr mixed in, progress bars, etc.)
    if (!trimmed.startsWith('{')) {
      // Only surface as noise entry if it contains something meaningful
      const isFatal = /rate.?limit|auth.?fail|unauthorized|invalid.?api.?key/i.test(trimmed);
      if (isFatal) {
        entries.push({
          id: `${run.id}:fatal:${noiseIndex += 1}`,
          kind: 'event',
          label: 'Runtime error',
          text: compactText(trimmed, 500),
          timestamp: fallbackTs,
          timestampLabel: formatClock(fallbackTs),
        });
      }
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not valid JSON — skip silently
      continue;
    }

    const eventType = typeof parsed.type === 'string' ? parsed.type : '';
    const ts = typeof parsed.timestamp === 'string' && parsed.timestamp
      ? parsed.timestamp
      : fallbackTs;
    const tsLabel = formatClock(ts) ?? formatClock(fallbackTs);

    // ── init ──────────────────────────────────────────────────────────────────
    if (eventType === 'init') {
      const sessionId = readStr(parsed, 'sessionId', 'session_id', 'id');
      // opencode session IDs start with 'ses_'
      if (sessionId && sessionId.startsWith('ses_')) {
        threadId = sessionId;
      }
      continue;
    }

    // ── message ───────────────────────────────────────────────────────────────
    if (eventType === 'message') {
      const role = readStr(parsed, 'role') ?? 'assistant';
      // Only surface assistant messages in the transcript
      if (role !== 'assistant') continue;

      const contentRaw = parsed.content;
      let text = '';
      if (typeof contentRaw === 'string') {
        text = contentRaw;
      } else if (Array.isArray(contentRaw)) {
        text = contentRaw
          .map((item) => {
            if (!isRecord(item)) return '';
            return readStr(item, 'text', 'message') ?? '';
          })
          .filter(Boolean)
          .join(' ');
      } else if (isRecord(contentRaw)) {
        text = readStr(contentRaw, 'text', 'message') ?? safeStringify(contentRaw);
      }

      if (!text) continue;

      entries.push({
        id: `${run.id}:message:${lineIndex}`,
        kind: 'message',
        label: 'opencode',
        text: compactText(text, 500),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    // ── tool_use ──────────────────────────────────────────────────────────────
    if (eventType === 'tool_use') {
      const toolName = readStr(parsed, 'tool', 'name', 'tool_name') ?? 'tool';
      const toolInput = parsed.input ?? parsed.args ?? parsed.arguments ?? {};
      entries.push({
        id: `${run.id}:tool:${lineIndex}`,
        kind: 'tool',
        label: toolName,
        text: compactText(safeStringify(toolInput), 400),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    // ── tool_result ───────────────────────────────────────────────────────────
    if (eventType === 'tool_result') {
      const outputRaw = parsed.output ?? parsed.result ?? parsed.content ?? '';
      const outputText = typeof outputRaw === 'string'
        ? outputRaw
        : safeStringify(outputRaw);

      if (!outputText) continue;

      entries.push({
        id: `${run.id}:tool-output:${lineIndex}`,
        kind: 'tool-output',
        label: '',
        text: compactText(outputText, 500),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    // ── result (terminal event) ───────────────────────────────────────────────
    if (eventType === 'result') {
      completedTurn = true;
      const usage = isRecord(parsed.usage) ? parsed.usage : null;
      const usageBits = [
        usage?.inputTokens ? `${usage.inputTokens} in` : null,
        usage?.outputTokens ? `${usage.outputTokens} out` : null,
      ].filter(Boolean);

      entries.push({
        id: `${run.id}:result:${lineIndex}`,
        kind: 'event',
        label: 'Completed',
        text: usageBits.length ? `Usage • ${usageBits.join(' • ')}` : 'Run completed.',
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    // ── error (runtime-level error event) ────────────────────────────────────
    if (eventType === 'error') {
      const msg = readStr(parsed, 'message', 'error', 'detail') ?? safeStringify(parsed);
      entries.push({
        id: `${run.id}:error:${lineIndex}`,
        kind: 'event',
        label: 'Error',
        text: compactText(msg, 500),
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      continue;
    }

    // ── unknown event type — record defensively ───────────────────────────────
    entries.push({
      id: `${run.id}:unknown:${lineIndex}`,
      kind: 'event',
      label: eventType || 'unknown',
      text: compactText(safeStringify(parsed), 300),
      timestamp: ts,
      timestampLabel: tsLabel,
    });
  }

  // Determine outcome from completedTurn flag
  const outcome = run.outcome === 'running'
    ? completedTurn
      ? 'finished'
      : run.interruptRequestedAt
        ? 'interrupted'
        : 'running'
    : run.outcome;

  return { threadId, entries, outcome, completedTurn };
}

// ── OwnedRuntimeAdapter ───────────────────────────────────────────────────────

export const opencodeAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'opencode',
  surfaceIdPrefix: 'opencode-owned:',
  rootEnvVar: 'O8_OWNED_OPENCODE_ROOT',
  rootDefault: OPENCODE_OWNED_ROOT,
  binaryName: 'opencode',
  binaryEnvOverride: 'O8_OPENCODE_BIN',
  humanLabel: 'Owned opencode',
  squadShortName: 'opencode',
  sessionIdPrefix: 'opencode-owned-',
  defaultModel: OPENCODE_DEFAULT_MODEL,

  launchArgs: opencodeLaunchArgs,

  resumeArgs(ctx): string[] {
    return opencodeResumeArgs(ctx);
  },

  parseRunLog: opencodeParseRunLog,

  stderrNoise: OPENCODE_STDERR_NOISE_PATTERNS,
};

// ── Public store wrappers ─────────────────────────────────────────────────────

const store = createOwnedSessionStore(opencodeAdapter);

export const launchOwnedOpencodeSession = store.launch.bind(store);
export const continueOwnedOpencodeSession = store.resume.bind(store);
export const interruptOwnedOpencodeSession = store.interrupt.bind(store);
export const getOwnedOpencodeFleetAdditions = store.getFleetAdditions.bind(store);
export const getOwnedOpencodeRuntimeTail = store.getRuntimeTail.bind(store);
export const getOwnedOpencodeReviewPacket = store.getReviewPacket.bind(store);
export const getOwnedOpencodeTelemetrySources = store.getTelemetrySources.bind(store);
export const setOwnedOpencodeReviewDisposition = store.setReviewDisposition.bind(store);
export const invalidateOwnedOpencodeFleetCache = store.invalidateFleetCache.bind(store);
export const archiveOwnedOpencodeSession = store.archiveSession.bind(store);
export const ownedOpencodeSessionState = store.sessionState.bind(store);
export const sweepOrphanedOpencodeSessions = store.sweepOrphanedSessions.bind(store);
