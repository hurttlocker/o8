import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getSqlite } from '@/lib/db';

const PREFIX = 'o8ro_';
const SCOPE = 'local-read-only';
const LIFETIME_MS = 12 * 60 * 60_000;

/** Recognition conveys no capability, including after expiry or revocation. */
export function isReadOnlyWorkerBearer(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** A per-run identity with zero API permissions, never an ordinary worker token. */
export function mintReadOnlyWorkerToken(runId: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(runId)) throw new Error('Invalid controlled worker run.');
  const token = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  getSqlite().prepare(`INSERT INTO worker_tokens
    (id, token_hash, packet_id, label, scope, max_workers, created_at, revoked_at,
     lease_process_marker, lease_process_pid, lease_process_group_id)
    VALUES (?, ?, NULL, 'Read-only worker', ?, 1, ?, NULL, ?, NULL, NULL)`)
    .run(`wtok_readonly_${randomUUID()}`, createHash('sha256').update(token).digest('hex'),
      SCOPE, new Date().toISOString(), runId);
  return token;
}

export function resolveReadOnlyWorkerToken(token: string): { tokenId: string; runId: string } | null {
  if (!/^o8ro_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const row = getSqlite().prepare(`SELECT id, lease_process_marker, created_at, revoked_at FROM worker_tokens
      WHERE token_hash = ? AND scope = ?`).get(createHash('sha256').update(token).digest('hex'), SCOPE) as
      { id: string; lease_process_marker: string; created_at: string; revoked_at: string | null } | undefined;
    const created = row ? Date.parse(row.created_at) : NaN;
    if (!row || row.revoked_at || !row.lease_process_marker || !Number.isFinite(created)
      || created > Date.now() || Date.now() - created >= LIFETIME_MS) return null;
    return { tokenId: row.id, runId: row.lease_process_marker };
  } catch { return null; }
}

export function revokeReadOnlyWorkerToken(runId: string): void {
  getSqlite().prepare(`UPDATE worker_tokens SET revoked_at = COALESCE(revoked_at, ?)
    WHERE scope = ? AND lease_process_marker = ?`).run(new Date().toISOString(), SCOPE, runId);
}
