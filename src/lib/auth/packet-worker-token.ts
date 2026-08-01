import 'server-only';

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { registerPacketWorkerTokenHash } from './worker-token';

const PACKET_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const PACKET_WORKER_SCOPE = 'local-packet';

interface PacketWorkerTokenRow {
  id: string;
  token_hash: string;
  packet_id: string | null;
  revoked_at: string | null;
}

export interface PacketWorkerIdentity {
  tokenId: string;
  packetId: string;
}

function normalizedPacketId(packetId: string): string {
  const normalized = packetId.trim();
  if (!PACKET_ID_PATTERN.test(normalized)) {
    throw new Error('A valid packet id is required to mint a worker credential.');
  }
  return normalized;
}

/** Mint a one-way, packet-bound credential for one local worker process. */
export function mintPacketWorkerToken(packetId: string): string {
  const boundPacketId = normalizedPacketId(packetId);
  const id = `wtok_local_${randomUUID()}`;
  const plaintextToken = `o8pw_${randomBytes(32).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');
  const now = new Date().toISOString();

  getSqlite().prepare(`
    INSERT INTO worker_tokens
      (id, token_hash, packet_id, label, scope, max_workers, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
  `).run(id, tokenHash, boundPacketId, `Local packet ${boundPacketId}`, PACKET_WORKER_SCOPE, now);

  try {
    registerPacketWorkerTokenHash(tokenHash);
  } catch (error) {
    getSqlite().prepare('UPDATE worker_tokens SET revoked_at = ? WHERE id = ?').run(now, id);
    throw error;
  }
  return plaintextToken;
}

/** Resolve a packet worker bearer against its authoritative persisted row. */
export function resolvePacketWorkerToken(presented: string): PacketWorkerIdentity | null {
  if (!presented) return null;
  const presentedHash = createHash('sha256').update(presented).digest('hex');
  try {
    const row = getSqlite().prepare(`
      SELECT id, token_hash, packet_id, revoked_at
      FROM worker_tokens
      WHERE token_hash = ? AND scope = ?
      LIMIT 1
    `).get(presentedHash, PACKET_WORKER_SCOPE) as PacketWorkerTokenRow | undefined;
    if (!row || row.revoked_at || !row.packet_id) return null;
    const expected = Buffer.from(row.token_hash, 'hex');
    const actual = Buffer.from(presentedHash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { tokenId: row.id, packetId: row.packet_id };
  } catch {
    return null;
  }
}
