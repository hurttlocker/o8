import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { getSqlite } from '@/lib/db';
import { getLane, getLaneEvents } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { exactWorkspaceOwningLanes } from '@/lib/lane/workspace-ownership-query';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getOwnedSessionLifecycle } from '@/lib/runtimes/shared/owned-session-lifecycle';
import { archivedSessionPathForSurfaceId, assertArchivedWorkspaceSessionRestorable, ownedSessionRecordFingerprint } from '@/lib/runtimes/shared/owned-session/archive';
import { readOwnedSessionMetadata } from '@/lib/runtimes/shared/owned-session/metadata-read';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { readWorkspacePreservation } from '@/lib/workspace/preservation-store';
import { readExactManagedFinalization } from '@/lib/workspace/exact-managed-finalization-state';
import { completeExactManagedDirectoryRetirement } from '@/lib/workspace/exact-managed-directory-retirement';
import { exactSnapshot, getWorkspaceRetirementPreservationId, getWorkspaceRetirementAction } from '@/lib/workspace/workspace-materialization-retirement';
import { readExactWorkspaceClaim } from '@/lib/workspace/exact-workspace-claim-state';
import { readManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { probeOwnedSessionProcessQuiescence } from '@/lib/workspace/process-probes';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { canonicalRepoRoot, isManagedPacketWorktreeId } from '@/lib/worktree/root-layout';
import { assertOrphanProcessesAbsent, OrphanCloseRefusal, type OrphanRunIdentity } from './close-orphaned-process';

export interface OrphanCloseOwner {
  packetId: string;
  laneId: string;
  repositoryUuid: string;
  sourcePath: string;
  device: number;
  inode: number;
  fingerprint: string;
}
interface CloseContext { active: boolean; packetId: string; owners: Map<string, OrphanCloseOwner>; refusals: Map<string, string> }
const explicitClose = new AsyncLocalStorage<CloseContext>();

/** The caller already holds the packet lifecycle lock. Authority expires with this operation. */
export async function withOrphanCloseContext<T>(packetId: string, operation: () => Promise<T>, owner?: OrphanCloseOwner): Promise<T> {
  const current = explicitClose.getStore();
  if (current?.active && current.packetId === packetId) {
    if (owner && JSON.stringify(current.owners.get(owner.laneId)) !== JSON.stringify(owner)) refuse('durable orphan close authority changed');
    return operation();
  }
  const context: CloseContext = { active: true, packetId, owners: new Map(owner ? [[owner.laneId, owner]] : []), refusals: new Map() };
  try { return await explicitClose.run(context, operation); }
  finally { context.active = false; }
}

export function orphanCloseOwner(laneId: string): OrphanCloseOwner | null {
  const context = explicitClose.getStore();
  return context?.active ? context.owners.get(laneId) ?? null : null;
}

export function orphanCloseRefusal(laneId: string): string | undefined { return explicitClose.getStore()?.refusals.get(laneId); }

export function refuseOrphanClose(laneId: string, reason: string): never {
  const error = new OrphanCloseRefusal(reason);
  explicitClose.getStore()?.refusals.set(laneId, error.message);
  throw error;
}

function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function refuse(reason: string): never { throw new OrphanCloseRefusal(reason); }

/** All packet rows, including revoked and prepared rows, must correlate with this lane's exits. */
function missingSessionRuns(lane: Lane, sessionKey: string | null): OrphanRunIdentity[] {
  const rows = getSqlite().prepare(`SELECT lease_process_marker AS runId, lease_process_pid AS pid,
    lease_process_group_id AS processGroupId FROM worker_tokens
    WHERE packet_id = ? AND scope = 'local-packet' ORDER BY id LIMIT 17`).all(lane.packetId) as OrphanRunIdentity[];
  if (!rows.length || rows.length > 16) refuse('persisted run identity is missing or exceeds the 16-run bound');
  if (new Set(rows.map((row) => row.runId)).size !== rows.length) refuse('persisted run identity contains duplicate markers');
  const events = getLaneEvents(lane.id, 501);
  if (events.length > 500) refuse('lane run identity history is truncated');
  const exits = events.filter((event) => event.verb === 'runtime_process_exit');
  if (exits.length !== rows.length) refuse('persisted run identity does not cover every lane exit');
  for (const row of rows) {
    if (typeof row.runId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(row.runId)
      || !Number.isSafeInteger(row.pid) || row.pid <= 0
      || !Number.isSafeInteger(row.processGroupId) || row.processGroupId <= 0) refuse('persisted PID, marker or process group identity is incomplete');
    const matches = exits.filter((event) => event.payload.runId === row.runId);
    if (matches.length !== 1) refuse('persisted run identity has no unique terminal lane exit');
    const exit = matches[0]!;
    const surface = exit.payload.surfaceId;
    if (exit.actor !== 'system' || exit.payload.runtime !== lane.runtime
      || typeof surface !== 'string' || !surface.startsWith(`${lane.runtime}-owned:`)
      || (sessionKey && surface !== sessionKey) || exit.payload.runtimeOutcome !== 'finished'
      || exit.payload.classification !== 'clean-exit' || exit.payload.exitCode !== 0
      || exit.payload.signal !== null) refuse('persisted run identity has an uncertain session or terminal exit');
  }
  const lastExit = events.findLastIndex((event) => event.verb === 'runtime_process_exit');
  if (events.slice(lastExit + 1).some((event) => event.verb === 'attach_session'
    || (event.verb === 'status_change' && ['launching', 'running'].includes(String(event.payload.status))))) {
    refuse('a newer attach or launch invalidates persisted run identity');
  }
  return rows;
}

async function inspectOwner(laneId: string, candidatePath: string): Promise<OrphanCloseOwner | null> {
  try { return await inspectOwnerEvidence(laneId, candidatePath); }
  catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    refuse('persisted session or workspace ownership could not be read');
  }
}

