import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { moveExactDirectoryNoReplace } from './exact-directory-move';
import { GENERATED_BANK_LIMITS } from './generated-output-bank';
import { evidenceHash } from './generated-output-retirement';
import { assertGeneratedOutputClaimsReleased, generatedOutputOwner, readGeneratedOutputResource, withGeneratedOutputExclusion,
  type GeneratedOutputResource } from './generated-output-state';
import { validateGeneratedOutputResource } from './generated-output-validation';
import { captureLegacyOutputEntries, verifyLegacyOutputEntries, type LegacyOutputEntry } from './legacy-output-inventory';
import { assertOutputMaintenanceOutside, assertOutputMovementReleased, assertOutputStopped } from './legacy-output-parking';
import { assertLinkedGitBuildCustody } from './linked-git-build-custody';

export interface FailedPrebuildPark {
  schema: 'o8/failed-prebuild-park/v1';
  operationId: string;
  state: 'prepared' | 'parked';
  version: number;
  resource: GeneratedOutputResource;
  retainedPath: string;
  intent: string;
  evidence: Array<{ path: string; sha256: string }>;
  entries: LegacyOutputEntry[];
  retainedBytes: number;
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function terminal(resource: GeneratedOutputResource): void {
  validateGeneratedOutputResource(resource);
  if (resource.state !== 'failed-held' || resource.owner || !resource.creationAuthority?.linkedGit
    || !resource.output || resource.bank || resource.bankCapture || resource.adoption || resource.recovery
    || resource.retirement || resource.disposal || resource.attempt?.mode !== 'build'
    || !resource.attempt.children.length || resource.attempt.children.some(child => !child.identity
      || !child.observedClosed || (child.exitCode === null && child.signal === null))) {
    throw new Error('Failed prebuild preservation requires complete terminal prebuild authority.');
  }
}

export function readFailedPrebuildPark(operationId: string): FailedPrebuildPark {
  if (!uuid.test(operationId)) throw new Error('Select an exact failed-prebuild operation UUID.');
  const row = getSqlite().prepare('SELECT * FROM workspace_failed_prebuild_parks WHERE operation_id = ?')
    .get(operationId) as { payload_json: string; resource_id: string; workspace_path: string; state: string; version: number } | undefined;
  if (!row || Buffer.byteLength(row.payload_json) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Failed prebuild journal is absent or oversized.');
  const record = JSON.parse(row.payload_json) as FailedPrebuildPark;
  terminal(record.resource);
  if (record.schema !== 'o8/failed-prebuild-park/v1' || record.operationId !== operationId
    || !['prepared', 'parked'].includes(record.state) || record.state !== row.state
    || record.version !== row.version || record.version !== (record.state === 'prepared' ? 1 : 2)
    || record.resource.resourceId !== row.resource_id || record.resource.workspace.canonicalPath !== row.workspace_path
    || record.retainedPath !== path.join(row.workspace_path, `.o8-retained-prebuild-${operationId}`)
    || !record.intent.trim() || record.intent.length > 4096 || record.evidence.length < 2 || record.evidence.length > 16
    || record.entries.length < 1 || record.entries.length > GENERATED_BANK_LIMITS.entries
    || record.retainedBytes !== record.entries.reduce((sum, entry) => sum + entry.bytes, 0)) {
    throw new Error('Failed prebuild journal authority is invalid.');
  }
  return record;
}

/** The original failed payload stays byte-for-byte intact; only its namespace index is released. */
export function retainedFailedPrebuild(workspacePath: string): FailedPrebuildPark | null {
  const row = getSqlite().prepare(`SELECT resource_id, retained_operation_id FROM workspace_generated_outputs
    WHERE workspace_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(workspacePath) as { resource_id: string; retained_operation_id: string | null } | undefined;
  if (!row?.retained_operation_id) return null;
  const record = readFailedPrebuildPark(row.retained_operation_id);
  if (record.state !== 'parked' || record.resource.resourceId !== row.resource_id
    || !same(readGeneratedOutputResource(row.resource_id), record.resource)) {
    throw new Error('Retained failed prebuild lost its original producer history.');
  }
  return record;
}

async function present(candidate: string) {
  return lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}

async function verify(record: FailedPrebuildPark, candidate: string, freshAdmission = false): Promise<void> {
  const resource = record.resource; const workspace = resource.workspace; const output = resource.output!;
  if (!same(readGeneratedOutputResource(resource.resourceId), resource)) throw new Error('Failed prebuild history changed.');
  await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
  if (await generatedOutputOwner(workspace)) throw new Error('Failed prebuild acquired a containing manager owner.');
  await assertLinkedGitBuildCustody(workspace, resource.creationAuthority!.linkedGit);
  assertOutputMovementReleased(workspace, output, record.retainedPath);
  for (const evidence of record.evidence) {
    if (await realpath(evidence.path) !== evidence.path || await evidenceHash(evidence.path) !== evidence.sha256) {
      throw new Error('Failed prebuild retained evidence changed.');
    }
  }
  // Conservative PID absence also refuses reused or unprovable process identities.
  for (const pid of new Set([resource.creationAuthority!.pid, resource.attempt!.ownerPid,
    ...resource.attempt!.children.map(child => child.pid)])) {
    if ((await probeMetadataLockProcessIdentity(pid)).state !== 'absent') throw new Error('Failed prebuild producer is live or unknown.');
  }
  // Fresh prebuild already owns the workspace exclusion and may run from its cwd.
  // Its predecessor's retained directory must still have no filesystem users.
  const probeRoot = freshAdmission ? { ...workspace, canonicalPath: candidate } : workspace;
  await assertOutputStopped(probeRoot, candidate);
  await verifyLegacyOutputEntries({ workspace, entries: record.entries, candidate: { ...output, canonicalPath: candidate } });
  await assertOutputStopped(probeRoot, candidate);
  await assertLinkedGitBuildCustody(workspace, resource.creationAuthority!.linkedGit);
  assertOutputMovementReleased(workspace, output, record.retainedPath);
}

/** Called under the same exclusion before a fresh generation can reserve .next. */
export async function verifyRetainedFailedPrebuild(record: FailedPrebuildPark, freshAdmission = false): Promise<void> {
  if (record.state !== 'parked') throw new Error('Failed prebuild preservation has not completed.');
  await verify(record, record.retainedPath, freshAdmission);
}

async function finish(record: FailedPrebuildPark): Promise<FailedPrebuildPark> {
  const resource = record.resource; const output = resource.output!;
  const original = await present(output.canonicalPath); const moved = await present(record.retainedPath);
  const exact = (stat: NonNullable<typeof original>) => stat.isDirectory() && !stat.isSymbolicLink()
    && stat.dev === output.device && stat.ino === output.inode;
  if ((original && moved) || (!original && !moved) || (original && !exact(original)) || (moved && !exact(moved))) {
    throw new Error('Failed prebuild source/destination is occupied, replaced or ambiguous.');
  }
  await verify(record, original ? output.canonicalPath : record.retainedPath);
  if (!same(readFailedPrebuildPark(record.operationId), record)) throw new Error('Failed prebuild journal changed.');
  if (original) await moveExactDirectoryNoReplace(resource.workspace, output.canonicalPath, record.retainedPath, output);
  if (await present(output.canonicalPath)) throw new Error('Failed prebuild source namespace returned.');
  await verify(record, record.retainedPath);
  if (await present(output.canonicalPath)) throw new Error('Failed prebuild source namespace returned after verification.');
  const next = { ...record, state: 'parked' as const, version: 2 };
  getSqlite().transaction(() => {
    assertOutputMovementReleased(resource.workspace, output, record.retainedPath);
    const journal = getSqlite().prepare(`UPDATE workspace_failed_prebuild_parks SET state = 'parked', version = 2, payload_json = ?
      WHERE operation_id = ? AND state = 'prepared' AND version = 1 AND payload_json = ?`)
      .run(JSON.stringify(next), record.operationId, JSON.stringify(record));
    const owner = getSqlite().prepare(`UPDATE workspace_generated_outputs SET retained_operation_id = ?
      WHERE resource_id = ? AND retained_operation_id IS NULL AND version = ? AND payload_json = ?`)
      .run(record.operationId, resource.resourceId, resource.version, JSON.stringify(resource));
    if (journal.changes !== 1 || owner.changes !== 1) throw new Error('Failed prebuild preservation lost its trusted CAS.');
  }).immediate();
  return readFailedPrebuildPark(record.operationId);
}

export async function parkFailedPrebuild(input: { resourceId: string; intent: string; evidencePaths: string[] }): Promise<FailedPrebuildPark> {
  const resource = readGeneratedOutputResource(input.resourceId);
  if (!resource) throw new Error('Failed prebuild resource is absent.');
  terminal(resource); assertOutputMaintenanceOutside(resource.workspace);
  if (!input.intent.trim() || input.intent.length > 4096 || input.evidencePaths.length < 2 || input.evidencePaths.length > 16) {
    throw new Error('Failed prebuild parking requires bounded intent and at least two retained evidence files.');
  }
  return withGeneratedOutputExclusion(resource.workspace, undefined, async () => {
    const prior = getSqlite().prepare('SELECT operation_id FROM workspace_failed_prebuild_parks WHERE resource_id = ?')
      .get(resource.resourceId) as { operation_id: string } | undefined;
    if (prior) throw new Error(`Failed prebuild already has preservation operation ${prior.operation_id}; use resume-failed-prebuild.`);
    assertGeneratedOutputClaimsReleased(resource.workspace);
    const workspace = resource.workspace; const output = resource.output!;
    const operationId = randomUUID(); const retainedPath = path.join(workspace.canonicalPath, `.o8-retained-prebuild-${operationId}`);
    if (await present(retainedPath)) throw new Error('Failed prebuild destination is occupied.');
    const evidence = [];
    for (const value of input.evidencePaths) {
      const selected = path.resolve(value);
      if (await realpath(selected) !== selected || selected === workspace.canonicalPath || selected.startsWith(workspace.canonicalPath + path.sep)) {
        throw new Error('Failed prebuild evidence must be unredirected and outside the checkout.');
      }
      evidence.push({ path: selected, sha256: await evidenceHash(selected) });
    }
    if (new Set(evidence.map(item => item.path)).size !== evidence.length) throw new Error('Failed prebuild evidence files must be distinct.');
    const entries = await captureLegacyOutputEntries({ workspace, candidate: output });
    const record: FailedPrebuildPark = { schema: 'o8/failed-prebuild-park/v1', operationId, state: 'prepared', version: 1,
      resource, retainedPath, intent: input.intent, evidence, entries, retainedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
    if (Buffer.byteLength(JSON.stringify(record)) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Failed prebuild journal exceeds its bound.');
    await verify(record, output.canonicalPath);
    getSqlite().transaction(() => {
      if (!same(readGeneratedOutputResource(resource.resourceId), resource)) throw new Error('Failed prebuild history changed.');
      assertOutputMovementReleased(workspace, output, retainedPath);
      const count = getSqlite().prepare('SELECT COUNT(*) AS count FROM workspace_failed_prebuild_parks WHERE workspace_path = ?')
        .get(workspace.canonicalPath) as { count: number };
      if (count.count >= 16) throw new Error('Failed prebuild preservation history reached its bound.');
      getSqlite().prepare(`INSERT INTO workspace_failed_prebuild_parks
        (operation_id, resource_id, workspace_path, state, payload_json, version) VALUES (?, ?, ?, 'prepared', ?, 1)`)
        .run(operationId, resource.resourceId, workspace.canonicalPath, JSON.stringify(record));
    }).immediate();
    return finish(record);
  }, { requireExistingStore: true });
}

export async function resumeFailedPrebuild(operationId: string): Promise<FailedPrebuildPark> {
  const initial = readFailedPrebuildPark(operationId); assertOutputMaintenanceOutside(initial.resource.workspace);
  return withGeneratedOutputExclusion(initial.resource.workspace, undefined, async () => {
    const record = readFailedPrebuildPark(operationId);
    if (record.state === 'prepared') return finish(record);
    // Completed replay checks retained bytes without touching a newer generation.
    await verifyRetainedFailedPrebuild(record);
    return record;
  }, { requireExistingStore: true });
}
