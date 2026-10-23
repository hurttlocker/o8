import { createHash } from 'node:crypto';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { readFailedPrebuildPark } from './failed-prebuild-parking';
import { GENERATED_BANK_LIMITS } from './generated-output-bank';
import { readGeneratedOutputResource } from './generated-output-state';
import { readLegacyOutputPark } from './legacy-output-parking';
import type { LegacyOutputEntry } from './legacy-output-inventory';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const LIMIT = 50;
const sha256 = /^[a-f0-9]{64}$/;
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
  && !/[\x00-\x1f\x7f]/.test(value) && path.isAbsolute(value) && path.resolve(value) === value && path.parse(value).root !== value;
export type ParkedOutputKind = 'legacy' | 'failed-prebuild';

export function validParkedOutputSelection(kind: unknown, operationId: unknown): kind is ParkedOutputKind {
  return (kind === 'legacy' || kind === 'failed-prebuild') && typeof operationId === 'string' && uuid.test(operationId);
}

function bounded<T>(rows: T[]) {
  return { items: rows.slice(0, LIMIT), truncated: rows.length > LIMIT };
}

function recordedIdentity(value: WorktreeMaterializationIdentity) {
  if (!value || !absolute(value.canonicalPath) || !integer(value.device) || !integer(value.inode, 1)) {
    throw new Error('Parked directory identity is invalid.');
  }
}

function inventory(entries: LegacyOutputEntry[], recordedBytes: number, output: WorktreeMaterializationIdentity) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > GENERATED_BANK_LIMITS.entries) {
    throw new Error('Parked inventory exceeds its bounds.');
  }
  const seen = new Map<string, LegacyOutputEntry>();
  const links: Array<{ relative: string; rawTarget: string; ownership: 'link_node_only' }> = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.relative !== 'string' || entry.relative.length > 4096
      || (entry.relative !== '.' && (path.posix.isAbsolute(entry.relative)
        || entry.relative.split('/').some(part => !part || part === '.' || part === '..')))
      || entry.relative.split('/').length > 128
      || /[\\\x00-\x1f\x7f]/.test(entry.relative) || seen.has(entry.relative)
      || !['file', 'directory', 'symlink'].includes(entry.kind)
      || entry.device !== output.device || !integer(entry.inode, 1) || !integer(entry.mode) || entry.mode > 0o777
      || (entry.kind === 'directory' && (entry.bytes !== 0 || entry.sha256 !== null))
      || (entry.kind === 'file' && (typeof entry.sha256 !== 'string' || !sha256.test(entry.sha256)))
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Parked inventory is invalid.');
    seen.set(entry.relative, entry);
    bytes += entry.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > GENERATED_BANK_LIMITS.expandedBytes) throw new Error('Parked inventory bytes exceed their bound.');
    if (entry.kind === 'symlink') {
      const match = /^dev\/node_modules\/(?:(@[a-z0-9][a-z0-9._-]*)\/)?([a-z0-9][a-z0-9._-]*)-[a-f0-9]{16}$/.exec(entry.relative);
      const expected = match ? `${match[1] ? '../../../../' : '../../../'}node_modules/${match[1] ? `${match[1]}/` : ''}${match[2]}` : null;
      if (typeof entry.rawTarget !== 'string' || Buffer.byteLength(entry.rawTarget) > 4096
        || Buffer.byteLength(entry.rawTarget) !== entry.bytes || entry.rawTarget !== expected
        || entry.sha256 !== null) throw new Error('Parked link receipt is invalid.');
      links.push({ relative: entry.relative, rawTarget: entry.rawTarget, ownership: 'link_node_only' });
    }
  }
  const root = seen.get('.');
  if (root?.kind !== 'directory' || root.inode !== output.inode) throw new Error('Parked inventory lost its root identity.');
  for (const entry of entries) {
    if (entry.relative !== '.' && seen.get(path.posix.dirname(entry.relative))?.kind !== 'directory') {
      throw new Error('Parked inventory lost a containing directory.');
    }
  }
  if (bytes !== recordedBytes) throw new Error('Parked inventory byte receipts disagree.');
  return { inventory: { entries: entries.length, recordedBytes: bytes, byteMetric: 'inventory_entry_bytes', dependencyTargetsOwned: false },
    dependencies: { ...bounded(links), targetResolution: 'not_performed' } };
}

