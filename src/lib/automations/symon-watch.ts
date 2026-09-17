/**
 * symon-watch.ts — the Symon-facing facade over o8's durable watch engine.
 *
 * A Symon watch is an ordinary `automations` row with `triggerKind: 'watch'`
 * and one of the two Symon action kinds. Registration, checkpointing, fan-out
 * rate limiting, and deadline handling all belong to the engine in
 * `watch-store.ts` / `fire-store.ts`; this module only adds what Symon needs on
 * top: the `then` body, the spoken delivery, and the park/drain rule that keeps
 * a plan-bodied watch from running while the operator is away.
 *
 * A Symon watch is ONE-SHOT. "Tell me when the checks finish" is answered once;
 * after a delivered report, or a run of its plan body, the row is disabled.
 */
import { eq } from 'drizzle-orm';

import { getDb, getSqlite } from '@/lib/db';
import { automations } from '@/lib/db/schema';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import {
  cancelAutomationFires,
  getAutomationFire,
  type AutomationFire,
  type AutomationWatchActionKind,
} from './fire-store';
import { recordSymonWatchLedgerEvent } from './symon-watch-ledger';
import type { RunAutomationResult } from './runner';

export const SYMON_WATCH_ACTION_KINDS = ['symon_report', 'symon_plan'] as const;
export type SymonWatchActionKind = (typeof SYMON_WATCH_ACTION_KINDS)[number];

export interface SymonWatchPlanStep {
  tool: string;
  args: Record<string, unknown>;
}

export type SymonWatchThen =
  | { kind: 'report'; say: string }
  | { kind: 'plan'; say: string; steps: SymonWatchPlanStep[] };

type AutomationRow = typeof automations.$inferSelect;

export function isSymonWatchActionKind(value: string): value is SymonWatchActionKind {
  return (SYMON_WATCH_ACTION_KINDS as readonly string[]).includes(value);
}

/**
 * Parse a `then` body authored by the model during a live turn. Steps are NOT
 * validated against the tool catalog here — the native plan executor owns that,
 * and re-deriving it in TypeScript would create a second, drifting catalog.
 */
export function parseSymonWatchThen(value: unknown): SymonWatchThen | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'then must be an object' };
  const body = value as Record<string, unknown>;
  const say = typeof body.say === 'string' ? body.say.trim() : '';
  if (!say) return { error: 'then.say is required' };
  if (say.length > 400) return { error: 'then.say must be 400 characters or fewer' };
  if (body.kind === 'report') return { kind: 'report', say };
  if (body.kind !== 'plan') return { error: 'then.kind must be "report" or "plan"' };
  if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 5) {
    return { error: 'then.steps must hold 1 to 5 steps' };
  }
  const steps: SymonWatchPlanStep[] = [];
  for (const raw of body.steps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'each step must be an object' };
    const step = raw as Record<string, unknown>;
    const tool = typeof step.tool === 'string' ? step.tool.trim() : '';
    if (!tool || tool.length > 96) return { error: 'each step needs a tool name' };
    const args = step.args;
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
      return { error: `step ${tool} has invalid args` };
    }
    steps.push({ tool, args: (args as Record<string, unknown>) ?? {} });
  }
  return { kind: 'plan', say, steps };
}

export function symonWatchThen(row: AutomationRow): SymonWatchThen | null {
  if (!row.symonThenJson) return null;
  try {
    const parsed = parseSymonWatchThen(JSON.parse(row.symonThenJson));
    return 'error' in parsed ? null : parsed;
  } catch {
    return null;
  }
}

