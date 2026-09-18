/**
 * The `wakeTriage` label for the calibration replay (#2467, #2438).
 *
 * Reads the recorded `wake_triage` lane events (written by the record-only
 * wake triage) and scores each recorded answer against what happened next on
 * the same lane within the next WINDOW lane events. Reads the database
 * read-only; sends nothing.
 *
 * Outcome: the first of these in the window, else `nothing`:
 *   steered       a `steered_packet` or `send_turn` event
 *   redispatched  a status change to `launching` (a fresh worker session)
 *   operatorAsked a status change to `awaiting_human` or `awaiting_input`
 *   merged        a `merge` event or a status change to `completed`
 *
 * Mapping to the three options (the label the answer is scored against):
 *   merged (with no steer, redispatch, or operator ask before it) -> handleInPlace
 *   nothing                                                       -> queue
 *   steered, redispatched, operatorAsked                          -> wake
 *
 * Each option is scored one-versus-rest: p = the recorded probability of that
 * option, y = 1 when the mapped label is that option.
 */

export const WAKE_TRIAGE_WINDOW = 20;
export const WAKE_TRIAGE_OPTIONS = ['handleInPlace', 'queue', 'wake'];
export const OUTCOME_TO_OPTION = {
  merged: 'handleInPlace',
  nothing: 'queue',
  steered: 'wake',
  redispatched: 'wake',
  operatorAsked: 'wake',
};

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/** The outcome an event marks, or null when it marks none. */
function outcomeOf(event) {
  if (event.verb === 'steered_packet' || event.verb === 'send_turn') return 'steered';
  if (event.verb === 'merge') return 'merged';
  if (event.verb !== 'status_change') return null;
  const status = parseJson(event.payload_json)?.status;
  if (status === 'launching') return 'redispatched';
  if (status === 'awaiting_human' || status === 'awaiting_input') return 'operatorAsked';
  if (status === 'completed') return 'merged';
  return null;
}

/**
 * Rows `{ option, p, y, packet, laneId, outcome, abstain }` from lane events
 * ordered by lane and rowid. `packet` is the lane id (one fold per lane).
 */
export function labelWakeTriage(events, window = WAKE_TRIAGE_WINDOW) {
  const byLane = new Map();
  for (const event of events) {
    const list = byLane.get(event.lane_id) ?? [];
    list.push(event);
    byLane.set(event.lane_id, list);
  }
  const rows = [];
  const notes = { recorded: 0, outcomes: { merged: 0, nothing: 0, steered: 0, redispatched: 0, operatorAsked: 0 }, abstained: 0, unreadable: 0 };
  for (const [laneId, list] of byLane) {
    list.forEach((event, index) => {
      if (event.verb !== 'wake_triage') return;
      const payload = parseJson(event.payload_json);
      const probabilities = payload?.probabilities;
      if (!probabilities || typeof probabilities !== 'object') { notes.unreadable += 1; return; }
      notes.recorded += 1;
      let outcome = 'nothing';
      for (const next of list.slice(index + 1, index + 1 + window)) {
        const found = outcomeOf(next);
        if (found) { outcome = found; break; }
      }
      notes.outcomes[outcome] += 1;
      if (payload.abstain) notes.abstained += 1;
      const label = OUTCOME_TO_OPTION[outcome];
      for (const option of WAKE_TRIAGE_OPTIONS) {
        const p = probabilities[option];
        if (typeof p !== 'number') continue;
        rows.push({ option, p, y: label === option ? 1 : 0, packet: laneId, laneId, outcome, abstain: Boolean(payload.abstain) });
      }
    });
  }
  return { rows, notes };
}

/** Lane events for every lane that has a recorded triage, from the database opened read-only. */
export async function loadWakeTriageHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(`
      SELECT lane_id, verb, payload_json FROM lane_events
      WHERE lane_id IN (SELECT DISTINCT lane_id FROM lane_events WHERE verb = 'wake_triage')
      ORDER BY lane_id, rowid
    `).all();
  } finally {
    db.close();
  }
}
