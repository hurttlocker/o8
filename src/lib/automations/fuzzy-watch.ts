/**
 * Fuzzy Symon watches (#2443, program #2481). ADVISORY, PROVISIONAL band.
 *
 * A fuzzy watch carries an operator-authored condition ("tell me when that PR
 * looks ready") instead of an exact event. On each scheduler tick, and only
 * when `judgment.provider` is on, the referee is asked one yes/no question over
 * the condition text and the watched source's o8-computed facts. The answer
 * moves a streak; when the streak reaches the band's tick count the watch fires
 * through the same fire row and Symon action an exact watch uses.
 *
 * The state carries no packet title, PR title or body, worker summary, or
 * report: the condition is the one piece of free text, because it is the
 * question's object. Every call writes a judgment receipt, and every answered
 * call is recorded on the watch's ledger with its receipt id. A failed or
 * skipped call changes nothing. A watch fires at most once: once it has a fire
 * row, the pass neither asks nor fires for it again, whether or not that fire
 * has run yet.
 *
 * Setting off: the tick returns before any database read, git, or network, and
 * the creation route refuses fuzzy watches, so none can exist.
 */
import { getSqlite } from '@/lib/db';
import { askJudgment, type AskJudgmentOptions } from '@/lib/judgment/client';
import { FUZZY_WATCH_BAND, FUZZY_WATCH_QUESTION } from '@/lib/judgment/questions';
import { isJudgmentRefereeEnabled } from '@/lib/judgment/route';
import { normalizeForJudgment } from '@/lib/judgment/text-scan';
import { persistWatchAutomationFire, type AutomationFire } from './fire-store';
import { ingestLaneAutomationSourceEvents, type AutomationSourceKind } from './source-events';
import { recordSymonWatchLedgerEvent } from './symon-watch-ledger';

export const FUZZY_WATCH_SURFACE = 'fuzzy-watch';

/** Maximum condition length, after normalization. */
export const FUZZY_CONDITION_MAX_CHARS = 400;

export const FUZZY_WATCH_REFUSAL = 'Fuzzy watches need the judgment referee on.';

export interface FuzzyWatchEvaluation {
  lastP: number;
  /** Epoch ms of the answered call. */
  lastAt: number;
  /** Consecutive ticks at or above the fire band. */
  streak: number;
  receiptId: string | null;
}

/** The row fields a fuzzy evaluation reads. */
export interface FuzzyWatchRow {
  id: string;
  name: string;
  repo_path: string;
  watch_source_kind: AutomationSourceKind;
  watch_source_id: string | null;
  symon_session_id: string | null;
  symon_fuzzy_condition: string;
  symon_fuzzy_evaluation_json: string | null;
}

/** The observable's facts. Every field is computed or stored by o8. */
export interface FuzzyWatchFacts {
  sourceKind: AutomationSourceKind;
  sourceId: string | null;
  lane: {
    status: string;
    outcome: string | null;
    ageMs: number | null;
    pullRequest: {
      number: number;
      state: string;
      merged: boolean;
      reviewDecision: string | null;
      checks: Array<{ status: string | null; conclusion: string | null }>;
    } | null;
  } | null;
  recentEvents: Array<{ type: string; ageMs: number }>;
}

/** Normalize and bound an operator-authored condition. Null when empty or too long. */
export function sanitizeFuzzyCondition(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const normalized = normalizeForJudgment(text).trim();
  if (!normalized || normalized.length > FUZZY_CONDITION_MAX_CHARS) return null;
  return normalized;
}

export function parseFuzzyWatchEvaluation(json: string | null | undefined): FuzzyWatchEvaluation | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<FuzzyWatchEvaluation>;
    if (typeof parsed.lastP !== 'number' || typeof parsed.lastAt !== 'number' || typeof parsed.streak !== 'number') return null;
    return {
      lastP: parsed.lastP,
      lastAt: parsed.lastAt,
      streak: parsed.streak,
      receiptId: typeof parsed.receiptId === 'string' ? parsed.receiptId : null,
    };
  } catch {
    return null;
  }
}

/** The PROVISIONAL two-tick rule: fire band extends the streak, reset band clears it, between holds it. */
export function nextFuzzyStreak(previous: number, p: number): number {
  if (p >= FUZZY_WATCH_BAND.fireAt) return previous + 1;
  if (p <= FUZZY_WATCH_BAND.resetAt) return 0;
  return previous;
}

