/**
 * The `pushGate` label for the calibration replay (#2441, #2438).
 *
 * Rows are the recorded `push_gate` lane events (p = the recorded probability
 * the event needed the operator's attention now). Ground truth, from stored
 * data with no human labels: the operator acted on the underlying object
 * within 30 minutes of the push (positive) when either
 *   - an approval on the same lane (the event's approval, or any approval
 *     whose lane_id matches) was resolved by `desktop` or `mobile`, with
 *     resolved_at in the window, or
 *   - the lane recorded an event with actor `user` in the window (operator
 *     commands: merge, reject, archive, steer, and the rest).
 * Push gates with no lane keep a receipt only and are not scored. Reads the
 * database read-only; sends nothing.
 */

export const PUSH_GATE_WINDOW_MS = 30 * 60 * 1000;
/** PROVISIONAL band the push gate records against (ABSTAIN_CONFIDENCE). */
export const PUSH_GATE_PROVISIONAL_BAND = 0.4;

const OPERATOR_ACTORS = new Set(['desktop', 'mobile']);

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

/**
 * One row per recorded push gate: `{ p, y, packet, kind, wouldSuppress, operatorGated }`,
 * where `packet` is the lane id (one leave-one-out fold per lane).
 */
export function labelPushGate({ gates, approvals, operatorEvents }) {
  const rows = [];
  const notes = { gatesRead: gates.length, withoutP: 0 };
  for (const gate of gates) {
    const payload = parseJson(gate.payload_json) ?? {};
    if (typeof payload.p !== 'number') { notes.withoutP += 1; continue; }
    const at = toMs(gate.timestamp);
    const inWindow = (ms) => Number.isFinite(ms) && ms >= at && ms <= at + PUSH_GATE_WINDOW_MS;
    const approvalActed = approvals.some((approval) => approval.lane_id === gate.lane_id
      && OPERATOR_ACTORS.has(parseJson(approval.resolution_json)?.actor)
      && inWindow(toMs(approval.resolved_at)));
    const laneActed = operatorEvents.some((event) => event.lane_id === gate.lane_id && inWindow(toMs(event.timestamp)));
    rows.push({
      p: payload.p,
      y: approvalActed || laneActed ? 1 : 0,
      packet: gate.lane_id,
      kind: payload.kind ?? null,
      wouldSuppress: payload.wouldSuppress === true,
      operatorGated: payload.operatorGated === true,
    });
  }
  return { rows, notes };
}

/** Push gate events and the operator actions that label them, from a read-only connection. */
export async function loadPushGateHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const read = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  try {
    return {
      gates: read("SELECT lane_id, payload_json, timestamp FROM lane_events WHERE verb = 'push_gate' ORDER BY timestamp"),
      approvals: read('SELECT id, lane_id, resolved_at, resolution_json FROM approvals WHERE lane_id IS NOT NULL AND resolved_at IS NOT NULL'),
      operatorEvents: read("SELECT lane_id, timestamp FROM lane_events WHERE actor = 'user'"),
    };
  } finally {
    db.close();
  }
}
