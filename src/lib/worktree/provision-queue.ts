import { randomUUID } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import {
  acquireWorkspaceLifecycleLease,
  releaseWorkspaceLifecycleLease,
  WorkspaceLifecycleLeaseUnavailableError,
  type WorkspaceLifecycleLease,
} from '@/lib/orchestrator/workspace-lifecycle-lease';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from './metadata-lock-process-identity';

interface Waiter {
  sequence: number;
  reservation_id: string;
  owner_pid: number;
  owner_identity_json: string;
}

/** FIFO across dispatch processes. Waiting for healthy provisioning is not a failure. */
export async function withWorktreeProvisionQueue<T>(
  rootKey: string,
  positionChanged: (position: number) => void,
  materialize: () => Promise<T>,
): Promise<T> {
  const probe = await probeMetadataLockProcessIdentity(process.pid);
  if (probe.state !== 'live') throw new Error('Worktree provisioning could not prove its process owner.');
  const sqlite = getSqlite();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_provision_queue (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      root_key TEXT NOT NULL,
      reservation_id TEXT NOT NULL UNIQUE,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      lease_reservation_id TEXT
    );
    CREATE INDEX IF NOT EXISTS workspace_provision_queue_root ON workspace_provision_queue(root_key, sequence);
  `);
  const reservationId = randomUUID();
  const sequence = Number(sqlite.prepare(`
    INSERT INTO workspace_provision_queue (root_key, reservation_id, owner_pid, owner_identity_json)
    VALUES (?, ?, ?, ?)
  `).run(rootKey, reservationId, process.pid, JSON.stringify(probe.identity)).lastInsertRowid);
  let lease: WorkspaceLifecycleLease | undefined;
  let lastPosition = -1;
  let lastReportedAt = 0;
  const report = (position: number) => {
    if (position === lastPosition && Date.now() - lastReportedAt < 30_000) return;
    lastPosition = position;
    lastReportedAt = Date.now();
    positionChanged(position);
  };
  try {
    for (;;) {
      const predecessors = sqlite.prepare(`
        SELECT sequence, reservation_id, owner_pid, owner_identity_json FROM workspace_provision_queue
        WHERE root_key = ? AND sequence < ? ORDER BY sequence
      `).all(rootKey, sequence) as Waiter[];
      let ahead = 0;
      for (const waiter of predecessors) {
        const identity: unknown = JSON.parse(waiter.owner_identity_json);
        if (!isMetadataLockProcessIdentity(identity)) throw new Error('Worktree provisioning queue owner identity is invalid.');
        const owner = await probeMetadataLockProcessIdentity(waiter.owner_pid);
        if (owner.state === 'absent'
          || (owner.state === 'live' && !sameMetadataLockProcessIdentity(owner.identity, identity))) {
          sqlite.prepare('DELETE FROM workspace_provision_queue WHERE sequence = ? AND reservation_id = ?')
            .run(waiter.sequence, waiter.reservation_id);
        } else {
          // Unknown ownership stays ahead of us. Never reclaim from elapsed time alone.
          ahead += 1;
        }
      }
      if (ahead === 0) {
        try {
          lease = await acquireWorkspaceLifecycleLease(rootKey, { waitForLiveOwner: false });
        } catch (error) {
          if (!(error instanceof WorkspaceLifecycleLeaseUnavailableError) || error.reason !== 'contended') throw error;
        }
        if (lease) {
          sqlite.prepare('UPDATE workspace_provision_queue SET lease_reservation_id = ? WHERE reservation_id = ?')
            .run(lease.reservationId, reservationId);
          report(0);
          return await materialize();
        }
      }
      // A legacy/direct lifecycle owner has no queue ticket. Include that owner
      // ahead of every waiter, rather than reporting two packets in position 1.
      const queueHead = sqlite.prepare(`
        SELECT lease_reservation_id FROM workspace_provision_queue
        WHERE root_key = ? ORDER BY sequence LIMIT 1
      `).get(rootKey) as { lease_reservation_id: string | null } | undefined;
      const owner = sqlite.prepare('SELECT reservation_id FROM workspace_lifecycle_leases WHERE packet_id = ?')
        .get(rootKey) as { reservation_id: string } | undefined;
      const externalOwner = owner && owner.reservation_id !== queueHead?.lease_reservation_id;
      report(Math.max(1, ahead + (externalOwner ? 1 : 0)));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    try {
      if (lease) releaseWorkspaceLifecycleLease(lease);
    } finally {
      sqlite.prepare('DELETE FROM workspace_provision_queue WHERE reservation_id = ?').run(reservationId);
    }
  }
}
