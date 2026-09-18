/**
 * The `directiveCitation` label for the calibration replay (#2446, #2438).
 *
 * Rows are the per-(file, rule) scores inside each recorded
 * `directive_citations` lane event (p = the recorded probability the file
 * breaks the rule), held-back rules included and marked. Ground truth, from
 * stored data with no human labels:
 * - positive (1): the approval for that diff was rejected by `desktop` or
 *   `mobile`, or the packet was rerun after the event (the rerun signals of
 *   the claimUnbacked label: `rerun_with_feedback`, `typecheck_auto_retry`,
 *   `session_launched`, as a verb or a `status_change` eventLabel).
 * - negative (0): neither, and the packet merged (`status_change` eventLabel
 *   `merged` or `merged_pushed`, or an outcome row with merged_clean set).
 * - otherwise unlabeled and left out.
 * "The approval for that diff" is an approval of the packet whose diff_json
 * fingerprints (as `approvalDiffFingerprint` does) to the event's
 * diffFingerprint; when no approval of the packet matches, any operator
 * rejection of the packet resolved after the event counts. The label is per
 * diff, not per rule: a rejection for another rule's reason still marks every
 * row of that diff positive, which is why the report breaks results out per
 * rule. Reads the database read-only; sends nothing.
 */

import { createHash } from 'node:crypto';

import { outcomeLabel, packetOutcomeIndex } from './judgment-replay-claim-unbacked.mjs';

/** The shipped citation threshold (DIRECTIVE_CITATION_THRESHOLD in src/lib/judgment/questions.ts). */
export const DIRECTIVE_CITATION_REPLAY_THRESHOLD = 0.6;

const OPERATOR_ACTORS = new Set(['desktop', 'mobile']);

const parseJson = (raw) => {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

/** Same hash as `approvalDiffFingerprint` over a stored approval diff. */
function approvalFingerprint(diffJson) {
  const diff = parseJson(diffJson);
  if (!diff) return null;
  const hash = createHash('sha256');
  hash.update(typeof diff.after === 'string' ? diff.after : '');
  for (const path of (diff.files ?? []).map((file) => String(file?.path ?? '')).sort()) hash.update(`\0${path}`);
  return hash.digest('hex');
}

/** The rule key a rule id ends in (`spec-ingest:...#css-classes` -> `css-classes`). */
const ruleKey = (ruleId) => String(ruleId).split('#').pop();

/**
 * Rows `{ p, y, packet, laneId, path, ruleId, rule, heldBack }`. `packet` is
 * the packet id (one fold per packet). Takes the claimUnbacked history shape.
 */
export function labelDirectiveCitations(history) {
  const index = packetOutcomeIndex(history);
  const approvalsByPacket = new Map();
  for (const approval of history.approvals) {
    if (!approval.packet_id) continue;
    approvalsByPacket.set(approval.packet_id, [...(approvalsByPacket.get(approval.packet_id) ?? []), approval]);
  }
  const rows = [];
  const notes = { eventsRead: 0, scoresRead: 0, unlabeledEvents: 0, matchedByFingerprint: 0 };
  for (const event of history.events) {
    if (event.verb !== 'directive_citations') continue;
    notes.eventsRead += 1;
    const payload = parseJson(event.payload_json);
    const scores = Array.isArray(payload?.scores) ? payload.scores : [];
    notes.scoresRead += scores.length;
    const packet = index.packetOf(event);
    const outcome = packet ? index.after(packet, event) : null;
    if (outcome) {
      const matching = (approvalsByPacket.get(packet) ?? []).filter((approval) => approvalFingerprint(approval.diff_json) === payload.diffFingerprint);
      if (matching.length > 0) {
        notes.matchedByFingerprint += 1;
        outcome.rejected = matching.some((approval) => OPERATOR_ACTORS.has(parseJson(approval.resolution_json)?.actor)
          && (approval.status === 'rejected' || parseJson(approval.resolution_json)?.action === 'rejected'));
      }
    }
    const y = outcome ? outcomeLabel(outcome) : null;
    if (y === null) { notes.unlabeledEvents += 1; continue; }
    for (const score of scores) {
      if (typeof score?.probability !== 'number') continue;
      rows.push({
        p: score.probability,
        y,
        packet,
        laneId: event.lane_id,
        path: score.path,
        ruleId: score.ruleId,
        rule: ruleKey(score.ruleId),
        heldBack: score.heldBack === true,
      });
    }
  }
  return { rows, notes };
}

/**
 * Per rule at the shipped threshold: rows, positives, citations on positives,
 * and false citations (p >= threshold on a y=0 row).
 */
export function citationsByRule(rows, threshold = DIRECTIVE_CITATION_REPLAY_THRESHOLD) {
  const byRule = new Map();
  for (const row of rows) {
    const entry = byRule.get(row.rule) ?? { rule: row.rule, n: 0, positives: 0, cited: 0, falseCitations: 0, heldBack: row.heldBack };
    entry.n += 1;
    if (row.y === 1) entry.positives += 1;
    if (row.p >= threshold) {
      if (row.y === 1) entry.cited += 1;
      else entry.falseCitations += 1;
    }
    byRule.set(row.rule, entry);
  }
  return [...byRule.values()].sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