async function inspectOwnerEvidence(laneId: string, candidatePath: string): Promise<OrphanCloseOwner | null> {
  const lane = getLane(laneId);
  if (!lane?.packetId || !lane.worktreePath || lane.ownership !== 'managed') return null;
  const repoPath = canonicalRepoRoot(lane.repoPath);
  const metadata = (await readWorktreeMetaSnapshot(repoPath))[path.basename(lane.worktreePath)];
  if (!metadata || !isManagedPacketWorktreeId(metadata.id, lane.packetId)) return null;
  const owners = exactWorkspaceOwningLanes(repoPath, lane.worktreePath, metadata);
  if (owners.length !== 1 || owners[0]?.id !== lane.id || metadata.status !== 'ready'
    || metadata.agentType !== lane.runtime || metadata.branchName !== lane.branch
    || (metadata.packetId && metadata.packetId !== lane.packetId)
    || (metadata.laneId && metadata.laneId !== lane.id)) refuse('managed lane, branch or worktree ownership is ambiguous');
  const sourcePath = path.join(await realpath(path.dirname(lane.worktreePath)), path.basename(lane.worktreePath));
  const identity = metadata.materializationIdentity;
  if (!identity || identity.canonicalPath !== sourcePath) refuse('exact worktree materialization identity is unavailable');
  if (lane.sessionKey && metadata.sessionKey && lane.sessionKey !== metadata.sessionKey) refuse('lane and worktree session identities disagree');
  const sessionKey = lane.sessionKey?.trim() || metadata.sessionKey?.trim() || null;
  await import('@/lib/runtimes');
  const lifecycle = sessionKey ? getOwnedSessionLifecycle(sessionKey) : null;
  if (sessionKey && (!lifecycle || lifecycle.runtimeId !== lane.runtime)) refuse('session runtime ownership is unavailable');
  const state = lifecycle && sessionKey ? await lifecycle.sessionState(sessionKey) : 'missing';
  if (state === 'active') return null;
  const repo = await findRepoByLocalPath(repoPath);
  if (!repo) refuse('repository registration is unavailable');
  let evidence: unknown;
  let runs: OrphanRunIdentity[];
  if (state === 'archived' && lifecycle && sessionKey) {
    const receipt = await lifecycle.getWorkspaceBinding?.(sessionKey);
    const archive = await archivedSessionPathForSurfaceId(lifecycle.resolveRoot(), sessionKey, lifecycle.surfaceIdPrefix);
    const record = archive ? await readOwnedSessionMetadata<OwnedSessionRecord>(path.join(archive, 'session.json')) : null;
    if (!receipt || !record || record.surfaceId !== sessionKey || record.laneId !== lane.id || record.packetId !== lane.packetId
      || path.join(await realpath(path.dirname(record.cwd)), path.basename(record.cwd)) !== sourcePath
      || record.runIdentityLedger?.version !== 1 || record.runIdentityLedger.complete !== true
      || record.runIdentityLedger.totalRuns !== record.recentRuns.length
      || ownedSessionRecordFingerprint(record) !== receipt.recordFingerprint
      || record.executionPolicy !== undefined || record.controlledTask || record.activeRun || record.detachedAt
      || receipt.surfaceId !== sessionKey || receipt.runtimeId !== lane.runtime || receipt.sessionState !== 'archived'
      || receipt.binding.packetId !== lane.packetId || receipt.binding.logicalWorkspaceId !== `packet:${lane.packetId}`
      || (receipt.binding.repositoryUuid !== null && receipt.binding.repositoryUuid !== repo.id)
      || path.join(await realpath(path.dirname(receipt.binding.cwd)), path.basename(receipt.binding.cwd)) !== sourcePath || !receipt.retainedRunsComplete
      || !receipt.retainedRunTotal || receipt.retainedRunTotal !== receipt.retainedRuns.length
      || receipt.retainedRuns.length > 16 || !receipt.recordFingerprint
      || record.recentRuns.some((run) => run.outcome !== 'finished' || !run.finishedAt
        || run.childExit?.code !== 0 || run.childExit.signal !== null || run.childExit.classification !== 'clean-exit')) {
      refuse('archived session binding or complete terminal run identity is uncertain');
    }
    await assertArchivedWorkspaceSessionRestorable(lifecycle.resolveRoot(), sessionKey, lifecycle.surfaceIdPrefix, receipt.recordFingerprint);
    // Native probing below also checks every retained PID/group/marker and open descriptor.
    runs = receipt.retainedRuns.map((run) => ({ runId: run.id, pid: run.pid, processGroupId: run.processGroupId! }));
    evidence = receipt;
  } else {
    runs = missingSessionRuns(lane, sessionKey);
    evidence = runs;
  }
  if (runs.some((run) => !Number.isSafeInteger(run.pid) || run.pid <= 0
    || !Number.isSafeInteger(run.processGroupId) || run.processGroupId <= 0
    || !/^[A-Za-z0-9._-]{1,160}$/.test(run.runId))) refuse('retained process identity is incomplete');
  await assertOrphanProcessesAbsent({ runtime: lane.runtime, runs, sourcePath, candidatePath });
  if (state === 'archived' && sessionKey) {
    // Native evidence names live holders before the aggregate owned-session proof.
    const process = await probeOwnedSessionProcessQuiescence(sessionKey, candidatePath, { allowArchivedRetirement: true });
    if (process.state !== 'quiescent') refuse(`archived run process proof is ${process.state}: ${process.reasons.slice(0, 3).join('; ')}`);
  }
  return { packetId: lane.packetId, laneId: lane.id, repositoryUuid: repo.id, sourcePath,
    device: identity.device, inode: identity.inode,
    fingerprint: digest([lane.id, lane.packetId, repo.id, lane.repoPath, lane.worktreePath, lane.branch,
      lane.runtime, lane.sessionKey, metadata, evidence]) };
}

