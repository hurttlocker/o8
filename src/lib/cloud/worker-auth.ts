/**
 * Cloud runtime — worker API-key auth (issue #514 v0 scaffolding)
 *
 * Service account keys live as JSON files under `~/.cortex-ide/cloud-workers/`
 * for v0. Each file is one key record:
 *   {
 *     "id": "cwk_abc123",
 *     "teamId": "team_default",
 *     "label": "Brex production pool",
 *     "keyHash": "<sha256 hex of plaintext>",
 *     "createdAt": "2026-04-18T..."
 *   }
 *
 * Full DB schema is a follow-up — see #514 follow-up issue the code filer
 * must open after this ships. This config-file-first approach lets early
 * adopters bootstrap without a DB migration while the protocol stabilizes.
 *
 * Why not `~/.o8/ws-token`? That token is per-user, loopback-only. Cloud
 * workers run off-host (Kubernetes, VMs, customer bare metal), so they need
 * a separate tier of credential with team scoping baked in.
 */
import 'server-only';

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface CloudWorkerKey {
  id: string;
  teamId: string;
  label: string;
  keyHash: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CloudAuthOk {
  ok: true;
  keyId: string;
  teamId: string;
  label: string;
}

export interface CloudAuthErr {
  ok: false;
  status: 401 | 403;
  reason: string;
}

const KEY_PREFIX = 'cwk_';

function dataDir(): string {
  return getDataDir();
}

export function cloudWorkersDir(): string {
  return join(dataDir(), 'cloud-workers');
}

function ensureDir() {
  const dir = cloudWorkersDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function safeParse(value: string): CloudWorkerKey | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      parsed
      && typeof parsed === 'object'
      && typeof (parsed as CloudWorkerKey).id === 'string'
      && typeof (parsed as CloudWorkerKey).teamId === 'string'
      && typeof (parsed as CloudWorkerKey).keyHash === 'string'
      && typeof (parsed as CloudWorkerKey).createdAt === 'string'
    ) {
      return parsed as CloudWorkerKey;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * List all key records (revoked included). The Settings UI calls this to
 * render the Workers table.
 */
export function listCloudWorkerKeys(): CloudWorkerKey[] {
  const dir = ensureDir();
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter((name) => name.endsWith('.json'));
  const records: CloudWorkerKey[] = [];
  for (const entry of entries) {
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const parsed = safeParse(raw);
      if (parsed) records.push(parsed);
    } catch {
      // Ignore unreadable files — don't let one bad JSON poison the list.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Generate a new key + write its metadata record. Returns the plaintext
 * exactly once — caller is responsible for surfacing it to the operator.
 */
export function createCloudWorkerKey(params: { teamId: string; label: string }): {
  record: CloudWorkerKey;
  plaintext: string;
} {
  const dir = ensureDir();
  const plaintext = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const id = `cwk_${randomBytes(6).toString('hex')}`;
  const record: CloudWorkerKey = {
    id,
    teamId: params.teamId,
    label: params.label,
    keyHash,
    createdAt: new Date().toISOString(),
  };
  const filePath = join(dir, `${id}.json`);
  writeFileSync(filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  // Explicit chmod in case the file already existed with looser perms.
  try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
  return { record, plaintext };
}

/**
 * Revoke a key by id. We write the record back with a revokedAt timestamp
 * rather than deleting it, so audit trails survive.
 */
export function revokeCloudWorkerKey(id: string): CloudWorkerKey | null {
  const dir = ensureDir();
  const filePath = join(dir, `${id}.json`);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = safeParse(raw);
  if (!parsed) return null;
  if (parsed.revokedAt) return parsed;
  const updated = { ...parsed, revokedAt: new Date().toISOString() };
  writeFileSync(filePath, JSON.stringify(updated, null, 2), { mode: 0o600 });
  return updated;
}

/**
 * Verify an incoming `Authorization: Bearer <key>` header.
 * This is the hot path — cloud workers hit it on every long-poll tick, so we
 * iterate the config-file records but do constant-time hash comparison to
 * avoid leaking timing information about which record matched.
 */
export function verifyCloudWorkerKey(authHeader: string | null): CloudAuthOk | CloudAuthErr {
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, reason: 'missing_bearer' };
  }
  const token = authHeader.slice(7).trim();
  if (!token || !token.startsWith(KEY_PREFIX)) {
    return { ok: false, status: 401, reason: 'malformed_token' };
  }
  const presented = createHash('sha256').update(token).digest();
  const records = listCloudWorkerKeys();
  for (const record of records) {
    const stored = Buffer.from(record.keyHash, 'hex');
    if (stored.length !== presented.length) continue;
    if (!timingSafeEqual(stored, presented)) continue;
    if (record.revokedAt) {
      return { ok: false, status: 403, reason: 'revoked' };
    }
    return {
      ok: true,
      keyId: record.id,
      teamId: record.teamId,
      label: record.label,
    };
  }
  return { ok: false, status: 401, reason: 'unknown_token' };
}
