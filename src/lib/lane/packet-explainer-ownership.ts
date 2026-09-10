import { getSqlite } from '@/lib/db';
import { listOrchestratorTurnsForSessions } from './orchestrator-crash-survival';
import { sessionNameForRepo } from './orchestrator-session-core';

export interface ExplainerClaim {
  id: string;
  packet_id: string;
  lane_id: string;
  repo_path: string;
  claim_owner: string;
  payload_json?: string;
}

/** Use a recognized thread namespace so optional work never borrows a user session. */
export function explainerThreadId(row: ExplainerClaim): string {
  return `thoughts-${row.id}-${row.claim_owner}`;
}

export function ownsCurrentExplainer(row: ExplainerClaim): boolean {
  return Boolean(getSqlite().prepare(`
    SELECT 1 FROM explainer_queue current
    WHERE id = ? AND status = 'in_progress' AND claim_owner = ?
      AND NOT EXISTS (
        SELECT 1 FROM explainer_queue newer
        WHERE newer.packet_id = current.packet_id AND newer.rowid > current.rowid
      )
  `).get(row.id, row.claim_owner));
}

export function isLatestExplainer(id: string): boolean {
  return Boolean(getSqlite().prepare(`
    SELECT 1 FROM explainer_queue current WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM explainer_queue newer
      WHERE newer.packet_id = current.packet_id AND newer.rowid > current.rowid
    )
  `).get(id));
}

function mayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors and unknown failures are not proof of termination.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function explainerProcessState(row: ExplainerClaim): 'alive' | 'dead' | 'absent' | 'unknown' {
  const threadId = explainerThreadId(row);
  const prefixes = ['cortex-codex-orchestrator', 'cortex-orchestrator'];
  const records = listOrchestratorTurnsForSessions(prefixes.map((prefix) => (
    sessionNameForRepo(prefix, row.repo_path, threadId)
  )));
  // Older versions collapsed non-thoughts IDs into a repo-wide session. Never
  // kill or assume ownership of that shared session during upgrade recovery.
  let attemptScoped = false;
  try {
    attemptScoped = JSON.parse(row.payload_json ?? '{}').generationId === threadId;
  } catch { return 'unknown'; }
  const legacyRecords = records.length || attemptScoped ? [] : listOrchestratorTurnsForSessions(
    prefixes.map((prefix) => sessionNameForRepo(prefix, row.repo_path)),
  );
  const evidence = records.length ? records : legacyRecords;
  if (evidence.length === 0) return 'absent';
  if (evidence.some((record) => !record.pid)) return 'unknown';
  return evidence.some((record) => mayExist(record.pid)
    || (process.platform !== 'win32' && mayExist(-record.pid))) ? 'alive' : 'dead';
}

export function hasUnsettledExplainerProcess(row: ExplainerClaim): boolean {
  const state = explainerProcessState(row);
  return state === 'alive' || state === 'unknown';
}

/** Reclaim only after the previous owner AND its provider group have exited. */
export function recoverExplainerClaims(): void {
  const rows = getSqlite().prepare(`
    SELECT id, packet_id, lane_id, repo_path, claim_owner, payload_json, outcome
    FROM explainer_queue WHERE status = 'in_progress'
  `).all() as Array<ExplainerClaim & { outcome: string | null }>;
  for (const row of rows) {
    const ownerPid = Number(/^explainer-owner-(\d+)-/.exec(row.claim_owner ?? '')?.[1]);
    if (row.outcome !== 'awaiting_exit' && (!ownerPid || mayExist(ownerPid))) continue;
    const processState = explainerProcessState(row);
    if (processState !== 'dead') {
      const reason = processState === 'alive' ? 'Previous explainer process is still alive; restart held'
        : 'Previous explainer exit is unconfirmed; restart held';
      getSqlite().prepare(`
        UPDATE explainer_queue SET last_error = ?
        WHERE id = ? AND status = 'in_progress' AND claim_owner = ? AND last_error IS NOT ?
      `).run(reason, row.id, row.claim_owner, reason);
      continue;
    }
    getSqlite().prepare(`
      UPDATE explainer_queue
      SET status = 'pending', last_error = 'Recovered after confirmed provider exit',
          claimed_at = NULL, claim_owner = NULL, outcome = 'recovered', updated_at = datetime('now')
      WHERE id = ? AND status = 'in_progress' AND claim_owner = ?
    `).run(row.id, row.claim_owner);
  }
}
