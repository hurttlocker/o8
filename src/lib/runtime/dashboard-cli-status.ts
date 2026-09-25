import { open } from 'node:fs/promises';
import type { RuntimeSession } from '@/lib/runtimes/types';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { unknownTerminalStatusEvidence, type TerminalStatusEvidence } from '@/lib/terminal-status/resolve';

const MAX_ROLLOUT_TAIL_BYTES = 256 * 1024;
const ACTIVE_TURN_FRESHNESS_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 30_000;

type RolloutPathResolver = (sessionKey: string, identityId?: string) => Promise<string | null>;

interface ReadOptions {
  resolveRolloutPath?: RolloutPathResolver;
  now?: Date;
}

function unknown(session: RuntimeSession, reason: string, observedAt?: string): TerminalStatusEvidence {
  return unknownTerminalStatusEvidence({
    sessionId: session.sessionKey,
    runtime: 'codex',
    observedAt,
    summary: 'The live CLI process is verified, but its current turn state is unknown.',
    fallbackReason: reason,
  });
}

async function readBoundedRolloutTail(filePath: string): Promise<string | null> {
  const file = await open(filePath, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 0) return null;
    const start = Math.max(0, size - MAX_ROLLOUT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) return null;
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (!text.endsWith('\n')) return null;
    const firstCompleteLine = start === 0 ? 0 : text.indexOf('\n') + 1;
    if (start > 0 && firstCompleteLine === 0) return null;
    const lastCompleteLine = text.lastIndexOf('\n');
    if (lastCompleteLine < firstCompleteLine) return null;
    return text.slice(firstCompleteLine, lastCompleteLine);
  } finally {
    await file.close();
  }
}

function eventTimestamp(value: unknown, nowMs: number): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs + CLOCK_SKEW_MS
    ? new Date(timestamp).toISOString()
    : null;
}

/** Read only lifecycle metadata from the verified thread's durable rollout. */
export async function readCodexDashboardTurnEvidence(
  session: RuntimeSession,
  options: ReadOptions = {},
): Promise<TerminalStatusEvidence> {
  const nowMs = options.now?.getTime() ?? Date.now();
  if (session.runtimeId !== 'codex' || session.ownership !== 'discovered' || session.status !== 'running') {
    return unknown(session, 'This session is not a verified live discovered Codex CLI.');
  }
  const rolloutPath = await (options.resolveRolloutPath ?? getCodexRolloutPath)(
    session.sessionKey,
    session.identityId,
  ).catch(() => null);
  if (!rolloutPath) return unknown(session, 'The matched thread has no validated rollout path.');

  let tail: string | null;
  try {
    tail = await readBoundedRolloutTail(rolloutPath);
  } catch {
    return unknown(session, 'The matched thread rollout could not be read.');
  }
  if (!tail) return unknown(session, 'No complete structured lifecycle event was available in the bounded rollout tail.');

  let turn: { state: 'working' | 'complete'; startedAt?: string; observedAt: string; latestEvent: string } | null = null;
  let unknownBoundary: string | null = null;
  for (const line of tail.split('\n')) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid row');
      record = parsed as Record<string, unknown>;
    } catch {
      return unknown(session, 'The bounded rollout tail contains a malformed structured event.');
    }
    const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? record.payload as Record<string, unknown>
      : null;
    const eventType = record.type === 'event_msg' && typeof payload?.type === 'string'
      ? payload.type
      : null;
    if (eventType === 'task_started' || eventType === 'task_complete') {
      const observedAt = eventTimestamp(record.timestamp, nowMs);
      if (!observedAt) return unknown(session, 'A structured turn boundary has an invalid observation time.');
      turn = eventType === 'task_started'
        ? { state: 'working', startedAt: observedAt, observedAt, latestEvent: eventType }
        : { state: 'complete', observedAt, latestEvent: eventType };
      unknownBoundary = null;
    } else if (eventType && /^(?:task|turn)_/.test(eventType)) {
      turn = null;
      unknownBoundary = eventType;
    } else if (turn?.state === 'working' && (
      record.type === 'response_item'
      || eventType === 'item_completed'
      || eventType === 'token_count'
    )) {
      const observedAt = eventTimestamp(record.timestamp, nowMs);
      if (observedAt && observedAt > turn.observedAt) {
        turn.observedAt = observedAt;
        turn.latestEvent = record.type === 'response_item' ? 'response_item' : eventType!;
      }
    }
  }

  if (!turn) return unknown(session, unknownBoundary
    ? `The latest lifecycle boundary (${unknownBoundary}) is not recognized by this status reader.`
    : 'No recognized turn boundary was available in the bounded rollout tail.');
  if (turn.state === 'working' && nowMs - Date.parse(turn.observedAt) > ACTIVE_TURN_FRESHNESS_MS) {
    return unknown(session, 'The active-turn event is stale; process liveness alone cannot confirm current work.', turn.observedAt);
  }
  return {
    sessionId: session.sessionKey,
    runtime: 'codex',
    state: turn.state,
    authority: 'runtime-event',
    observedAt: turn.observedAt,
    summary: turn.state === 'working'
      ? 'Codex structured events show a turn with recent activity.'
      : 'Codex structured events show the last turn completed.',
    evidence: [
      { source: 'codex-rollout.lifecycle', value: turn.state === 'working' ? 'task_started' : 'task_complete' },
      ...(turn.startedAt ? [{ source: 'codex-rollout.started-at', value: turn.startedAt }] : []),
      ...(turn.latestEvent !== 'task_started' && turn.latestEvent !== 'task_complete'
        ? [{ source: 'codex-rollout.latest-event', value: turn.latestEvent }]
        : []),
    ],
  };
}

/** Only exact process/TTY bindings are eligible for a structured status read. */
export async function readDashboardCliTurnEvidence(
  discovered: Array<{ session: RuntimeSession }>,
  bindings: Map<string, string>,
): Promise<Map<string, TerminalStatusEvidence>> {
  const eligible = discovered.filter(({ session }) => (
    bindings.has(session.sessionKey)
    && session.runtimeId === 'codex'
    && session.ownership === 'discovered'
  ));
  return new Map(await Promise.all(eligible.map(async ({ session }) => ([
    session.sessionKey,
    await readCodexDashboardTurnEvidence(session),
  ] as const))));
}
