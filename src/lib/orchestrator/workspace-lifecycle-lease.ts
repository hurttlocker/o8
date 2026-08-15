import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { getDataDir } from '../data-dir-migration';
import { ensureV39WorkspaceLifecycleLeaseSchema } from '../db/v39-workspace-lifecycle-lease-migration';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';

const RETRY_MS = 25;
const WAIT_BUDGET_MS = 5 * 60_000;

interface WorkspaceLifecycleLeaseRow {
  packet_id: string;
  reservation_id: string;
  owner_pid: number;
  owner_identity_json: string;
  acquired_at: number;
}

export interface WorkspaceLifecycleLease {
  packetId: string;
  reservationId: string;
  contended: boolean;
}

export class WorkspaceLifecycleLeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLifecycleLeaseUnavailableError';
  }
}

let currentProcessIdentityPromise: Promise<MetadataLockProcessIdentity> | null = null;

function withLeaseDatabase<T>(operation: (sqlite: Database.Database) => T): T {
  const dataDir = getDataDir();
  const databasePath = process.env.CORTEX_IDE_DB_PATH
    || path.join(dataDir, 'cortex-ide.db');
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma('busy_timeout = 5000');
    ensureV39WorkspaceLifecycleLeaseSchema(sqlite);
    try {
      chmodSync(dataDir, 0o700);
      if (existsSync(databasePath)) chmodSync(databasePath, 0o600);
    } catch {
      // The main database follows the same best-effort local permission rule.
    }
    return operation(sqlite);
  } finally {
    sqlite.close();
  }
}

async function currentProcessIdentity(): Promise<MetadataLockProcessIdentity> {
  currentProcessIdentityPromise ??= probeMetadataLockProcessIdentity(process.pid).then((probe) => {
    if (probe.state !== 'live') {
      throw new WorkspaceLifecycleLeaseUnavailableError(
        `Current process identity is ${probe.state}; workspace lifecycle mutation is held.`,
      );
    }
    return probe.identity;
  });
  return currentProcessIdentityPromise;
}

function parseOwnerIdentity(row: WorkspaceLifecycleLeaseRow): MetadataLockProcessIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.owner_identity_json) as unknown;
  } catch {
    throw new WorkspaceLifecycleLeaseUnavailableError(
      `Workspace lifecycle lease for packet ${row.packet_id} has corrupt owner identity.`,
    );
  }
  if (!isMetadataLockProcessIdentity(parsed)) {
    throw new WorkspaceLifecycleLeaseUnavailableError(
      `Workspace lifecycle lease for packet ${row.packet_id} has invalid owner identity.`,
    );
  }
  return parsed;
}

function claimLease(
  packetId: string,
  reservationId: string,
  identity: MetadataLockProcessIdentity,
): { acquired: boolean; owner: WorkspaceLifecycleLeaseRow | null } {
  return withLeaseDatabase((sqlite) => sqlite.transaction(() => {
    const inserted = sqlite.prepare(`
      INSERT OR IGNORE INTO workspace_lifecycle_leases (
        packet_id, reservation_id, owner_pid, owner_identity_json, acquired_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(packetId, reservationId, process.pid, JSON.stringify(identity), Date.now());
    if (inserted.changes === 1) return { acquired: true, owner: null };
    const owner = sqlite.prepare(`
      SELECT packet_id, reservation_id, owner_pid, owner_identity_json, acquired_at
      FROM workspace_lifecycle_leases
      WHERE packet_id = ?
    `).get(packetId) as WorkspaceLifecycleLeaseRow | undefined;
    return { acquired: false, owner: owner ?? null };
  }).immediate());
}

function reclaimLease(owner: WorkspaceLifecycleLeaseRow): boolean {
  return withLeaseDatabase((sqlite) => sqlite.prepare(`
    DELETE FROM workspace_lifecycle_leases
    WHERE packet_id = ? AND reservation_id = ?
  `).run(owner.packet_id, owner.reservation_id).changes === 1);
}

function waitBriefly(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_MS));
}

export async function acquireWorkspaceLifecycleLease(
  rawPacketId: string,
): Promise<WorkspaceLifecycleLease> {
  const packetId = rawPacketId.trim();
  if (!packetId) {
    throw new WorkspaceLifecycleLeaseUnavailableError('Workspace lifecycle packet id is required.');
  }
  const identity = await currentProcessIdentity();
  const reservationId = randomUUID();
  const deadline = Date.now() + WAIT_BUDGET_MS;
  let contended = false;
  for (;;) {
    const claim = claimLease(packetId, reservationId, identity);
    if (claim.acquired) return { packetId, reservationId, contended };
    contended = true;
    if (!claim.owner) {
      if (Date.now() >= deadline) break;
      await waitBriefly();
      continue;
    }
    const ownerIdentity = parseOwnerIdentity(claim.owner);
    const ownerProbe = await probeMetadataLockProcessIdentity(claim.owner.owner_pid);
    if (ownerProbe.state === 'absent'
      || (ownerProbe.state === 'live'
        && !sameMetadataLockProcessIdentity(ownerProbe.identity, ownerIdentity))) {
      reclaimLease(claim.owner);
      continue;
    }
    if (Date.now() >= deadline) break;
    await waitBriefly();
  }
  throw new WorkspaceLifecycleLeaseUnavailableError(
    `Timed out waiting for the exact workspace lifecycle owner of packet ${packetId}.`,
  );
}

export function releaseWorkspaceLifecycleLease(lease: WorkspaceLifecycleLease): void {
  const released = withLeaseDatabase((sqlite) => sqlite.prepare(`
    DELETE FROM workspace_lifecycle_leases
    WHERE packet_id = ? AND reservation_id = ?
  `).run(lease.packetId, lease.reservationId));
  if (released.changes !== 1) {
    throw new WorkspaceLifecycleLeaseUnavailableError(
      `Workspace lifecycle lease ${lease.reservationId} is no longer the owner of packet ${lease.packetId}.`,
    );
  }
}