/** The public shape both the Symon tools and the phone list read. */
export function symonWatchRecord(row: AutomationRow) {
  const then = symonWatchThen(row);
  return {
    id: row.id,
    condition: row.name,
    then: then?.kind ?? null,
    say: then?.say ?? null,
    steps: then?.kind === 'plan' ? then.steps.map((step) => step.tool) : [],
    sessionId: row.symonSessionId,
    sourceKind: row.watchSourceKind,
    sourceId: row.watchSourceId,
    eventTypes: (() => {
      try {
        const parsed = JSON.parse(row.watchEventTypesJson) as unknown;
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
      } catch {
        return [];
      }
    })(),
    repoPath: row.repoPath,
    deadline: row.watchExpiresAt,
    parkedAt: row.symonParkedAt,
    state: !row.enabled
      ? (row.symonParkedAt != null ? 'parked' : 'closed')
      : row.watchExpiresAt != null && row.watchExpiresAt <= Date.now()
        ? 'expired'
        : 'watching',
    lastFireAt: row.watchLastFireAt,
    lastErrorMessage: row.lastErrorMessage,
  };
}

export type SymonWatchRecord = ReturnType<typeof symonWatchRecord>;

function symonWatchRows(where: string, values: unknown[] = []): AutomationRow[] {
  const db = getDb();
  if (!db) return [];
  const ids = getSqlite().prepare(`
    SELECT id FROM automations
    WHERE trigger_kind = 'watch' AND watch_action_kind IN ('symon_report', 'symon_plan') AND ${where}
    ORDER BY created_at ASC
  `).all(...(values as never[])) as Array<{ id: string }>;
  return ids
    .map(({ id }) => db.select().from(automations).where(eq(automations.id, id)).get())
    .filter((row): row is AutomationRow => Boolean(row));
}

export function getSymonWatch(id: string): AutomationRow | null {
  const db = getDb();
  if (!db) return null;
  const row = db.select().from(automations).where(eq(automations.id, id)).get();
  if (!row || row.triggerKind !== 'watch' || !isSymonWatchActionKind(row.watchActionKind)) return null;
  return row;
}

export function listSymonWatches(sessionId?: string | null): SymonWatchRecord[] {
  const rows = sessionId
    ? symonWatchRows('symon_session_id = ?', [sessionId])
    : symonWatchRows('1 = 1');
  return rows.map(symonWatchRecord);
}

/** Clear one watch. Cancelling an already-closed watch is not an error. */
export function cancelSymonWatch(id: string, nowMs: number = Date.now()): SymonWatchRecord | null {
  const row = getSymonWatch(id);
  if (!row) return null;
  const db = getDb();
  if (!db) return null;
  cancelAutomationFires(id, 'Watch cancelled by the operator.', nowMs);
  db.update(automations).set({
    enabled: false,
    symonParkedAt: null,
    symonParkedFireId: null,
    lastErrorMessage: 'Watch cancelled by the operator.',
  }).where(eq(automations.id, id)).run();
  recordSymonWatchLedgerEvent({
    watchId: id,
    phase: 'watch_cancelled',
    redactedSummary: row.name,
    outcome: 'cancelled',
    sessionId: row.symonSessionId,
    nowMs,
  });
  return symonWatchRecord(getSymonWatch(id) ?? row);
}

// ── delivery ────────────────────────────────────────────────────────────────

export interface SymonTaskCompleteFrame {
  taskId: string;
  status: 'done' | 'failed';
  intentText: string;
  resultText: string;
  truncated: boolean;
}

const SPOKEN_LIMIT = 600;

function truncateForSpeech(text: string): { text: string; truncated: boolean } {
  const characters = [...text];
  if (characters.length <= SPOKEN_LIMIT) return { text, truncated: false };
  return { text: `${characters.slice(0, SPOKEN_LIMIT).join('')}…`, truncated: true };
}

/**
 * The spoken body for one fire. `then.say` is model-authored during a live turn
 * and therefore trusted; the observed fact appended after it is the watch's own
 * durable receipt, never the source event's free text.
 */
