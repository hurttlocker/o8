import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { readProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureLinkedGitBuildCustody, assertLinkedGitBuildCustody, validateLinkedGitBuildCustody,
  type LinkedGitBuildCustody } from './linked-git-build-custody';
import { captureGeneratedOutputEntries, verifyGeneratedOutputEntries, GENERATED_BANK_LIMITS,
  type GeneratedOutputContentEntry } from './generated-output-bank';
import { generatedOutputOwner, withGeneratedOutputExclusion } from './generated-output-state';
import { evidenceHash } from './generated-output-retirement';
import { getWorkspaceRetentionHold } from './retention-holds';
import { moveExactDirectoryNoReplace } from './exact-directory-move';

type State = 'prepared' | 'parked' | 'restoring' | 'restored';
export interface LegacyOutputPark {
  schema: 'o8/retained-legacy-output/v1';
  operationId: string;
  state: State;
  version: number;
  workspace: WorktreeMaterializationIdentity;
  output: WorktreeMaterializationIdentity;
  originalPath: string;
  retainedPath: string;
  custody: LinkedGitBuildCustody;
  intent: string;
  evidence: Array<{ path: string; sha256: string }>;
  entries: GeneratedOutputContentEntry[];
  contentDigest: string;
  retainedBytes: number;
  createdAt: number;
  updatedAt: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function validate(value: LegacyOutputPark): void {
  if (value.schema !== 'o8/retained-legacy-output/v1' || !uuid.test(value.operationId)
    || !['prepared', 'parked', 'restoring', 'restored'].includes(value.state)
    || value.originalPath !== path.join(value.workspace.canonicalPath, '.next')
    || value.retainedPath !== path.join(value.workspace.canonicalPath, `.o8-retained-legacy-${value.operationId}`)
    || value.output.canonicalPath !== value.originalPath || value.output.device !== value.workspace.device
    || !Number.isSafeInteger(value.version) || value.version < 1 || !value.intent.trim() || value.intent.length > 4096
    || value.entries.length < 1 || value.entries.length > GENERATED_BANK_LIMITS.entries
    || value.contentDigest !== digest(value.entries) || value.evidence.length < 2 || value.evidence.length > 16
    || Buffer.byteLength(JSON.stringify(value)) > GENERATED_BANK_LIMITS.manifestBytes) {
    throw new Error('Legacy parking journal has invalid authority.');
  }
  validateLinkedGitBuildCustody(value.custody);
}

export function readLegacyOutputPark(operationId: string): LegacyOutputPark {
  if (!uuid.test(operationId)) throw new Error('Select an exact legacy operation UUID.');
  const row = getSqlite().prepare('SELECT * FROM workspace_legacy_output_parks WHERE operation_id = ?')
    .get(operationId) as { payload_json: string; state: State; version: number; workspace_path: string;
      retained_path: string; source_device: number; source_inode: number } | undefined;
  if (!row || Buffer.byteLength(row.payload_json) > GENERATED_BANK_LIMITS.manifestBytes) throw new Error('Legacy operation is absent or oversized.');
  const value = JSON.parse(row.payload_json) as LegacyOutputPark;
  validate(value);
  if (value.operationId !== operationId || value.state !== row.state || value.version !== row.version
    || value.workspace.canonicalPath !== row.workspace_path || value.retainedPath !== row.retained_path
    || value.output.device !== row.source_device || value.output.inode !== row.source_inode) throw new Error('Legacy journal indexes disagree.');
  return value;
}

function transition(previous: LegacyOutputPark, state: State): LegacyOutputPark {
  const next = { ...previous, state, version: previous.version + 1, updatedAt: Date.now() };
  const allowed = { prepared: 'parked', parked: 'restoring', restoring: 'restored', restored: null };
  if (allowed[previous.state] !== state) throw new Error('Invalid legacy journal transition.');
  validate(next);
  const changed = getSqlite().prepare(`UPDATE workspace_legacy_output_parks SET state = ?, payload_json = ?, version = ?
    WHERE operation_id = ? AND state = ? AND version = ? AND payload_json = ?`)
    .run(state, JSON.stringify(next), next.version, previous.operationId, previous.state, previous.version, JSON.stringify(previous));
  if (changed.changes !== 1) throw new Error('Legacy journal changed concurrently.');
  return readLegacyOutputPark(next.operationId);
}

function outside(workspace: WorktreeMaterializationIdentity): void {
  const cwd = path.resolve(process.cwd());
  if (cwd === workspace.canonicalPath || cwd.startsWith(workspace.canonicalPath + path.sep)) {
    throw new Error('Legacy maintenance must run outside its containing workspace.');
  }
}
async function present(candidate: string) {
  return lstat(candidate).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
}
function noGenerations(workspace: string): void {
  if (getSqlite().prepare('SELECT resource_id FROM workspace_generated_outputs WHERE workspace_path = ? LIMIT 1').get(workspace)) {
    throw new Error('Legacy parking/restoration refuses registered output generations.');
  }
}
function holdsAndClaims(workspace: WorktreeMaterializationIdentity, output: WorktreeMaterializationIdentity,
  retainedPath: string): void {
  // This operation owns its intrinsic legacy retention, never an independently acquired hold.
  for (const selected of [workspace.canonicalPath, output.canonicalPath, retainedPath]) {
    if (getWorkspaceRetentionHold(selected, selected === workspace.canonicalPath ? workspace : output)) {
      throw new Error('Legacy movement is blocked by a persisted retention hold.');
    }
  }
  const paths = [workspace.canonicalPath, output.canonicalPath, retainedPath];
  for (const selected of paths) {
    if (getSqlite().prepare(`SELECT operation_id FROM workspace_exact_claims WHERE expected_path = ? OR source_path = ?
      OR claim_path = ? OR parent_canonical_path = ? OR (source_device = ? AND source_inode = ?) LIMIT 1`)
      .get(selected, selected, selected, selected, output.device, output.inode)) throw new Error('Legacy movement conflicts with an exact claim.');
  }
  if (getSqlite().prepare(`SELECT packet_id FROM workspace_snapshots WHERE original_path = ? AND state != 'materialized' LIMIT 1`)
    .get(workspace.canonicalPath)) throw new Error('Containing workspace is changing materialization.');
}

async function stopped(workspace: WorktreeMaterializationIdentity, candidate: string): Promise<void> {
  const snapshot = await readProcessCwdSnapshot({ forceRefresh: true });
  if ((await probeLiveProcessInside(workspace.canonicalPath, { snapshot })).status !== 'clear') {
    throw new Error('Legacy output has live or inconclusive process observations.');
  }
  for (const leaf of ['lock', 'dev/lock']) {
    const file = path.join(candidate, leaf); const entry = await present(file);
    if (!entry) continue;
    const before = await evidenceHash(file);
    if (entry.size > 4096) throw new Error('Legacy producer lock is oversized.');
    let lock: { pid?: number };
    const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.alloc(4097); const captured = await descriptor.read(buffer, 0, buffer.length, 0);
      if (captured.bytesRead > 4096) throw new Error('Lock grew.');
      lock = JSON.parse(buffer.subarray(0, captured.bytesRead).toString('utf8'));
    } catch { throw new Error('Legacy producer lock is inconclusive.'); } finally { await descriptor.close(); }
    if (!Number.isSafeInteger(lock.pid) || lock.pid! <= 0
      || (await probeMetadataLockProcessIdentity(lock.pid!)).state !== 'absent') {
      throw new Error('Legacy producer lock is live or inconclusive.');
    }
    if (await evidenceHash(file) !== before) throw new Error('Legacy producer lock changed.');
  }
}
async function verify(record: LegacyOutputPark, candidate: string): Promise<void> {
  outside(record.workspace);
  await assertWorktreeMaterializationIdentity(record.workspace.canonicalPath, record.workspace);
  await assertLinkedGitBuildCustody(record.workspace, record.custody);
  if (await generatedOutputOwner(record.workspace)) throw new Error('Legacy parking is not manager-owned maintenance.');
  noGenerations(record.workspace.canonicalPath);
  holdsAndClaims(record.workspace, record.output, record.retainedPath);
  for (const evidence of record.evidence) {
    if (await realpath(evidence.path) !== evidence.path || await evidenceHash(evidence.path) !== evidence.sha256) {
      throw new Error('Legacy evidence changed or was redirected.');
    }
  }
  await stopped(record.workspace, candidate);
  await verifyGeneratedOutputEntries({ entries: record.entries, candidate: { ...record.output, canonicalPath: candidate } });
  await stopped(record.workspace, candidate);
  await assertLinkedGitBuildCustody(record.workspace, record.custody);
  holdsAndClaims(record.workspace, record.output, record.retainedPath);
}
async function finish(record: LegacyOutputPark): Promise<LegacyOutputPark> {
  const parking = record.state === 'prepared';
  if (!parking && record.state !== 'restoring') throw new Error('Legacy operation has no pending move.');
  const from = parking ? record.originalPath : record.retainedPath;
  const to = parking ? record.retainedPath : record.originalPath;
  const original = await present(from); const moved = await present(to);
  const same = (stat: NonNullable<typeof original>) => stat.isDirectory() && !stat.isSymbolicLink()
    && stat.dev === record.output.device && stat.ino === record.output.inode;
  if ((original && moved) || (!original && !moved) || (original && !same(original)) || (moved && !same(moved))) {
    throw new Error('Legacy source/destination is occupied, replaced or ambiguous.');
  }
  await verify(record, original ? from : to);
  if (JSON.stringify(readLegacyOutputPark(record.operationId)) !== JSON.stringify(record)) throw new Error('Legacy journal changed.');
  if (original) await moveExactDirectoryNoReplace(record.workspace, from, to, record.output);
  // A killed/failed helper leaves pending intent. Only a later exact observation may complete it.
  if (await present(from)) throw new Error('Legacy source namespace returned.');
  await verify(record, to);
  if (await present(from)) throw new Error('Legacy source namespace returned after verification.');
  return transition(record, parking ? 'parked' : 'restored');
}

