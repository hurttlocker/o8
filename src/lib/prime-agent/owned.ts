/**
 * prime-agent owned-session adapter.
 *
 * v1 launches headless via `prime-agent --mode json -p <prompt>`: JSONL
 * events on stdout, with the first line being prime-agent's session header
 * (carries the session id). Resume threads through `-r <sessionId>`. This
 * mirrors the Grok Build adapter's one-process-per-turn shape rather than
 * Pi's hand-rolled bidirectional RPC client, because prime-agent's `--mode
 * rpc` steer verb is a real upgrade path but not required for a first launch
 * — see the RPC note in prime-agent-cost-parser.ts for why cost stays
 * conservative until that upgrade lands.
 *
 * `--session-dir` is passed as a path relative to the spawn cwd (always
 * `session.repoPath`, the packet worktree — see run-controller.ts), so
 * prime-agent's own session JSONL travels with the worktree instead of
 * piling up in the shared `~/.prime/agent/sessions/`.
 */

import path from 'node:path';
import type { OwnedRuntimeAdapter, OwnedRunRecord, OwnedTailEntry, ParsedRunLog } from '@/lib/runtimes/shared/owned-session/types';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { compactText, formatClock } from '@/lib/runtimes/shared/owned-session/helpers';
import { getDataDir } from '@/lib/data-dir-migration';

const SESSION_DIR_RELATIVE = '.o8-prime-agent-sessions';

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

export function primeAgentLaunchArgs(ctx: { prompt: string }): string[] {
  return ['-p', ctx.prompt, '--mode', 'json', '--session-dir', SESSION_DIR_RELATIVE];
}

export function primeAgentResumeArgs(ctx: { threadId: string; prompt: string }): string[] {
  return ['-p', ctx.prompt, '--mode', 'json', '--session-dir', SESSION_DIR_RELATIVE, '-r', ctx.threadId];
}

export function primeAgentParseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog {
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

  raw.split('\n').forEach((rawLine, lineIndex) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('{')) {
      entries.push({
        id: `${run.id}:noise:${noiseIndex += 1}`,
        kind: 'event',
        label: 'Runtime',
        text: compactText(trimmed, 400),
        timestamp: fallbackTs,
        timestampLabel: formatClock(fallbackTs),
      });
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(parsed.type ?? parsed.event ?? '').toLowerCase();
    const ts = readString(parsed, 'timestamp', 'created_at') ?? fallbackTs;
    const tsLabel = formatClock(ts) ?? formatClock(fallbackTs);

    // The docs are explicit: "the FIRST line is a session header carrying
    // the session id." Accept that unconditionally on line 0, plus the
    // named types in case a later line repeats/updates the session id.
    if (lineIndex === 0 || type === 'session' || type === 'init' || type === 'header') {
      const id = readString(parsed, 'sessionId', 'session_id', 'id');
      if (id) threadId = id;
      if (lineIndex === 0) return;
    }

    if (type === 'assistant' || type === 'message' || type === 'content') {
      const role = String(parsed.role ?? '').toLowerCase();
      if (role === 'user' || role === 'operator') return;
      const text = compactText(readString(parsed, 'text', 'message', 'content', 'summary'), 500);
      if (!text) return;
      entries.push({
        id: `${run.id}:message:${lineIndex}`,
        kind: 'message',
        label: 'Prime Agent',
        text,
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      return;
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
      return;
    }

    if (type === 'tool_result' || type === 'tool_output') {
      const text = compactText(readString(parsed, 'output', 'result', 'content'), 500);
      if (!text) return;
      entries.push({
        id: `${run.id}:tool-output:${readString(parsed, 'id', 'call_id') ?? lineIndex}`,
        kind: 'tool-output',
        label: 'Tool output',
        text,
        timestamp: ts,
        timestampLabel: tsLabel,
      });
      return;
    }

    if (type === 'result' || type === 'done' || type === 'complete' || type === 'completed' || readString(parsed, 'summary')) {
      completedTurn = true;
      const text = readString(parsed, 'summary', 'text', 'message', 'response');
      if (text) {
        entries.push({
          id: `${run.id}:result-text:${lineIndex}`,
          kind: 'message',
          label: 'Prime Agent',
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
      return;
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
  });

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

const PRIME_AGENT_STDERR_NOISE_PATTERNS: RegExp[] = [
  /\[debug\]/i,
  /checking for updates/i,
];

const primeAgentStore = createOwnedSessionStore({
  runtimeId: 'prime-agent',
  surfaceIdPrefix: 'prime-agent-owned:',
  rootEnvVar: 'O8_OWNED_PRIME_AGENT_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-prime-agent'),
  binaryName: 'prime-agent',
  binaryEnvOverride: 'O8_PRIME_AGENT_BIN',
  humanLabel: 'Owned Prime Agent',
  squadShortName: 'Prime Agent',
  sessionIdPrefix: 'prime-agent-owned-',
  launchArgs: primeAgentLaunchArgs,
  resumeArgs: primeAgentResumeArgs,
  parseRunLog: primeAgentParseRunLog,
  stderrNoise: PRIME_AGENT_STDERR_NOISE_PATTERNS,
} satisfies OwnedRuntimeAdapter);

export const launchOwnedPrimeAgentSession = primeAgentStore.launch.bind(primeAgentStore);
export const continueOwnedPrimeAgentSession = primeAgentStore.resume.bind(primeAgentStore);
export const interruptOwnedPrimeAgentSession = primeAgentStore.interrupt.bind(primeAgentStore);
export const getOwnedPrimeAgentFleetAdditions = primeAgentStore.getFleetAdditions.bind(primeAgentStore);
export const getOwnedPrimeAgentRuntimeTail = primeAgentStore.getRuntimeTail.bind(primeAgentStore);
export const getOwnedPrimeAgentReviewPacket = primeAgentStore.getReviewPacket.bind(primeAgentStore);
export const getOwnedPrimeAgentTelemetrySources = primeAgentStore.getTelemetrySources.bind(primeAgentStore);
export const setOwnedPrimeAgentReviewDisposition = primeAgentStore.setReviewDisposition.bind(primeAgentStore);
export const invalidateOwnedPrimeAgentFleetCache = primeAgentStore.invalidateFleetCache.bind(primeAgentStore);
export const archiveOwnedPrimeAgentSession = primeAgentStore.archiveSession.bind(primeAgentStore);
export const ownedPrimeAgentSessionState = primeAgentStore.sessionState.bind(primeAgentStore);
export const sweepOrphanedPrimeAgentSessions = primeAgentStore.sweepOrphanedSessions.bind(primeAgentStore);