/** Only the trusted exact-retirement ledger can authorize a missing-source retry. */
export function orphanCloseRetirement(lane: Lane) {
  try { return readOrphanCloseRetirement(lane); }
  catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    refuse('pending retirement authority ledger could not be read');
  }
}

function readOrphanCloseRetirement(lane: Lane) {
  if (!lane.worktreePath || !lane.packetId) return null;
  const claim = readExactWorkspaceClaim('managed-retirement', canonicalRepoRoot(lane.repoPath), path.basename(lane.worktreePath));
  if (!claim || claim.authority?.orphanCloseOwner === undefined) return null;
  const owner = readOrphanCloseOwner(claim.authority.orphanCloseOwner);
  if (owner.packetId !== lane.packetId || owner.laneId !== lane.id
    || owner.sourcePath !== claim.sourcePath || owner.device !== claim.sourceIdentity?.device
    || owner.inode !== claim.sourceIdentity?.inode) refuse('pending retirement has uncertain orphan close ownership');
  return { claim, owner };
}

async function absent(target: string): Promise<boolean> {
  try { await lstat(target); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

/** Completed retirement settles a close retry; it grants no new deletion authority. */
async function completedOrphanClose(target: Lane): Promise<boolean> {
  if (!target.worktreePath || !target.packetId) return false;
  const snapshot = exactSnapshot(target.worktreePath);
  if (snapshot?.state !== 'retired' || getWorkspaceRetirementAction(target.worktreePath) !== 'discard') return false;
  const lane = getLane(target.id);
  const repo = await findRepoByLocalPath(canonicalRepoRoot(target.repoPath));
  const preservationId = getWorkspaceRetirementPreservationId(target.worktreePath);
  if (!repo || !lane || lane.status !== 'archived' || lane.packetId !== target.packetId
    || snapshot.repositoryUuid !== repo.id || snapshot.packetId !== target.packetId
    || snapshot.laneId !== target.id || snapshot.branch !== target.branch || !preservationId
    || canonicalRepoRoot(lane.repoPath) !== canonicalRepoRoot(target.repoPath)
    || lane.runtime !== target.runtime || lane.branch !== target.branch
    || (lane.sessionKey && lane.sessionKey !== target.sessionKey)
    || (target.sessionKey && !snapshot.sessionIdentities.some((identity) => identity.kind === 'owned-session' && identity.identity === target.sessionKey))
    || (lane.worktreePath && path.join(await realpath(path.dirname(lane.worktreePath)), path.basename(lane.worktreePath)) !== snapshot.originalPath)) {
    refuse('completed retirement lane or preservation ownership is uncertain');
  }
  const { payload } = await readWorkspacePreservation(preservationId);
  if (payload.repositoryUuid !== repo.id || payload.packetId !== target.packetId || payload.laneId !== lane.id
    || payload.identity.canonicalPath !== snapshot.originalPath || payload.capture.headCommit !== snapshot.headCommit
    || payload.capture.treeSha !== snapshot.treeSha || payload.handoff.evidence.snapshotFingerprint !== snapshot.snapshotFingerprint
    || payload.handoff.evidence.snapshotGeneration !== snapshot.snapshotGeneration) refuse('completed retirement preservation does not match its exact snapshot');
  const { stdout } = await promisify(execFile)('git', ['rev-parse', '--verify', snapshot.recoveryRef + '^{commit}'], {
    cwd: repo.localPath, encoding: 'utf8', timeout: 5_000,
  });
  if (stdout.trim() !== snapshot.headCommit || !await absent(snapshot.originalPath)) refuse('completed retirement namespace or recovery commit changed');
  const claim = readExactWorkspaceClaim('managed-retirement', repo.localPath, path.basename(snapshot.originalPath));
  if (claim && (claim.sourcePath !== snapshot.originalPath || claim.authority?.preservationId !== preservationId
    || readExactManagedFinalization(claim)?.state !== 'complete' || !await absent(claim.claimPath))) {
    refuse('completed retirement still has an uncertain exact namespace or finalization');
  }
  const sessionKey = target.sessionKey?.trim() || null;
  if (sessionKey) {
    await import('@/lib/runtimes');
    const lifecycle = getOwnedSessionLifecycle(sessionKey);
    if (!lifecycle || await lifecycle.sessionState(sessionKey) === 'active') refuse('completed retirement session is active or unavailable');
  }
  const runs = missingSessionRuns(lane, sessionKey);
  await assertOrphanProcessesAbsent({ runtime: lane.runtime, runs, sourcePath: snapshot.originalPath,
    candidatePath: claim?.claimPath ?? snapshot.originalPath });
  // This only removes the already-completed trusted claim, never a directory.
  if (claim) completeExactManagedDirectoryRetirement(repo.localPath, claim.worktreeId);
  return true;
}

export async function prepareOrphanCloseOwners(targets: Lane[]): Promise<Set<string>> {
  try { return await prepareOwners(targets); }
  catch (error) {
    if (error instanceof OrphanCloseRefusal) throw error;
    refuse('persisted retirement, preservation or workspace authority could not be read');
  }
}

async function prepareOwners(targets: Lane[]): Promise<Set<string>> {
  const context = explicitClose.getStore();
  if (!context?.active) refuse('explicit close lifecycle authority is absent');
  const admitted = new Set<string>();
  for (const target of targets) {
    if (target.packetId !== context.packetId) refuse('close target belongs to another packet');
    if (!target.worktreePath) continue;
    if (!existsSync(target.worktreePath)) {
      if (await completedOrphanClose(target)) { admitted.add(target.id); continue; }
      const pending = orphanCloseRetirement(target);
      if (!pending) continue;
      if (!context?.active || pending.owner.packetId !== context.packetId) refuse('explicit retry lifecycle authority is absent');
      context.owners.set(target.id, pending.owner);
      await assertOrphanCloseOwner(target.id, pending.claim.claimPath);
      admitted.add(target.id);
      continue;
    }
    const owner = await inspectOwner(target.id, target.worktreePath);
    if (!owner) continue;
    if (!context?.active || owner.packetId !== context.packetId) refuse('explicit close lifecycle authority is absent');
    // Admission pins the actual source directory before any preservation writes.
    const managed = await readManagedWorkspaceMaterialization(target.repoPath, target.worktreePath);
    if (managed.identity.device !== owner.device || managed.identity.inode !== owner.inode) refuse('worktree materialization changed during close admission');
    context.owners.set(target.id, owner);
    admitted.add(target.id);
  }
  return admitted;
}

export async function assertOrphanCloseOwner(laneId: string, candidatePath: string): Promise<OrphanCloseOwner | null> {
  const expected = orphanCloseOwner(laneId);
  if (!expected) return null;
  try {
    const observed = await inspectOwner(laneId, candidatePath);
    if (!observed || JSON.stringify(expected) !== JSON.stringify(observed)) refuse('orphan close owner or persisted run evidence changed');
    return observed;
  } catch (error) {
    if (error instanceof OrphanCloseRefusal) explicitClose.getStore()?.refusals.set(laneId, error.message);
    throw error;
  }
}

/** A trusted exact-retirement claim may carry this descriptor across a crash. */
export function readOrphanCloseOwner(value: unknown): OrphanCloseOwner {
  if (!value || typeof value !== 'object') refuse('durable orphan close authority is malformed');
  const owner = value as OrphanCloseOwner;
  if (![owner.packetId, owner.laneId, owner.repositoryUuid].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 160)
    || typeof owner.sourcePath !== 'string' || !path.isAbsolute(owner.sourcePath)
    || !Number.isSafeInteger(owner.device) || !Number.isSafeInteger(owner.inode)
    || typeof owner.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(owner.fingerprint)) refuse('durable orphan close identity is incomplete');
  return owner;
}
