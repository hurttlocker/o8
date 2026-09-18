/**
 * The `loop` label for the calibration replay (#2448, #2438).
 *
 * Scores the loop-detector answers already recorded as `loop_check` lane
 * events; makes no new calls and sends nothing. Ground truth comes from the
 * same lane's later events and the outcome ledger, with no human labels:
 *
 * - positive (1): after the check, an operator or the orchestrator intervened
 *   on the lane: a `steered_packet` or `interrupt` event, or a
 *   `status_change` with eventLabel `session_launched` whose actor is `user`
 *   or `orchestrator` (a reset or rerun; the system's own typecheck rerun is
 *   actor `system` and does not count).
 * - negative (0): no such intervention after the check, and the packet's
 *   outcome row records a merge (`merged_clean` not null).
 * - otherwise unlabeled and left out.
 *
 * Legitimate retry-with-fix loops that merged without help land as negatives,
 * which is the false-positive class this label measures.
 */

const INTERVENTION_ACTORS = new Set(['user', 'orchestrator']);

const parse = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

function isIntervention(event) {
  if (event.verb === 'steered_packet' || event.verb === 'interrupt') return true;
  if (event.verb !== 'status_change' || !INTERVENTION_ACTORS.has(event.actor)) return false;
  return parse(event.payload_json)?.eventLabel === 'session_launched';
}

/**
 * One row per recorded check: `{ p, y, packet, laneId }`. `events` are lane
 * events ordered by rowid (`lane_id, verb, actor, payload_json, seq`);
 * `outcomes` are `{ packet_id, merged_clean }` rows.
 */
export function labelLoopChecks(events, outcomes) {
  const merged = new Set(outcomes.filter((row) => row.merged_clean !== null && row.merged_clean !== undefined).map((row) => row.packet_id));
  const interventionsByLane = new Map();
  for (const event of events) {
    if (!isIntervention(event)) continue;
    interventionsByLane.set(event.lane_id, [...(interventionsByLane.get(event.lane_id) ?? []), event.seq]);
  }
  const rows = [];
  const notes = { checksRead: 0, unlabeled: 0 };
  for (const event of events) {
    if (event.verb !== 'loop_check') continue;
    notes.checksRead += 1;
    const payload = parse(event.payload_json);
    if (!payload || typeof payload.p !== 'number') { notes.unlabeled += 1; continue; }
    const intervened = (interventionsByLane.get(event.lane_id) ?? []).some((seq) => seq > event.seq);
    const y = intervened ? 1 : merged.has(payload.packetId) ? 0 : null;
    if (y === null) { notes.unlabeled += 1; continue; }
    rows.push({ p: payload.p, y, packet: payload.packetId ?? event.lane_id, laneId: event.lane_id });
  }
  return { rows, notes };
}

/** Read the recorded checks and the events that label them. Read-only. */
export async function loadLoopHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const events = db.prepare(`
      SELECT rowid AS seq, lane_id, verb, actor, payload_json FROM lane_events
      WHERE verb IN ('loop_check', 'steered_packet', 'interrupt', 'status_change')
      ORDER BY rowid
    `).all();
    let outcomes = [];
    try {
      outcomes = db.prepare('SELECT packet_id, merged_clean FROM session_outcomes WHERE packet_id IS NOT NULL').all();
    } catch { /* no ledger yet */ }
    return { events, outcomes };
  } finally {
    db.close();
  }
}
