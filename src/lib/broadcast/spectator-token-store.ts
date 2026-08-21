import 'server-only';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import {
  readActiveSpectatorTokenHashes,
  writeActiveSpectatorTokenHashes,
} from './spectator-token-file';

const TOKEN_BYTES = 32;
const TOKEN_PREFIX = 'o8sp_';
const LABEL_MAX_LENGTH = 120;

interface BroadcastTokenRow {
  id: string;
  token_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface BroadcastTokenRecord {
  id: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface MintBroadcastTokenResult {
  record: BroadcastTokenRecord;
  /** Returned once. Only its SHA-256 hash is persisted. */
  bearer: string;
}

type ProjectionWriter = (hashes: string[]) => void;
type ProjectionReader = () => ReadonlySet<string>;

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function normalizeLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.length > LABEL_MAX_LENGTH) {
    throw new Error(`Broadcast token label must be at most ${LABEL_MAX_LENGTH} characters.`);
  }
  return normalized;
}

function publicRecord(row: BroadcastTokenRow): BroadcastTokenRecord {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export class SpectatorTokenStore {
  constructor(
    private readonly sqlite: Database.Database,
    private readonly writeProjection: ProjectionWriter = writeActiveSpectatorTokenHashes,
    private readonly readProjection: ProjectionReader = readActiveSpectatorTokenHashes,
  ) {
    ensureV44BroadcastSchema(sqlite);
  }

  private activeHashes(): Set<string> {
    return new Set((this.sqlite.prepare(`
      SELECT token_hash FROM broadcast_tokens
      WHERE revoked_at IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ token_hash: string }>).map((row) => row.token_hash));
  }

  private projectedActiveHashes(): string[] {
    const active = this.activeHashes();
    // Authority removed from the projection stays removed. This preserves a
    // fail-closed revoke if the process dies after publishing the deny but
    // before SQLite records revoked_at; a later mutation must not resurrect it.
    return [...this.readProjection()].filter((hash) => active.has(hash)).sort();
  }

  mint(label?: string | null): MintBroadcastTokenResult {
    const bearer = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const row: BroadcastTokenRow = {
      id: `spectator-${randomUUID()}`,
      token_hash: hashToken(bearer),
      label: normalizeLabel(label),
      created_at: new Date().toISOString(),
      revoked_at: null,
    };

    this.sqlite.transaction(() => {
      this.sqlite.prepare(`
        INSERT INTO broadcast_tokens (id, token_hash, label, created_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL)
      `).run(row.id, row.token_hash, row.label, row.created_at);
    }).immediate();

    try {
      // DB-first means a crash can leave an unusable canonical row, never an
      // authorized bearer with no canonical record.
      this.writeProjection([...new Set([...this.projectedActiveHashes(), row.token_hash])].sort());
    } catch (error) {
      // The atomic projection writer has not published on failure. Remove the
      // unusable row so a failed mint can be retried cleanly.
      this.sqlite.prepare('DELETE FROM broadcast_tokens WHERE id = ?').run(row.id);
      throw error;
    }

    return { record: publicRecord(row), bearer };
  }

  revoke(id: string): BroadcastTokenRecord | null {
    const normalizedId = id.trim();
    if (!normalizedId) throw new Error('Broadcast token id is required.');
    const existing = this.sqlite.prepare(`
      SELECT * FROM broadcast_tokens WHERE id = ? AND revoked_at IS NULL
    `).get(normalizedId) as BroadcastTokenRow | undefined;
    if (!existing) return null;
    // Projection-first makes every failure deny more authority, never less.
    this.writeProjection(this.projectedActiveHashes().filter((hash) => hash !== existing.token_hash));
    let revoked: BroadcastTokenRow | null = null;
    this.sqlite.transaction(() => {
      const revokedAt = new Date().toISOString();
      const changed = this.sqlite.prepare(`
        UPDATE broadcast_tokens SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `).run(revokedAt, normalizedId);
      if (changed.changes !== 1) return;
      revoked = { ...existing, revoked_at: revokedAt };
    }).immediate();
    return revoked ? publicRecord(revoked) : null;
  }
}

let singleton: SpectatorTokenStore | null = null;

export function getSpectatorTokenStore(): SpectatorTokenStore {
  singleton ??= new SpectatorTokenStore(getSqlite());
  return singleton;
}