export async function parkLegacyOutput(input: { workspacePath: string; intent: string; evidencePaths: string[] }): Promise<LegacyOutputPark> {
  if (!input.intent.trim() || input.intent.length > 4096 || input.evidencePaths.length < 2 || input.evidencePaths.length > 16) {
    throw new Error('Legacy parking requires bounded intent and at least two retained evidence files.');
  }
  const workspace = await captureWorktreeMaterializationIdentity(input.workspacePath); outside(workspace);
  const custody = await captureLinkedGitBuildCustody(workspace);
  if (!custody || await generatedOutputOwner(workspace)) throw new Error('Legacy parking requires an externally managed linked checkout.');
  return withGeneratedOutputExclusion(workspace, undefined, async () => {
    noGenerations(workspace.canonicalPath);
    const output = await captureWorktreeMaterializationIdentity(path.join(workspace.canonicalPath, '.next'));
    const operationId = randomUUID(); const retainedPath = path.join(workspace.canonicalPath, `.o8-retained-legacy-${operationId}`);
    if (await present(retainedPath)) throw new Error('Legacy destination is occupied.');
    holdsAndClaims(workspace, output, retainedPath); await stopped(workspace, output.canonicalPath);
    const evidence = [];
    for (const value of input.evidencePaths) {
      const selected = path.resolve(value);
      if (await realpath(selected) !== selected) throw new Error('Legacy evidence path is redirected.');
      if (selected === workspace.canonicalPath || selected.startsWith(workspace.canonicalPath + path.sep)) throw new Error('Legacy evidence must be outside the checkout.');
      evidence.push({ path: selected, sha256: await evidenceHash(selected) });
    }
    if (new Set(evidence.map(value => value.path)).size !== evidence.length) throw new Error('Legacy evidence files must be distinct.');
    const entries = await captureGeneratedOutputEntries(output); const now = Date.now();
    const record: LegacyOutputPark = { schema: 'o8/retained-legacy-output/v1', operationId, state: 'prepared', version: 1,
      workspace, output, originalPath: output.canonicalPath, retainedPath, custody, intent: input.intent, evidence,
      entries, contentDigest: digest(entries), retainedBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), createdAt: now, updatedAt: now };
    validate(record); await verify(record, output.canonicalPath);
    getSqlite().transaction(() => {
      noGenerations(workspace.canonicalPath); holdsAndClaims(workspace, output, retainedPath);
      const count = getSqlite().prepare('SELECT COUNT(*) AS count FROM workspace_legacy_output_parks WHERE workspace_path = ?')
        .get(workspace.canonicalPath) as { count: number };
      if (count.count >= 16) throw new Error('Legacy parking history reached its bound.');
      getSqlite().prepare(`INSERT INTO workspace_legacy_output_parks
        (operation_id, workspace_path, retained_path, source_device, source_inode, state, payload_json, version)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, 1)`)
        .run(operationId, workspace.canonicalPath, retainedPath, output.device, output.inode, JSON.stringify(record));
    }).immediate();
    return finish(record);
  });
}

