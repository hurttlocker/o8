/**
 * The `claimUnbacked` label for the calibration replay (#2447, #2438).
 *
 * Rows are the recorded report-claim answers. Every call carries a laneId, so
 * its receipt is a `judgment` lane event with surface `report-claim-check`
 * (payload: packetId, receiptId, answers); the `claim_unbacked` event is
 * written only when a claim looked unbacked, so it is not the row source.
 * Two predictors are scored separately: p = the recorded `claimsTestsRun`
 * answer, and p = the recorded `claimsFilesNotInDiff` answer.
 *
 * Ground truth, from stored data with no human labels, on any lane of the
 * same packet (a rerun retires the lane and launches a new one):
 * - positive (1): after the report's receipt event (by lane_events rowid),
 *   the packet was rerun: a lane event with verb `rerun_with_feedback`,
 *   `typecheck_auto_retry` or `session_launched`, or a `status_change` whose
 *   eventLabel is `typecheck_auto_retry` or `session_launched`; or an
 *   approval for the packet was rejected by `desktop` or `mobile` with
 *   resolved_at after the receipt.
 * - negative (0): neither, and the packet merged: a `status_change` with
 *   eventLabel `merged` or `merged_pushed`, or an outcome row with
 *   merged_clean not null.
 * - otherwise unlabeled and left out.
 * Reads the database read-only; sends nothing.
 */

export const CLAIM_CHECK_SURFACE = 'report-claim-check';
export const CLAIM_PREDICTORS = ['claimsTestsRun', 'claimsFilesNotInDiff'];

const RERUN_VERBS = new Set(['rerun_with_feedback', 'typecheck_auto_retry', 'session_launched']);
const RERUN_LABELS = new Set(['typecheck_auto_retry', 'session_launched']);
const MERGE_LABELS = new Set(['merged', 'merged_pushed']);
const OPERATOR_ACTORS = new Set(['desktop', 'mobile']);

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

/**
 * What happened to a packet after one lane event: `{ rerun, rejected, merged }`.
 * Shared with the directiveCitation label. `history` is
 * `{ events, lanes, approvals, outcomes }` as loaded below.
 */
export function packetOutcomeIndex({ events, lanes, approvals, outcomes }) {
  const packetByLane = new Map(lanes.map((lane) => [lane.id, lane.packet_id]));
  const packetOf = (event) => parseJson(event.payload_json)?.packetId || packetByLane.get(event.lane_id) || null;
  const reruns = new Map();
  const merges = new Set(outcomes.filter((row) => row.merged_clean !== null && row.merged_clean !== undefined).map((row) => row.packet_id));
  const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const event of events) {
    const packet = packetByLane.get(event.lane_id) || parseJson(event.payload_json)?.packetId;
    if (!packet) continue;
    const label = event.verb === 'status_change' ? parseJson(event.payload_json)?.eventLabel : null;
    if (RERUN_VERBS.has(event.verb) || RERUN_LABELS.has(label)) push(reruns, packet, event.seq);
    if (MERGE_LABELS.has(label)) merges.add(packet);
  }
  const rejections = new Map();
  for (const approval of approvals) {
    const resolution = parseJson(approval.resolution_json);
    if (!approval.packet_id || !OPERATOR_ACTORS.has(resolution?.actor)) continue;
    if (approval.status !== 'rejected' && resolution?.action !== 'rejected') continue;
    push(rejections, approval.packet_id, toMs(approval.resolved_at));
  }
  return {
    packetOf,
    after(packet, event) {
      const at = toMs(event.timestamp);
      return {
        rerun: (reruns.get(packet) ?? []).some((seq) => seq > event.seq),
        rejected: (rejections.get(packet) ?? []).some((ms) => Number.isFinite(ms) && ms >= at),
        merged: merges.has(packet),
      };
    },
  };
}

/** 1 when rerun or rejected after the event, 0 when merged without either, else null. */
export const outcomeLabel = ({ rerun, rejected, merged }) => (rerun || rejected ? 1 : merged ? 0 : null);

/**
 * Rows `{ predictor, p, y, packet, laneId, receiptId }`, two per labeled
 * report (one per predictor). `packet` is the packet id (one fold per packet).
 */
export function labelClaimUnbacked(history) {
  const index = packetOutcomeIndex(history);
  const rows = [];
  const notes = { receiptsRead: 0, failedCalls: 0, unlabeled: 0, rerun: 0, rejected: 0, merged: 0 };
  for (const event of history.events) {
    if (event.verb !== 'judgment') continue;
    const payload = parseJson(event.payload_json);
    if (payload?.surface !== CLAIM_CHECK_SURFACE) continue;
    notes.receiptsRead += 1;
    if (!payload.ok || !payload.answers) { notes.failedCalls += 1; continue; }
    const packet = index.packetOf(event);
    const outcome = packet ? index.after(packet, event) : null;
    const y = outcome ? outcomeLabel(outcome) : null;
    if (y === null) { notes.unlabeled += 1; continue; }
    if (outcome.rerun) notes.rerun += 1;
    if (outcome.rejected) notes.rejected += 1;
    if (y === 0) notes.merged += 1;
    for (const predictor of CLAIM_PREDICTORS) {
      const p = payload.answers[predictor]?.noul;
      if (typeof p !== 'number') continue;
      rows.push({ predictor, p, y, packet, laneId: event.lane_id, receiptId: payload.receiptId ?? null });
    }
  }
  return { rows, notes };
}

/** Receipt events, rerun and merge signals, lanes, approvals, and outcomes, from a read-only connection. */
export async function loadClaimUnbackedHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const read = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  try {
    return {
      events: read(`
        SELECT rowid AS seq, lane_id, verb, payload_json, timestamp FROM lane_events
        WHERE verb IN ('judgment', 'directive_citations', 'status_change', 'rerun_with_feedback', 'typecheck_auto_retry', 'session_launched')
        ORDER BY rowid
      `),
      lanes: read('SELECT id, packet_id FROM lanes'),
      approvals: read('SELECT id, packet_id, lane_id, status, diff_json, resolved_at, resolution_json FROM approvals WHERE resolved_at IS NOT NULL'),
      outcomes: read('SELECT packet_id, merged_clean FROM session_outcomes WHERE packet_id IS NOT NULL'),
    };
  } finally {
    db.close();
  }
}
