/**
 * Event triage before an orchestrator wake (#2467, program #2481). RECORD-ONLY.
 *
 * At each wake chokepoint (review continuation, supervisor escalation, the
 * layer-2 post-rebase verification escalation), and only when
 * `judgment.provider` is on, ask one locked choice question: does this event
 * need handling in place, a queued turn, or a wake now? The state is
 * o8-computed facts read synchronously at the hook: the lane's latest event
 * verb and its age, lane status, retry count, completed attempts, the latest
 * approval's gate result and stored referee answers, and whether an operator
 * decision is pending. No message text, title, brief, or worker-written text.
 *
 * The call runs detached with one bounded attempt; the wake runs unchanged in
 * the same order with the same message. When the call settles, a
 * `wake_triage` lane event records the answer and the receipt id. Nothing
 * reads it; the replay label `wakeTriage` scores it. With the setting off the
 * hook returns before any read: no git, no database read, no network.
 */
import { createHash } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { WAKE_TRIAGE_QUESTION } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';

export const WAKE_TRIAGE_SURFACE = 'orchestrator-wake-triage';

export type WakeTriageSource = 'review-continuation' | 'supervisor-escalation' | 'typecheck-escalation';
export type WakeTriageChoice = keyof typeof WAKE_TRIAGE_QUESTION.criteria;

const QUESTIONS = { wakeTriage: WAKE_TRIAGE_QUESTION } as const;
/** One bounded attempt: nothing waits on it, and it must not pile up behind a slow provider. */
const PRODUCTION_TRANSPORT: AskJudgmentOptions = { timeoutMs: 8_000, maxAttempts: 1 };

export interface WakeTriageState {
  event: { verb: string | null; ageMs: number | null };
  lane: { status: string; retryCount: number; attempts: number };
  gate: { passed: boolean; failedChecks: string[] } | null;
  referee: { docsOnly: number | null; risk: number | null } | null;
  operatorWaiting: boolean;
  source: WakeTriageSource;
}

/** Payload of the `wake_triage` lane event. */
export interface WakeTriageRecord {
  receiptId: string | null;
  source: WakeTriageSource;
  choice: WakeTriageChoice;
  probabilities: Record<WakeTriageChoice, number>;
  confidence: number;
  /** Confidence under ABSTAIN_CONFIDENCE. PROVISIONAL band; nothing reads it. */
  abstain: boolean;
  /** sha256 of the state as sent. */
  factsHash: string;
}

export interface WakeTriageInput {
  source: WakeTriageSource;
  laneId?: string | null;
  /** Supervisor escalations carry no lane id; the session id they name resolves the lane. */
  sessionKey?: string | null;
}

let transportOverride: AskJudgmentOptions | undefined;
const inFlight = new Map<string, Promise<WakeTriageRecord | null>>();

/** Test-only: point the triage at a local endpoint fixture. */
export function setWakeTriageTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/** Resolves when the triage started for this lane has settled; null when none ran or the call failed. */
export async function waitForWakeTriage(laneId: string): Promise<WakeTriageRecord | null> {
  return (await inFlight.get(laneId)) ?? null;
}

const parseJson = (raw: string | null | undefined): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const numberAt = (value: unknown, key: string): number | null => {
  const inner = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof inner === 'number' ? inner : null;
};

interface LaneRow { id: string; status: string; packet_id: string | null; session_key: string | null }

function resolveLane(input: WakeTriageInput): LaneRow | null {
  const db = getSqlite();
  if (input.laneId) {
    return (db.prepare('SELECT id, status, packet_id, session_key FROM lanes WHERE id = ?').get(input.laneId) as LaneRow | undefined) ?? null;
  }
  if (input.sessionKey) {
    return (db.prepare(`
      SELECT id, status, packet_id, session_key FROM lanes
      WHERE session_key = ? AND status NOT IN ('archived', 'completed')
      ORDER BY updated_at DESC LIMIT 1
    `).get(input.sessionKey) as LaneRow | undefined) ?? null;
  }
  return null;
}