/** Recorded inventory only: this snapshot is never an approval or a deletion plan. */
export function previewParkedOutput(kind: ParkedOutputKind, operationId: string) {
  if (!validParkedOutputSelection(kind, operationId)) throw new Error('Select one exact parked operation kind and UUID.');
  const db = getSqlite();
  return db.transaction(() => {
    const legacy = kind === 'legacy' ? readLegacyOutputPark(operationId) : null;
    const failed = kind === 'failed-prebuild' ? readFailedPrebuildPark(operationId) : null;
    const record = legacy ?? failed!;
    if (record.state !== 'parked') throw new Error('Only a completed parked operation can be previewed.');
    const resource = failed?.resource;
    if (resource) {
      const current = readGeneratedOutputResource(resource.resourceId);
      const index = db.prepare('SELECT retained_operation_id FROM workspace_generated_outputs WHERE resource_id = ?')
        .get(resource.resourceId) as { retained_operation_id: string | null } | undefined;
      if (JSON.stringify(current) !== JSON.stringify(resource) || index?.retained_operation_id !== operationId) {
        throw new Error('Failed output no longer has its recorded parked binding.');
      }
    }
    const workspace = legacy?.workspace ?? resource!.workspace;
    const output = legacy?.output ?? resource!.output!;
    recordedIdentity(workspace);
    recordedIdentity(output);
    if (workspace.device !== output.device || workspace.inode === output.inode || !absolute(record.retainedPath)) {
      throw new Error('Parked output geometry is invalid.');
    }
    if (!Array.isArray(record.evidence) || record.evidence.length < 2 || record.evidence.length > 16
      || record.evidence.some(evidence => !evidence || !absolute(evidence.path)
        || typeof evidence.sha256 !== 'string' || !sha256.test(evidence.sha256)
        || evidence.path === workspace.canonicalPath || evidence.path.startsWith(workspace.canonicalPath + path.sep))
      || new Set(record.evidence.map(evidence => evidence.path)).size !== record.evidence.length) {
      throw new Error('Parked evidence receipts are invalid.');
    }
    const paths = [workspace.canonicalPath, output.canonicalPath, record.retainedPath];
    const holds = db.prepare(`SELECT hold_id AS holdId, workspace_path AS workspacePath, reason, version, held_at AS heldAt
      FROM workspace_retention_holds WHERE released_at IS NULL AND (workspace_path IN (?, ?, ?)
        OR (source_device = ? AND source_inode IN (?, ?))) ORDER BY hold_id LIMIT ?`)
      .all(...paths, workspace.device, workspace.inode, output.inode, LIMIT + 1);
    const claims = db.prepare(`SELECT operation_id AS operationId, kind, state, expected_path AS expectedPath
      FROM workspace_exact_claims WHERE expected_path IN (?, ?, ?) OR source_path IN (?, ?, ?)
        OR claim_path IN (?, ?, ?) OR parent_canonical_path IN (?, ?, ?)
        OR (source_device = ? AND source_inode IN (?, ?)) ORDER BY kind, operation_id LIMIT ?`)
      .all(...paths, ...paths, ...paths, ...paths, workspace.device, workspace.inode, output.inode, LIMIT + 1);
    const consumers = resource ? db.prepare(`SELECT resource_id AS resourceId, state, version FROM workspace_generated_outputs
      WHERE json_extract(payload_json, '$.continuedFrom.operationId') = ?
        AND json_extract(payload_json, '$.continuedFrom.resourceId') = ? ORDER BY resource_id LIMIT ?`)
      .all(operationId, resource.resourceId, LIMIT + 1) : [];
    const snapshot = {
      schema: 'o8/parked-output-disposition-preview/v1', kind, operationId, operationVersion: record.version,
      sourceRecordSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
      resourceId: resource?.resourceId ?? null, resourceVersion: resource?.version ?? null,
      workspace, output: { ...output, recordedOriginalPath: output.canonicalPath, retainedPath: record.retainedPath },
      producer: resource ? { outcome: 'terminal_failure', state: resource.state,
        children: resource.attempt!.children.map(({ pid, exitCode, signal, observedClosed }) => ({ pid, exitCode, signal, observedClosed })) }
        : { outcome: 'unknown', reason: 'Legacy parking has no recorded producer outcome.' },
      evidence: record.evidence.map(({ path: evidencePath, sha256 }) => ({ path: evidencePath, sha256 })),
      ...inventory(record.entries, record.retainedBytes, output),
      holds: bounded(holds), claims: bounded(claims),
      consumers: { ...bounded(consumers), coverage: 'recorded_continuations_only', otherConsumers: 'not_checked' },
      freshness: { filesystem: 'not_checked', processes: 'not_checked', evidence: 'recorded_only' },
      preservation: 'not_selected', executionSupported: false, removalScope: null, reclaimableBytes: null, reclaimedBytes: 0,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024) throw new Error('Parked preview exceeds its response bound.');
    return { ...snapshot, fingerprint: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex') };
  })();
}
