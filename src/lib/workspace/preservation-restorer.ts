import { createHash } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { getWorkspaceSnapshot } from '@/lib/worktree/snapshot-state';
import { inspectArtifactRestoreRevision, restoreIgnoredArtifacts, type ArtifactRestoreEvent, type ArtifactRestoreFileReceipt } from './ignored-artifact-io';
import { readWorkspacePreservation } from './preservation-store';
import { probeOwnedSessionProcessQuiescence } from './process-probes';
import { resolveMaterializedRecoveryTarget } from './recovery-target';
import { acquireWorkspaceRetentionHold, getWorkspaceRetentionHold } from './retention-holds';
import { getWorkspaceRetirementPreservationId } from './workspace-materialization-retirement';

interface RestoreRow {
  restore_id: string;
  preservation_id: string;
  repository_uuid: string;
  target_packet_id: string;
  target_lane_id: string;
  workspace_path: string;
  source_device: number;
  source_inode: number;
  selection_sha256: string;
  state: 'preparing' | 'complete';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function inspectRetiredWorkspacePreservation(repositoryUuid: string, packetId: string) {
  const snapshot = getWorkspaceSnapshot(repositoryUuid, packetId);
  if (!snapshot || snapshot.state !== 'retired') throw new Error('Recovery requires a retired source owner journal.');
  const preservationId = getWorkspaceRetirementPreservationId(snapshot.originalPath);
  if (!preservationId) throw new Error('The retired source has no verified ignored-artifact preservation receipt.');
  const archive = await readWorkspacePreservation(preservationId);
  if (archive.payload.repositoryUuid !== repositoryUuid || archive.payload.packetId !== packetId
    || archive.payload.capture.headCommit !== snapshot.headCommit || archive.payload.capture.treeSha !== snapshot.treeSha) {
    throw new Error('Retired preservation differs from its immutable owner journal.');
  }
  return archive;
}

/** Restore selected private artifacts only into an exact owned, idle successor. */
export async function restoreWorkspacePreservation(input: {
  sourcePacketId: string;
  targetPacketId: string;
  clientMutationId: string;
  paths: string[];
}) {
  return withPacketLifecycleMutationLock(input.targetPacketId, async ({ contendedByLiveIntent }) => {
    if (contendedByLiveIntent) throw new Error('Another lifecycle intent ran first; retry artifact recovery after its outcome is visible.');
    return restoreIntoLockedSuccessor(input);
  });
}

async function restoreIntoLockedSuccessor(input: {
  sourcePacketId: string;
  targetPacketId: string;
  clientMutationId: string;
  paths: string[];
}) {
  const target = await resolveMaterializedRecoveryTarget(input.targetPacketId);
  if (input.sourcePacketId === input.targetPacketId || !target.lane.sessionKey) {
    throw new Error('Recovery needs a different owned successor with a persisted session identity.');
  }
  const { payload, receipt } = await inspectRetiredWorkspacePreservation(target.repo.id, input.sourcePacketId);
  const selections = [...new Set(input.paths)].sort();
  if (!selections.length || selections.length > 100 || selections.some((entry) => (
    !entry || entry.length > 1_024 || entry.startsWith('/') || entry.includes('\\')
    || entry.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  ))) throw new Error('Select bounded safe relative artifact paths.');
  if (selections.some((selection) => !payload.capture.entries.some((entry) => entry.path === selection))) {
    throw new Error('A selected artifact is absent from the verified archive.');
  }
  const entries = payload.capture.entries.filter((entry) => selections.some((selection) => (
    entry.path === selection || entry.path.startsWith(selection + '/')
    || (entry.kind === 'directory' && selection.startsWith(entry.path + '/'))
  )));
  const capture = {
    ...payload.capture,
    entries,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
  const holdId = 'restore:' + input.clientMutationId;
  const existingHold = getWorkspaceRetentionHold(target.identity.canonicalPath, target.identity);
  if (existingHold && (existingHold.repositoryUuid !== target.repo.id
    || existingHold.packetId !== input.targetPacketId || existingHold.laneId !== target.lane.id)) {
    throw new Error('The successor is retained by a different exact owner.');
  }
  const hold = existingHold ?? acquireWorkspaceRetentionHold({
    repositoryPath: target.repo.localPath, repositoryUuid: target.repo.id,
    worktreeId: target.metadata.id, packetId: input.targetPacketId, laneId: target.lane.id,
    identity: target.identity, holdId,
    reason: 'Recovered artifacts remain retained until the operator explicitly releases this hold.',
  });
  const processReceipt = await probeOwnedSessionProcessQuiescence(target.lane.sessionKey, target.identity.canonicalPath);
  if (processReceipt.state !== 'quiescent') {
    throw new Error('The successor process is live or unknown; artifacts were not restored.');
  }
  const destinationRevision = await inspectArtifactRestoreRevision({
    workspacePath: target.identity.canonicalPath, identity: target.identity,
  });
  const sqlite = getSqlite();
  const selectionSha256 = hash(JSON.stringify({ paths: selections, ...destinationRevision }));
  const legacySelectionSha256 = hash(JSON.stringify(selections));
  const restoreId = hash(JSON.stringify({
    repositoryUuid: target.repo.id, targetPacketId: input.targetPacketId,
    clientMutationId: input.clientMutationId,
  }));
  sqlite.transaction(() => {
    const snapshot = getWorkspaceSnapshot(target.repo.id, input.targetPacketId);
    if (snapshot && (snapshot.state !== 'materialized' || snapshot.laneId !== target.lane.id
      || snapshot.originalPath !== target.identity.canonicalPath)) {
      throw new Error('The successor lifecycle is unavailable or belongs to another materialization.');
    }
    const concurrent = sqlite.prepare(`
      SELECT restore_id FROM workspace_artifact_restores
      WHERE workspace_path = ? AND source_device = ? AND source_inode = ?
        AND state = 'preparing' AND restore_id != ? LIMIT 1
    `).get(target.identity.canonicalPath, target.identity.device, target.identity.inode, restoreId);
    if (concurrent) throw new Error('Another artifact recovery owns this successor; resume that receipt first.');
    const now = Date.now();
    sqlite.prepare(`
      INSERT OR IGNORE INTO workspace_artifact_restores (
        restore_id, preservation_id, repository_uuid, target_packet_id, target_lane_id,
        workspace_path, source_device, source_inode, selection_sha256, state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preparing', ?, ?)
    `).run(
      restoreId, receipt.preservationId, target.repo.id, input.targetPacketId, target.lane.id,
      target.identity.canonicalPath, target.identity.device, target.identity.inode,
      selectionSha256, now, now,
    );
    const row = sqlite.prepare('SELECT * FROM workspace_artifact_restores WHERE restore_id = ?')
      .get(restoreId) as RestoreRow | undefined;
    if (!row || row.preservation_id !== receipt.preservationId || row.repository_uuid !== target.repo.id
      || row.target_packet_id !== input.targetPacketId || row.target_lane_id !== target.lane.id
      || row.workspace_path !== target.identity.canonicalPath || row.source_device !== target.identity.device
      || row.source_inode !== target.identity.inode) {
      throw new Error('Artifact recovery conflicts with its persisted target or selection.');
    }
    if (row.selection_sha256 === legacySelectionSha256) {
      const published = sqlite.prepare('SELECT 1 FROM workspace_artifact_restore_files WHERE restore_id = ? LIMIT 1')
        .get(restoreId);
      // Earlier writers only accepted the source revision. Empty interrupted
      // intents can bind the successor; published receipts retain that check.
      if ((row.state !== 'preparing' || published)
        && (destinationRevision.headCommit !== payload.capture.headCommit
          || destinationRevision.treeSha !== payload.capture.treeSha)) {
        throw new Error('Earlier artifact recovery is bound to the retired source revision.');
      }
      sqlite.prepare('UPDATE workspace_artifact_restores SET selection_sha256 = ? WHERE restore_id = ? AND selection_sha256 = ?')
        .run(selectionSha256, restoreId, legacySelectionSha256);
    } else if (row.selection_sha256 !== selectionSha256) {
      throw new Error('Artifact recovery conflicts with its persisted target revision or selection.');
    }
  }).immediate();
  const ownedFiles = sqlite.prepare(`
    SELECT relative_path AS path, device, inode, phase FROM workspace_artifact_restore_files WHERE restore_id = ?
  `).all(restoreId) as ArtifactRestoreFileReceipt[];
  const expectedEntries = new Map(entries.filter((entry) => entry.kind === 'file').map((entry) => [entry.path, entry]));
  const onReceipt = (event: ArtifactRestoreEvent) => {
    const expected = expectedEntries.get(event.path);
    if (!expected || expected.sha256 !== event.sha256 || expected.bytes !== event.bytes
      || !Number.isSafeInteger(event.device) || !Number.isSafeInteger(event.inode)
      || (event.phase !== 'prepared' && event.phase !== 'complete')) {
      throw new Error('Artifact write returned an invalid ownership receipt.');
    }
    sqlite.transaction(() => {
      const prior = sqlite.prepare(`
        SELECT relative_path AS path, device, inode, phase FROM workspace_artifact_restore_files
        WHERE restore_id = ? AND relative_path = ?
      `).get(restoreId, event.path) as ArtifactRestoreFileReceipt | undefined;
      if (prior && (prior.device !== event.device || prior.inode !== event.inode
        || (prior.phase === 'complete' && event.phase !== 'complete'))) {
        throw new Error('Artifact ownership receipt changed or attempted to go backwards.');
      }
      if (!prior && event.phase !== 'prepared') throw new Error('Artifact completion has no prepared file receipt.');
      sqlite.prepare(`
        INSERT INTO workspace_artifact_restore_files (
          restore_id, relative_path, device, inode, phase, sha256, bytes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(restore_id, relative_path) DO UPDATE SET phase = excluded.phase
      `).run(restoreId, event.path, event.device, event.inode, event.phase, event.sha256, event.bytes);
    }).immediate();
  };
  const result = await restoreIgnoredArtifacts({
    workspacePath: target.identity.canonicalPath, identity: target.identity,
    capture, destinationRevision, ownedFiles, onReceipt,
  });
  const completed = sqlite.prepare(`
    SELECT COUNT(*) AS total FROM workspace_artifact_restore_files WHERE restore_id = ? AND phase = 'complete'
  `).get(restoreId) as { total: number };
  if (completed.total !== result.restoredFiles) throw new Error('Artifact recovery did not complete every selected file receipt.');
  sqlite.prepare(`
    UPDATE workspace_artifact_restores SET state = 'complete', restored_files = ?, restored_bytes = ?, updated_at = ?
    WHERE restore_id = ? AND preservation_id = ?
  `).run(result.restoredFiles, result.bytes, Date.now(), restoreId, receipt.preservationId);
  return {
    schema: 'o8/workspace-artifact-recovery/v1',
    sourcePacketId: input.sourcePacketId, targetPacketId: input.targetPacketId,
    preservationId: receipt.preservationId, manifestSha256: receipt.manifestSha256,
    handoffSha256: receipt.handoffSha256, restoredFiles: result.restoredFiles,
    restoredBytes: result.bytes, paths: selections, restoreId, holdId: hold.holdId,
    retained: true,
    targetHeadCommit: destinationRevision.headCommit, targetTreeSha: destinationRevision.treeSha,
  };
}