const RECENT_EVENT_LIMIT = 8;

function isoAgeMs(value: string | null | undefined, nowMs: number): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

/** Read the watched source's current facts, plus the lane id when the source is a packet with a lane. */
export function fuzzyWatchFacts(row: FuzzyWatchRow, nowMs: number): { facts: FuzzyWatchFacts; laneId: string | null } {
  const sqlite = getSqlite();
  let lane: FuzzyWatchFacts['lane'] = null;
  let laneId: string | null = null;
  if (row.watch_source_kind === 'packet' && row.watch_source_id) {
    const laneRow = sqlite.prepare(`
      SELECT id, status, outcome, pr_number, branch, updated_at FROM lanes
      WHERE packet_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(row.watch_source_id) as {
      id: string; status: string; outcome: string | null; pr_number: number | null; branch: string; updated_at: string;
    } | undefined;
    if (laneRow) {
      laneId = laneRow.id;
      let pullRequest: NonNullable<FuzzyWatchFacts['lane']>['pullRequest'] = null;
      if (laneRow.pr_number != null) {
        const pr = sqlite.prepare(`
          SELECT number, state, merged_at, review_decision, status_checks_json FROM github_pull_requests
          WHERE number = ? AND head_ref_name = ? ORDER BY updated_at DESC LIMIT 1
        `).get(laneRow.pr_number, laneRow.branch) as {
          number: number; state: string; merged_at: string | null; review_decision: string | null; status_checks_json: string;
        } | undefined;
        if (pr) {
          let checks: Array<{ status: string | null; conclusion: string | null }> = [];
          try {
            const parsed = JSON.parse(pr.status_checks_json) as Array<{ status?: unknown; conclusion?: unknown }>;
            if (Array.isArray(parsed)) {
              checks = parsed.map((check) => ({
                status: typeof check?.status === 'string' ? check.status : null,
                conclusion: typeof check?.conclusion === 'string' ? check.conclusion : null,
              }));
            }
          } catch { /* unreadable checks read as none */ }
          pullRequest = {
            number: pr.number,
            state: pr.state,
            merged: pr.merged_at != null,
            reviewDecision: pr.review_decision,
            checks,
          };
        }
      }
      lane = {
        status: laneRow.status,
        outcome: laneRow.outcome,
        ageMs: isoAgeMs(laneRow.updated_at, nowMs),
        pullRequest,
      };
    }
  }
  const clauses = ['source_kind = ?'];
  const values: string[] = [row.watch_source_kind];
  if (row.repo_path) { clauses.push('repo_path = ?'); values.push(row.repo_path); }
  if (row.watch_source_id) { clauses.push('source_id = ?'); values.push(row.watch_source_id); }
  const events = (sqlite.prepare(`
    SELECT event_type, occurred_at FROM automation_source_events
    WHERE ${clauses.join(' AND ')} ORDER BY sequence DESC LIMIT ${RECENT_EVENT_LIMIT}
  `).all(...values) as Array<{ event_type: string; occurred_at: number }>).reverse();
  return {
    laneId,
    facts: {
      sourceKind: row.watch_source_kind,
      sourceId: row.watch_source_id,
      lane,
      recentEvents: events.map((event) => ({ type: event.event_type, ageMs: Math.max(0, nowMs - event.occurred_at) })),
    },
  };
}

/** One bounded attempt: the tick waits on this call. */
const FUZZY_TRANSPORT: AskJudgmentOptions = { timeoutMs: 5_000, maxAttempts: 1 };

let transportOverride: AskJudgmentOptions | undefined;

/** Test-only: point evaluations at a local endpoint fixture. */
export function setFuzzyWatchTransportForTests(options: AskJudgmentOptions | undefined): void {
  transportOverride = options;
}

/**
 * Ask the condition once, record the evaluation on the row and the ledger, and
 * persist a fire when the streak reaches the band. Returns the fire or null.
 */
export async function evaluateFuzzyWatch(
  watch: FuzzyWatchRow,
  facts: FuzzyWatchFacts,
  laneId: string | null,
  nowMs: number,
): Promise<AutomationFire | null> {
  const result = await askJudgment({
    state: { condition: watch.symon_fuzzy_condition, facts },
    questions: { conditionMet: FUZZY_WATCH_QUESTION },
    context: {
      surface: FUZZY_WATCH_SURFACE,
      packetId: watch.watch_source_kind === 'packet' ? watch.watch_source_id : null,
      laneId,
      selection: { watchId: watch.id },
    },
  }, { ...FUZZY_TRANSPORT, ...transportOverride });
  const p = result?.answers.conditionMet.noul;
  if (!result || typeof p !== 'number') return null;

  const previous = parseFuzzyWatchEvaluation(watch.symon_fuzzy_evaluation_json);
  const streak = nextFuzzyStreak(previous?.streak ?? 0, p);
  const met = streak >= FUZZY_WATCH_BAND.ticks;
  const evaluation: FuzzyWatchEvaluation = { lastP: p, lastAt: nowMs, streak, receiptId: result.receiptId };
  const sqlite = getSqlite();
  sqlite.prepare(`
    UPDATE automations SET symon_fuzzy_evaluation_json = ?, updated_at = datetime('now')
    WHERE id = ? AND enabled = 1
  `).run(JSON.stringify(evaluation), watch.id);
  recordSymonWatchLedgerEvent({
    watchId: watch.id,
    phase: 'watch_evaluated',
    redactedSummary: `p=${p.toFixed(3)} streak=${streak} receipt=${result.receiptId ?? 'none'}`,
    outcome: met ? 'condition_met' : 'watching',
    sessionId: watch.symon_session_id,
    nowMs,
  });
  if (!met) return null;

  const fingerprint = `fuzzy-watch:${watch.id}:${result.receiptId ?? nowMs}`;
  const fire = sqlite.transaction(() => {
    // The pass owns its one-shot guard: the fire row is the marker, checked and
    // written in one transaction. Disabling or parking the row here would not
    // work: the Symon action skips a disabled, unparked row as settled, and
    // the drain would announce a parked one a second time.
    if (sqlite.prepare('SELECT 1 FROM automation_fires WHERE automation_id = ? LIMIT 1').get(watch.id)) return undefined;
    return persistWatchAutomationFire(watch.id, {
      sequence: 0,
      sourceKind: watch.watch_source_kind,
      sourceId: watch.watch_source_id ?? watch.id,
      repoPath: watch.repo_path || null,
      eventType: 'condition_met',
      fingerprint,
      payload: { p, streak, receiptId: result.receiptId },
      occurredAt: nowMs,
      persistedAt: nowMs,
    }, nowMs);
  }).immediate();
  if (fire) {
    sqlite.prepare(`
      UPDATE automations SET watch_last_fire_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(nowMs, watch.id);
  }
  return fire ?? null;
}

const inFlight = new Set<string>();

/**
 * The scheduler-tick pass: evaluate every live fuzzy watch once. Returns the
 * fires it persisted so the tick claims and runs them like any other.
 */
export async function evaluateFuzzyWatches(nowMs: number = Date.now()): Promise<AutomationFire[]> {
  if (!isJudgmentRefereeEnabled()) return [];
  const rows = getSqlite().prepare(`
    SELECT id, name, repo_path, watch_source_kind, watch_source_id, symon_session_id,
           symon_fuzzy_condition, symon_fuzzy_evaluation_json
    FROM automations
    WHERE enabled = 1 AND trigger_kind = 'watch' AND symon_fuzzy_condition IS NOT NULL
      AND watch_source_kind IS NOT NULL
      AND (watch_expires_at IS NULL OR watch_expires_at > ?)
      -- A Symon watch is one-shot, so a fire row means it has fired. The row
      -- stays enabled until the Symon action runs, which can be ticks later.
      AND NOT EXISTS (SELECT 1 FROM automation_fires f WHERE f.automation_id = automations.id)
    ORDER BY created_at ASC, rowid ASC
  `).all(nowMs) as FuzzyWatchRow[];
  if (rows.length === 0) return [];
  ingestLaneAutomationSourceEvents(1_000, nowMs);
  const due = rows.filter((row) => !inFlight.has(row.id));
  const settled = await Promise.all(due.map(async (row) => {
    inFlight.add(row.id);
    try {
      const { facts, laneId } = fuzzyWatchFacts(row, nowMs);
      return await evaluateFuzzyWatch(row, facts, laneId, nowMs);
    } catch (error) {
      console.warn('[fuzzy-watch] evaluation skipped:', error instanceof Error ? error.message : 'error');
      return null;
    } finally {
      inFlight.delete(row.id);
    }
  }));
  return settled.filter((fire): fire is AutomationFire => Boolean(fire));
}
