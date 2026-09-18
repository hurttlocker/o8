/**
 * The `catchUp` label for the calibration replay (#2444, #2511, #2438).
 *
 * Rows are the per-item attention scores in each recorded catch-up ranking
 * receipt. The surface carries no lane, so its receipts are
 * `judgment_receipts` rows (surface `catch-up-ranking`), not lane events.
 * Answers are keyed by a hashed question id; the receipt's selection
 * (`selection_json`, #2511) maps each question back to its item id and kind.
 * Receipts written before #2511 carry no selection and are counted, not
 * scored.
 *
 * Ground truth, from stored data with no human labels: the operator acted on
 * the item within 30 minutes of the briefing (the pushGate window), positive
 * when
 * - `approval:<id>`: that approval was resolved by `desktop` or `mobile`
 *   with resolved_at in the window;
 * - `lane:<sessionKey>`: on a lane with that session_key, an approval was
 *   resolved by `desktop` or `mobile` in the window, or the lane recorded an
 *   event with actor `user` (an operator command) in the window.
 * `item:<id>` (needs-you inbox rows) has no stored id to join against and is
 * left unlabeled. Nothing here reads the recorded score.
 *
 * Known confound, printed with the result: the score also orders what the
 * phone speaks and which items survive a section's item limit, so the
 * operator acting first on a high-scored item is partly caused by the score.
 * The AUC is an upper bound on the ranking's value until a replay can compare
 * against briefings spoken in event order.
 * Reads the database read-only; sends nothing.
 */

export const CATCH_UP_SURFACE = 'catch-up-ranking';
export const CATCH_UP_WINDOW_MS = 30 * 60 * 1000;

const OPERATOR_ACTORS = new Set(['desktop', 'mobile']);

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const toMs = (value) => (typeof value === 'number' ? value : Date.parse(value));

/**
 * One row per scored item: `{ p, y, packet, itemId, kind, receiptId }`, where
 * `packet` is the item id (one leave-one-out fold per item, since one item
 * recurs across briefings).
 */
export function labelCatchUp({ receipts, approvals, lanes, operatorEvents }) {
  const operatorResolvedAt = (approval) => (OPERATOR_ACTORS.has(parseJson(approval.resolution_json)?.actor) ? toMs(approval.resolved_at) : NaN);
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
  const lanesBySession = new Map();
  for (const lane of lanes) {
    if (lane.session_key) lanesBySession.set(lane.session_key, [...(lanesBySession.get(lane.session_key) ?? []), lane.id]);
  }
  const rows = [];
  const notes = { receiptsRead: receipts.length, failed: 0, withoutSelection: 0, unlabeledItems: 0 };
  for (const receipt of receipts) {
    const answers = parseJson(receipt.answers_json);
    if (!receipt.ok || !answers) { notes.failed += 1; continue; }
    const items = parseJson(receipt.selection_json)?.items;
    if (!Array.isArray(items)) { notes.withoutSelection += 1; continue; }
    const at = toMs(receipt.created_at);
    const inWindow = (ms) => Number.isFinite(ms) && ms >= at && ms <= at + CATCH_UP_WINDOW_MS;
    for (const item of items) {
      const p = answers[item?.question]?.noul;
      if (typeof p !== 'number' || typeof item.itemId !== 'string') continue;
      let y = null;
      if (item.itemId.startsWith('approval:')) {
        const approval = approvalById.get(item.itemId.slice('approval:'.length));
        y = approval && inWindow(operatorResolvedAt(approval)) ? 1 : 0;
      } else if (item.itemId.startsWith('lane:')) {
        const laneIds = new Set(lanesBySession.get(item.itemId.slice('lane:'.length)) ?? []);
        if (laneIds.size > 0) {
          const acted = approvals.some((approval) => laneIds.has(approval.lane_id) && inWindow(operatorResolvedAt(approval)))
            || operatorEvents.some((event) => laneIds.has(event.lane_id) && inWindow(toMs(event.timestamp)));
          y = acted ? 1 : 0;
        }
      }
      if (y === null) { notes.unlabeledItems += 1; continue; }
      rows.push({ p, y, packet: item.itemId, itemId: item.itemId, kind: item.kind ?? null, receiptId: receipt.id });
    }
  }
  return { rows, notes };
}

/** Ranking receipts and the operator actions that label them, from a read-only connection. */
export async function loadCatchUpHistory(dbPath) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const read = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  try {
    return {
      receipts: read(`SELECT id, ok, answers_json, selection_json, created_at FROM judgment_receipts WHERE surface = '${CATCH_UP_SURFACE}' ORDER BY created_at, rowid`),
      approvals: read('SELECT id, lane_id, resolved_at, resolution_json FROM approvals WHERE resolved_at IS NOT NULL'),
      lanes: read('SELECT id, session_key FROM lanes WHERE session_key IS NOT NULL'),
      operatorEvents: read("SELECT lane_id, timestamp FROM lane_events WHERE actor = 'user'"),
    };
  } finally {
    db.close();
  }
}