export async function continueLegacyOutputPark(operationId: string, restore = false): Promise<LegacyOutputPark> {
  const initial = readLegacyOutputPark(operationId); outside(initial.workspace);
  return withGeneratedOutputExclusion(initial.workspace, undefined, async () => {
    let record = readLegacyOutputPark(operationId);
    if (restore && record.state === 'prepared') throw new Error('Resume pending parking before restoration.');
    if (restore && record.state === 'parked') {
      if (await present(record.originalPath)) throw new Error('Legacy restore destination is occupied.');
      await verify(record, record.retainedPath);
      record = transition(record, 'restoring');
    }
    if (record.state === 'prepared' || record.state === 'restoring') return finish(record);
    // Terminal replay is observational and never invents another move.
    if (restore && record.state !== 'restored') throw new Error('Legacy restoration requires parked output.');
    const candidate = record.state === 'parked' ? record.retainedPath : record.originalPath;
    await assertWorktreeMaterializationIdentity(candidate, { ...record.output, canonicalPath: candidate });
    await verifyGeneratedOutputEntries({ entries: record.entries, candidate: { ...record.output, canonicalPath: candidate } });
    return record;
  });
}

export function listLegacyOutputParks(workspacePath: string): LegacyOutputPark[] {
  const rows = getSqlite().prepare('SELECT operation_id FROM workspace_legacy_output_parks WHERE workspace_path = ? ORDER BY rowid LIMIT 17')
    .all(path.resolve(workspacePath)) as Array<{ operation_id: string }>;
  if (rows.length > 16) throw new Error('Legacy parking history exceeds its bound.');
  return rows.map(row => readLegacyOutputPark(row.operation_id));
}