export function symonWatchReportText(row: AutomationRow, fire: AutomationFire | null): string {
  const then = symonWatchThen(row);
  const say = then?.say ?? row.name;
  const observed = fire?.sourceEventType && fire.sourceEventType !== 'batch'
    ? `${fire.sourceId ?? row.watchSourceId ?? 'the watched source'} reached ${fire.sourceEventType}`
    : `${fire?.sourceId ?? row.watchSourceId ?? 'the watched source'} produced the events you asked about`;
  if (row.watchActionKind === 'symon_plan') {
    return `${say} Watch ${row.id} is ready to run its saved plan — call symon_watch_run with that id `
      + `to see the plan and confirm it. Observed: ${observed}.`;
  }
  return `${say} Observed: ${observed}.`;
}

export function symonWatchFrame(row: AutomationRow, fire: AutomationFire | null): SymonTaskCompleteFrame {
  const spoken = truncateForSpeech(symonWatchReportText(row, fire));
  return {
    taskId: row.id,
    status: 'done',
    intentText: row.name,
    resultText: spoken.text,
    truncated: spoken.truncated,
  };
}

/**
 * Push through the SAME loopback bridge the background brain uses. The reply's
 * `delivered` count is the signal that decides live delivery versus a park.
 */
export async function deliverSymonWatchFrame(frame: SymonTaskCompleteFrame): Promise<number> {
  const { wsPort } = resolvePortInfo();
  try {
    const response = await fetch(`http://127.0.0.1:${wsPort}/symon-task-complete`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getOrCreateWsToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(frame),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return 0;
    const body = await response.json() as { delivered?: number };
    return Number.isFinite(body.delivered) ? Number(body.delivered) : 0;
  } catch {
    return 0;
  }
}

// ── fire, park, drain ───────────────────────────────────────────────────────

function closeWatch(id: string, note: string): void {
  getDb()?.update(automations).set({
    enabled: false,
    symonParkedAt: null,
    symonParkedFireId: null,
    lastErrorMessage: note,
  }).where(eq(automations.id, id)).run();
}

function parkWatch(id: string, fireId: string, nowMs: number): void {
  // Parking disables the row so the shared materializer cannot fan out a second
  // fire while this one is still waiting for the phone.
  getDb()?.update(automations).set({
    enabled: false,
    symonParkedAt: nowMs,
    symonParkedFireId: fireId,
    lastErrorMessage: 'Waiting for the phone to reconnect.',
  }).where(eq(automations.id, id)).run();
}

/** The `symon_report` / `symon_plan` branch of the watch action dispatcher. */
export async function runSymonWatchAction(
  row: AutomationRow,
  fire: AutomationFire,
  nowMs: number = Date.now(),
): Promise<RunAutomationResult> {
  const frame = symonWatchFrame(row, fire);
  const delivered = await deliverSymonWatchFrame(frame);
  if (delivered > 0) {
    // A report is complete on delivery. A plan body still needs its confirm
    // card, but the model now holds the watch id and asks for it in this turn.
    if (row.watchActionKind === 'symon_report') closeWatch(row.id, 'Watch reported to the operator.');
    else parkWatch(row.id, fire.id, nowMs);
    recordSymonWatchLedgerEvent({
      watchId: row.id,
      phase: 'watch_fired',
      redactedSummary: row.name,
      outcome: 'delivered',
      sessionId: row.symonSessionId,
      nowMs,
    });
    return { ok: true, note: `Watch reported to ${delivered} live Symon session(s).` };
  }
  parkWatch(row.id, fire.id, nowMs);
  recordSymonWatchLedgerEvent({
    watchId: row.id,
    phase: 'watch_parked',
    redactedSummary: row.name,
    outcome: 'parked',
    sessionId: row.symonSessionId,
    nowMs,
  });
  return { ok: true, note: 'No live Symon session; the watch is parked until the phone reconnects.' };
}

/**
 * Re-push every parked watch. Called when a Symon session registers and once a
 * tick as a safety net. A parked watch ignores its deadline: the operator asked
 * the question and the answer is still owed.
 */
export async function drainParkedSymonWatches(nowMs: number = Date.now()): Promise<AutomationFire[]> {
  const parked = symonWatchRows('symon_parked_at IS NOT NULL');
  const drained: AutomationFire[] = [];
  for (const row of parked) {
    const fire = row.symonParkedFireId ? getAutomationFire(row.symonParkedFireId) ?? null : null;
    const delivered = await deliverSymonWatchFrame(symonWatchFrame(row, fire));
    if (delivered === 0) continue;
    if (row.watchActionKind === 'symon_report') {
      closeWatch(row.id, 'Watch reported to the operator.');
    } else {
      // The plan body stays parked until symon_watch_run settles it; only the
      // "your plan is waiting" nudge has been delivered.
      getDb()?.update(automations).set({
        lastErrorMessage: 'Plan is waiting for the operator to confirm it.',
      }).where(eq(automations.id, row.id)).run();
    }
    recordSymonWatchLedgerEvent({
      watchId: row.id,
      phase: 'watch_drained',
      redactedSummary: row.name,
      outcome: 'delivered',
      sessionId: row.symonSessionId,
      nowMs,
    });
    if (fire) drained.push(fire);
  }
  return drained;
}

/**
 * Expire symon watches past their deadline WITH a ledger entry, then let the
 * shared materializer run. Order matters: the shared engine also disables an
 * expired row, but it cannot reach Symon's ledger.
 */
export async function materializeSymonWatchFires(nowMs: number = Date.now()): Promise<AutomationFire[]> {
  const expiring = symonWatchRows(
    'enabled = 1 AND symon_parked_at IS NULL AND watch_expires_at IS NOT NULL AND watch_expires_at <= ?',
    [nowMs],
  );
  for (const row of expiring) {
    cancelAutomationFires(row.id, 'Watch expired.', nowMs);
    closeWatch(row.id, 'Watch expired.');
    recordSymonWatchLedgerEvent({
      watchId: row.id,
      phase: 'watch_expired',
      redactedSummary: row.name,
      outcome: 'expired',
      sessionId: row.symonSessionId,
      nowMs,
    });
  }
  return drainParkedSymonWatches(nowMs);
}

// ── symon_watch_run ─────────────────────────────────────────────────────────

/** The plan body the native executor runs. Only a parked plan watch has one. */
export function claimSymonWatchPlanBody(id: string): { ok: true; steps: SymonWatchPlanStep[]; condition: string }
  | { ok: false; error: string } {
  const row = getSymonWatch(id);
  if (!row) return { ok: false, error: 'unknown watch' };
  if (row.watchActionKind !== 'symon_plan') return { ok: false, error: 'this watch reports, it has no plan to run' };
  if (row.symonParkedAt == null) return { ok: false, error: 'this watch has not fired yet' };
  const then = symonWatchThen(row);
  if (!then || then.kind !== 'plan') return { ok: false, error: 'the saved plan body is unreadable' };
  return { ok: true, steps: then.steps, condition: row.name };
}

/** Record how the native confirm card resolved and close the watch either way. */
export function settleSymonWatchRun(
  id: string,
  outcome: 'approved' | 'denied' | 'failed',
  detail: string = '',
  nowMs: number = Date.now(),
): SymonWatchRecord | null {
  const row = getSymonWatch(id);
  if (!row) return null;
  closeWatch(id, outcome === 'approved'
    ? 'Watch plan ran after the operator confirmed it.'
    : outcome === 'denied'
      ? 'Watch plan was declined by the operator.'
      : `Watch plan failed: ${detail || 'no detail'}`);
  recordSymonWatchLedgerEvent({
    watchId: id,
    phase: 'watch_ran',
    redactedSummary: row.name,
    outcome,
    sessionId: row.symonSessionId,
    nowMs,
  });
  return symonWatchRecord(getSymonWatch(id) ?? row);
}

export function recordSymonWatchRegistered(row: AutomationRow, nowMs: number = Date.now()): void {
  recordSymonWatchLedgerEvent({
    watchId: row.id,
    phase: 'watch_registered',
    redactedSummary: row.name,
    outcome: 'watching',
    sessionId: row.symonSessionId,
    nowMs,
  });
}

export type { AutomationWatchActionKind };