/** The state sent to the provider, read at the hook. Exported for the state-shape tests. */
export function buildWakeTriageState(lane: LaneRow, source: WakeTriageSource, now = Date.now()): WakeTriageState {
  const db = getSqlite();
  const latest = db.prepare(`
    SELECT verb, timestamp FROM lane_events WHERE lane_id = ? AND verb NOT IN ('judgment', 'wake_triage')
    ORDER BY rowid DESC LIMIT 1
  `).get(lane.id) as { verb: string; timestamp: string } | undefined;
  const latestAt = latest ? Date.parse(latest.timestamp) : Number.NaN;
  const retryCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM lane_events WHERE lane_id = ? AND verb = 'typecheck_auto_retry'
      AND rowid > COALESCE((SELECT MAX(rowid) FROM lane_events WHERE lane_id = ? AND verb = 'status_change'
        AND json_extract(payload_json, '$.status') = 'launching'), 0)
  `).get(lane.id, lane.id) as { n: number }).n;
  const attempts = lane.packet_id
    ? (db.prepare('SELECT COUNT(*) AS n FROM session_outcomes WHERE packet_id = ?').get(lane.packet_id) as { n: number }).n
    : 0;
  const approval = db.prepare(`
    SELECT gate_result_json, metadata_json FROM approvals
    WHERE lane_id = ? OR (? IS NOT NULL AND packet_id = ?)
    ORDER BY created_at DESC, rowid DESC LIMIT 1
  `).get(lane.id, lane.packet_id, lane.packet_id) as { gate_result_json: string | null; metadata_json: string | null } | undefined;
  const gateJson = parseJson(approval?.gate_result_json);
  const violations = Array.isArray(gateJson?.violations) ? gateJson.violations as Array<Record<string, unknown>> : [];
  const referee = parseJson(approval?.metadata_json)?.referee as { answers?: Record<string, unknown> } | undefined;
  const pending = db.prepare(`
    SELECT 1 AS ok FROM approvals WHERE status = 'pending' AND (lane_id = ? OR (? IS NOT NULL AND packet_id = ?)) LIMIT 1
  `).get(lane.id, lane.packet_id, lane.packet_id);
  return {
    event: { verb: latest?.verb ?? null, ageMs: Number.isFinite(latestAt) ? Math.max(0, now - latestAt) : null },
    lane: { status: lane.status, retryCount, attempts },
    // Categories of blocking violations only: the labels and details are free text.
    gate: gateJson && typeof gateJson.passed === 'boolean'
      ? {
        passed: gateJson.passed,
        failedChecks: violations
          .filter((violation) => violation.severity === 'block' && typeof violation.category === 'string')
          .map((violation) => violation.category as string)
          .sort(),
      }
      : null,
    referee: referee?.answers
      ? { docsOnly: numberAt(referee.answers.docsOnly, 'noul'), risk: numberAt(referee.answers.risk, 'score') }
      : null,
    operatorWaiting: Boolean(pending),
    source,
  };
}

async function runWakeTriage(lane: LaneRow, state: WakeTriageState): Promise<WakeTriageRecord | null> {
  const result = await askJudgment({
    state,
    questions: QUESTIONS,
    context: { laneId: lane.id, packetId: lane.packet_id, surface: WAKE_TRIAGE_SURFACE },
  }, transportOverride ?? PRODUCTION_TRANSPORT);
  const answer = result?.answers.wakeTriage;
  if (!result || !answer) return null;
  const record: WakeTriageRecord = {
    receiptId: result.receiptId,
    source: state.source,
    choice: answer.choice,
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    abstain: answer.abstain,
    factsHash: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
  };
  const { recordLaneEvent } = await import('@/lib/lane/events');
  recordLaneEvent(lane.id, 'wake_triage', 'system', { ...record });
  return record;
}

/**
 * Start the triage for a wake that is about to happen. Returns immediately
 * and never throws. No-op (no read, no network) when the setting is off.
 */
export function startWakeTriage(input: WakeTriageInput): void {
  let lane: LaneRow | null;
  let state: WakeTriageState;
  try {
    if (!isJudgmentRefereeEnabled()) return;
    lane = resolveLane(input);
    if (!lane) return;
    state = buildWakeTriageState(lane, input.source);
  } catch (error) {
    console.warn(`[${WAKE_TRIAGE_SURFACE}] skipped:`, error instanceof Error ? error.message : 'error');
    return;
  }
  const laneId = lane.id;
  const promise = runWakeTriage(lane, state)
    .catch((error) => {
      console.warn(`[${WAKE_TRIAGE_SURFACE}] skipped:`, error instanceof Error ? error.message : 'error');
      return null;
    })
    .finally(() => {
      if (inFlight.get(laneId) === promise) inFlight.delete(laneId);
    });
  inFlight.set(laneId, promise);
}

/** The session id a supervisor escalation names: `Agent "<name>" (<session id>)`. Only the id is read. */
export function escalationSessionKey(message: string): string | null {
  return /^\[SUPERVISOR\] Agent ".*?" \(([^()\s]+)\)/.exec(message)?.[1] ?? null;
}
