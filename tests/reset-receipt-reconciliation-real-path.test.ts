// Real reset-route regression (#2313): an accepted reset/retry request whose
// owner exits before its receipt is persisted must still reach a final result.
//
// Everything asserted here runs through the real POST handler against persisted
// packet, lane, and idempotency state. The interrupted precondition is built
// with the SAME production functions the route uses (holdPacketForRetrySalvage,
// the correlation journal writer, and the real startup quarantine against a
// genuinely exited pid) because a test process cannot vanish mid-request; the
// completed-effect case needs no such fixture — it interrupts a real in-flight
// request. OS process confirmation and the session archive directory move are
// the only stubbed boundaries.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const reapSessions = vi.hoisted(() => ({
  killLaneSessionsConfirmed: vi.fn(),
  sessionKey: '',
  archiveGate: null as Promise<void> | null,
  archiveStarted: 0,
}));

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return { ...actual, killLaneSessionsConfirmed: reapSessions.killLaneSessionsConfirmed };
});

vi.mock('@/lib/codex/owned', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/codex/owned')>();
  return {
    ...actual,
    archiveOwnedCodexSession: async (surfaceId: string) => {
      if (surfaceId !== reapSessions.sessionKey) return actual.archiveOwnedCodexSession(surfaceId);
      reapSessions.archiveStarted += 1;
      if (reapSessions.archiveGate) await reapSessions.archiveGate;
      return { archived: true };
    },
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-2313-receipt-data-'));
const wsToken = 'receipt-reconciliation-operator-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { createLane, getLane, listLanes, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
const {
  readOrchestratorControlPlaneState,
  withLockedState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { persistMissionRegistryState, readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { recordMission } = await import('@/lib/db/missions-store');
const { holdPacketForRetrySalvage } = await import('@/lib/orchestrator/operator-mission-service/retry-salvage');
const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
const { readResetRequestJournal, writeResetRequestJournal } = await import('@/lib/orchestrator/operator-mission-service/reset-recovery-journal');
type JournalEntry = import('@/lib/orchestrator/operator-mission-service/reset-recovery-journal').ResetRequestJournalEntry;

function journalEntry(requestKey: string): JournalEntry | null {
  const read = readResetRequestJournal(requestKey);
  return read.status === 'present' ? read.entry : null;
}
const { bindIdempotencyClientMutation, deriveIdempotencyKey } = await import('@/lib/orchestrator/idempotency-store');
const { quarantineDeadIdempotencyReservations } = await import('@/lib/db/idempotency-reservation-recovery');
const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');

const tempDirs: string[] = [];
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function git(cwd: string, args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepoWithCommittedWork(branch: string): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-2313-receipt-repo-'));
  tempDirs.push(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'o8@example.test']);
  git(repoDir, ['config', 'user.name', 'o8-test']);
  writeFileSync(join(repoDir, 'README.md'), 'fixture\n', 'utf8');
  git(repoDir, ['add', '--', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'base']);
  git(repoDir, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(repoDir, 'worker-result.txt'), 'finished work\n', 'utf8');
  git(repoDir, ['add', '--', 'worker-result.txt']);
  git(repoDir, ['commit', '-q', '-m', 'worker result']);
  return repoDir;
}

/** Bound, paused lane with an owned session key and clean committed work. */
function packetFixture(input: { packetId: string; repoPath: string; branch: string; laneId: string }): OrchestratorPacket {
  return {
    id: input.packetId,
    referenceLabel: input.packetId,
    title: input.packetId,
    summary: input.packetId,
    workspaceTargetPath: input.repoPath,
    branchTarget: input.branch,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'pending',
    status: 'blocked',
    blockedReason: 'operator_stopped',
    lastEventAt: null,
    lastEventLabel: 'operator_stopped',
    archivedAt: null,
    review: null,
    lane: {
      tileId: input.laneId,
      tabId: input.laneId,
      repoPath: input.repoPath,
      worktreePath: input.repoPath,
      runtime: 'codex',
      laneId: input.laneId,
      sessionKey: reapSessions.sessionKey,
    },
  };
}

interface Fixture {
  packetId: string;
  repoDir: string;
  laneId: string;
  branch: string;
  requestBody: Record<string, unknown>;
  requestKey: string;
  registryMissionId?: string;
}

function buildFixture(name: string, store: 'current' | 'registry' = 'current'): Fixture {
  const packetId = `pkt-2313-${name}`;
  reapSessions.sessionKey = `codex-owned:${packetId}`;
  const branch = `inline/2313-${name}`;
  const repoDir = createRepoWithCommittedWork(branch);
  const lane = createLane({
    repoPath: repoDir,
    worktreePath: repoDir,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    label: packetId,
    packetId,
    sessionKey: reapSessions.sessionKey,
  });
  setLaneStatus(lane.id, 'paused', 'system', 'operator_stopped');
  const packet = packetFixture({ packetId, repoPath: repoDir, branch, laneId: lane.id });
  const state = createEmptyOrchestratorMissionState();
  state.missionId = `mission-${packetId}`;
  state.repoPath = repoDir;
  state.prompt = packetId;
  state.summary = packetId;
  state.packets = [packet];
  if (store === 'registry') {
    // The packet lives only in an older registry mission; the current mission
    // must not contain it, or the current-store path would claim it first.
    const current = createEmptyOrchestratorMissionState();
    current.missionId = `mission-current-${packetId}`;
    current.repoPath = repoDir;
    writeOrchestratorControlPlaneState(current);
  } else {
    writeOrchestratorControlPlaneState(state);
  }
  const registryMissionId = store === 'registry' ? `mission-registry-${name}` : undefined;
  reapSessions.killLaneSessionsConfirmed.mockResolvedValue([
    { laneId: lane.id, sessionKey: reapSessions.sessionKey, runtime: 'codex', confirmed: true, alreadyDead: true, stages: [], note: 'already stopped' },
  ]);
  const requestBody = {
    packetId,
    reason: `2313 ${name}`,
    clearWorktree: false,
    idempotencyKey: `idem-2313-${name}`,
  };
  return {
    packetId,
    repoDir,
    laneId: lane.id,
    branch,
    registryMissionId,
    requestBody,
    requestKey: deriveIdempotencyKey({
      verb: 'reset_packet',
      scopeId: packetId,
      clientKey: requestBody.idempotencyKey,
      body: JSON.stringify({ packetId, clearWorktree: false, reason: requestBody.reason }),
    }),
  };
}

async function seedRegistryMission(fixture: Fixture): Promise<void> {
  const state = createEmptyOrchestratorMissionState();
  state.missionId = fixture.registryMissionId!;
  state.repoPath = fixture.repoDir;
  state.prompt = fixture.packetId;
  state.summary = fixture.packetId;
  state.packets = [packetFixture({
    packetId: fixture.packetId,
    repoPath: fixture.repoDir,
    branch: fixture.branch,
    laneId: fixture.laneId,
  })];
  recordMission({
    id: fixture.registryMissionId!,
    repoPath: fixture.repoDir,
    runtime: 'codex',
    prompt: state.prompt,
    summary: state.summary,
    constraints: state.constraints ?? '',
    packetMeta: state.packets.map((packet) => ({
      id: packet.id,
      title: packet.title,
      referenceLabel: packet.referenceLabel,
    })),
    missionState: state,
    totalWaves: 1,
  });
  await persistMissionRegistryState(state);
}

function registryPacket(fixture: Fixture): OrchestratorPacket | undefined {
  return readMissionRegistryEntry(fixture.registryMissionId!, { includeArchived: true })
    ?.mission.packets.find((packet) => packet.id === fixture.packetId);
}

function operatorPost(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:47199/api/orchestrator/reset-packet', {
    method: 'POST',
    headers: {
      host: 'localhost:47199',
      authorization: `Bearer ${wsToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function reservationRow(key: string) {
  return getSqlite()
    .prepare('SELECT result_json, pid, owner_identity_json FROM idempotency_keys WHERE key = ?')
    .get(key) as { result_json: string | null; pid: number | null; owner_identity_json: string | null } | undefined;
}

/** The exact row shape `reserve()` leaves behind for an in-flight request. */
function seedUnfinishedReservation(fixture: Fixture, owner: { pid: number | null; identityJson: string | null }): void {
  const now = Date.now();
  bindIdempotencyClientMutation({
    namespace: 'reset_packet',
    clientKey: String(fixture.requestBody.idempotencyKey),
    body: JSON.stringify({ packetId: fixture.packetId, clearWorktree: false, reason: fixture.requestBody.reason }),
  });
  getSqlite().prepare(
    `INSERT OR REPLACE INTO idempotency_keys
       (key, verb, packet_id, result_json, pid, reservation_id, owner_identity_json, created_at, expires_at)
     VALUES (?, 'reset_packet', ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.requestKey,
    fixture.packetId,
    owner.pid,
    `reservation-${fixture.packetId}`,
    owner.identityJson,
    now,
    now + 600_000,
  );
}

/** A pid that certainly exited: the shell that printed it. */
function exitedPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
}

const DEAD_OWNER_IDENTITY = '{"version":1,"platform":"darwin","bootId":"stale-boot","startId":"stale-start"}';

/** The abandoned `workspace_lifecycle_leases` row a crashed owner leaves behind. */
function abandonLifecycleLease(packetId: string, ownerPid: number): void {
  getSqlite().prepare(
    `INSERT OR REPLACE INTO workspace_lifecycle_leases
       (packet_id, reservation_id, owner_pid, owner_identity_json, acquired_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(packetId, `lease-${packetId}`, ownerPid, DEAD_OWNER_IDENTITY, Date.now());
}

function lifecycleLeaseRow(packetId: string) {
  return getSqlite()
    .prepare('SELECT packet_id, owner_pid FROM workspace_lifecycle_leases WHERE packet_id = ?')
    .get(packetId) as { packet_id: string; owner_pid: number } | undefined;
}

/**
 * Interrupt a request after its retry-salvage hold: run the production hold,
 * optionally journal it exactly as the route does, then leave the reservation
 * owned by a dead process and let the real startup quarantine detach it.
 */
async function interruptAfterHold(
  fixture: Fixture,
  options: { journal: boolean; abandonLease?: boolean },
): Promise<string> {
  const guard = await holdPacketForRetrySalvage({ packetId: fixture.packetId, clearWorktree: false });
  if (!guard) throw new Error('fixture did not take a retry-salvage hold');
  if (options.journal) {
    writeResetRequestJournal(fixture.requestKey, {
      phase: 'guarded',
      packetId: fixture.packetId,
      clearWorktree: false,
      generation: guard.generation,
      guard,
    });
  }
  const ownerPid = exitedPid();
  if (options.abandonLease) abandonLifecycleLease(fixture.packetId, ownerPid);
  seedUnfinishedReservation(fixture, { pid: ownerPid, identityJson: DEAD_OWNER_IDENTITY });
  quarantineDeadIdempotencyReservations(getSqlite());
  const quarantined = reservationRow(fixture.requestKey);
  // Startup quarantine clears dead ownership and preserves the unresolved guard.
  expect(quarantined).toMatchObject({ pid: null, result_json: null });
  return guard.generation;
}

function livePacket(packetId: string): OrchestratorPacket | undefined {
  return readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
}

beforeEach(() => {
  reapSessions.killLaneSessionsConfirmed.mockReset();
  reapSessions.archiveGate = null;
  reapSessions.archiveStarted = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reset receipt reconciliation (#2313)', () => {
  it('journals the guard mid-flight and the terminal receipt on completion', async () => {
    const fixture = buildFixture('journal');
    let releaseArchive!: () => void;
    reapSessions.archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });

    const pending = resetRoute.POST(operatorPost(fixture.requestBody));
    try {
      await vi.waitFor(() => expect(reapSessions.archiveStarted).toBe(1), { timeout: 20_000, interval: 25 });
      // The gate is inside session archival — the bind's first irreversible
      // change — so by now the request's generation, its rehydratable guard AND
      // its non-repeatable bind checkpoint are all durable, before any receipt
      // exists. That ordering is what recovery depends on.
      const midFlight = journalEntry(fixture.requestKey);
      expect(midFlight).toMatchObject({ phase: 'binding', packetId: fixture.packetId, clearWorktree: false });
      expect(midFlight?.guard?.generation).toBe(midFlight?.generation);
      expect(midFlight?.bind).toMatchObject({
        candidateLaneId: fixture.laneId,
        worktreePath: fixture.repoDir,
      });
      expect(livePacket(fixture.packetId)?.releaseStatePayload?.source)
        .toBe(`retry_salvage:${midFlight?.generation}`);
    } finally {
      releaseArchive();
    }

    const response = await pending;
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { salvaged: boolean; laneId: string } };
    expect(body.result).toMatchObject({ reset: false, salvaged: true });
    expect(journalEntry(fixture.requestKey)).toMatchObject({
      phase: 'completed',
      receipt: { ok: true, result: { salvaged: true, laneId: body.result.laneId } },
    });
  }, 30_000);

  it('resumes an interrupted request from its journaled guard once the owner is dead', async () => {
    const fixture = buildFixture('journaled-resume');
    const generation = await interruptAfterHold(fixture, { journal: true });

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; result: { salvaged: boolean; laneId: string; replayed: boolean } };
    expect(body).toMatchObject({ ok: true, result: { reset: false, salvaged: true, replayed: true } });
    // The resume bound the ORIGINAL committed work — one review lane, the old
    // lane archived, the worktree preserved.
    const lanes = listLanes().filter((lane) => lane.packetId === fixture.packetId);
    expect(lanes.map((lane) => lane.id)).toEqual([body.result.laneId]);
    expect(getLane(body.result.laneId)).toMatchObject({ status: 'reviewing', worktreePath: fixture.repoDir });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'archived', packetId: '' });
    expect(livePacket(fixture.packetId)).toMatchObject({
      status: 'awaiting_review',
      lane: { laneId: body.result.laneId },
    });
    // The reservation now carries a terminal receipt instead of staying quarantined.
    expect(reservationRow(fixture.requestKey)?.result_json).toContain('"salvaged":true');
    expect(journalEntry(fixture.requestKey)).toMatchObject({ phase: 'completed', generation });

    const replay = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ result: { salvaged: true, laneId: body.result.laneId, replayed: true } });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId)).toHaveLength(1);
    expect(reapSessions.killLaneSessionsConfirmed).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('resumes a pre-journal reservation only with operator generation evidence', async () => {
    const fixture = buildFixture('legacy');
    // The live #2304 shape: held at a known generation, no correlation journal,
    // and the crashed owner's workspace lifecycle lease still on the packet.
    const generation = await interruptAfterHold(fixture, { journal: false, abandonLease: true });
    expect(lifecycleLeaseRow(fixture.packetId)).toBeTruthy();
    expect(readResetRequestJournal(fixture.requestKey)).toEqual({ status: 'absent' });

    const withoutEvidence = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(withoutEvidence.status).toBe(409);
    expect(await withoutEvidence.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });

    // Half an attestation is rejected outright, not silently ignored.
    const generationOnly = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: { expectedGeneration: generation },
    }));
    expect(generationOnly.status).toBe(400);
    expect(await generationOnly.json()).toMatchObject({ error: { code: 'invalid_recovery_evidence' } });

    const wrongGeneration = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: {
        expectedGeneration: '00000000-0000-4000-8000-000000000000',
        expectedCandidateLaneId: fixture.laneId,
      },
    }));
    expect(wrongGeneration.status).toBe(409);
    expect(await wrongGeneration.json()).toMatchObject({ error: { code: 'outcome_unknown' } });

    const wrongCandidate = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: { expectedGeneration: generation, expectedCandidateLaneId: 'lane-not-ours' },
    }));
    expect(wrongCandidate.status).toBe(409);
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });

    // Each refusal above already reclaimed the abandoned lease, so restore it:
    // the SUCCESSFUL continuation is the one that must not be refused merely
    // because it had to reclaim its own dead owner's lease.
    abandonLifecycleLease(fixture.packetId, exitedPid());
    expect(lifecycleLeaseRow(fixture.packetId)).toBeTruthy();

    const resumed = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: { expectedGeneration: generation, expectedCandidateLaneId: fixture.laneId },
    }));
    expect(resumed.status).toBe(200);
    const body = await resumed.json() as { result: { salvaged: boolean; laneId: string } };
    expect(body.result).toMatchObject({ reset: false, salvaged: true, replayed: true });
    expect(getLane(body.result.laneId)).toMatchObject({ status: 'reviewing', worktreePath: fixture.repoDir });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId)).toHaveLength(1);
    // The evidence is not part of the request identity, so the original key
    // still binds to its original body rather than conflicting.
    expect(await (await resetRoute.POST(operatorPost(fixture.requestBody))).json())
      .toMatchObject({ result: { laneId: body.result.laneId, replayed: true } });
    // Reclaiming the dead owner's abandoned lease did not leave one behind.
    expect(lifecycleLeaseRow(fixture.packetId)).toBeUndefined();
  }, 30_000);

  it('resumes an interrupted request whose packet lives in the mission registry', async () => {
    const fixture = buildFixture('registry', 'registry');
    await seedRegistryMission(fixture);
    expect(registryPacket(fixture)).toBeTruthy();
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(0);
    const generation = await interruptAfterHold(fixture, { journal: true });
    expect(registryPacket(fixture)?.releaseStatePayload?.source).toBe(`retry_salvage:${generation}`);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(200);
    const body = await response.json() as { result: { salvaged: boolean; laneId: string } };
    expect(body.result).toMatchObject({ salvaged: true, replayed: true });
    expect(registryPacket(fixture)).toMatchObject({ status: 'awaiting_review', lane: { laneId: body.result.laneId } });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId).map((lane) => lane.id))
      .toEqual([body.result.laneId]);
  }, 30_000);

  it('replays a completed effect whose receipt never persisted', async () => {
    const fixture = buildFixture('lost-receipt');
    let releaseArchive!: () => void;
    reapSessions.archiveGate = new Promise<void>((resolve) => { releaseArchive = resolve; });

    const pending = resetRoute.POST(operatorPost(fixture.requestBody));
    try {
      await vi.waitFor(() => expect(reapSessions.archiveStarted).toBe(1), { timeout: 20_000, interval: 25 });
      // Simulate the owner dying between the effect and receipt finalization:
      // the real startup quarantine detaches ownership while the effect runs,
      // so the owner's finalize loses its reservation.
      getSqlite().prepare('UPDATE idempotency_keys SET pid = NULL, owner_identity_json = NULL WHERE key = ?')
        .run(fixture.requestKey);
    } finally {
      releaseArchive();
    }
    const original = await pending;
    expect(original.status).toBe(200);
    const originalBody = await original.json() as { result: { laneId: string } };
    expect(reservationRow(fixture.requestKey)?.result_json).toBeNull();
    expect(journalEntry(fixture.requestKey)).toMatchObject({ phase: 'completed' });

    const recovered = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({
      result: { salvaged: true, laneId: originalBody.result.laneId, replayed: true },
    });
    // Replay only — the effect did not repeat.
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId).map((lane) => lane.id))
      .toEqual([originalBody.result.laneId]);
    expect(reapSessions.killLaneSessionsConfirmed).toHaveBeenCalledTimes(1);
    expect(reapSessions.archiveStarted).toBe(1);
  }, 30_000);

  it('answers concurrent duplicates of an interrupted request with one effect', async () => {
    const fixture = buildFixture('concurrent');
    await interruptAfterHold(fixture, { journal: true });

    const [first, second] = await Promise.all([
      resetRoute.POST(operatorPost(fixture.requestBody)),
      resetRoute.POST(operatorPost(fixture.requestBody)),
    ]);
    const bodies = [await first.json(), await second.json()] as Array<{ ok: boolean; result?: { laneId?: string } }>;

    // Both callers must receive the same terminal receipt: the loser re-reads
    // the completed record under the lease instead of reporting a false hold.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const salvaged = bodies.filter((body) => body.ok && body.result?.laneId);
    expect(salvaged).toHaveLength(2);
    const laneIds = new Set(salvaged.map((body) => body.result!.laneId));
    expect(laneIds.size).toBe(1);
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId).map((lane) => lane.id))
      .toEqual([...laneIds]);
    expect(reapSessions.killLaneSessionsConfirmed).toHaveBeenCalledTimes(1);
  }, 30_000);

  it.each([
    ['live', () => probeMetadataLockProcessIdentity(process.pid).then((probe) => ({
      pid: process.pid,
      identityJson: JSON.stringify(probe.state === 'live' ? probe.identity : null),
    }))],
    ['unknown', async () => ({ pid: process.pid, identityJson: null })],
  ] as const)('holds an interrupted request whose owner is %s', async (kind, owner) => {
    const fixture = buildFixture(`owner-${kind}`);
    const guard = await holdPacketForRetrySalvage({ packetId: fixture.packetId, clearWorktree: false });
    writeResetRequestJournal(fixture.requestKey, {
      phase: 'guarded',
      packetId: fixture.packetId,
      clearWorktree: false,
      generation: guard!.generation,
      guard: guard!,
    });
    seedUnfinishedReservation(fixture, await owner());
    quarantineDeadIdempotencyReservations(getSqlite());
    // A live or unknown owner keeps its reservation; only dead ownership clears.
    expect(reservationRow(fixture.requestKey)?.pid).toBe(process.pid);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    // Not reconciled and not re-executed: a live or unknown owner keeps the
    // ordinary in-progress marker, never an outcome-unknown quarantine.
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      ok: true,
      result: { deduped: true, status: 'in_progress', verb: 'reset_packet', inProgress: true },
    });
    // No continuation ran: the packet is still held at its generation and the
    // candidate lane is untouched.
    expect(livePacket(fixture.packetId)).toMatchObject({
      queueState: 'held',
      operatorStopped: true,
      releaseStatePayload: { source: `retry_salvage:${guard!.generation}` },
    });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId)).toHaveLength(1);
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);

  it('refuses to resume behind newer in-process lifecycle intent', async () => {
    const fixture = buildFixture('live-intent');
    await interruptAfterHold(fixture, { journal: true, abandonLease: true });

    // A competing lifecycle mutation is already queued for this packet. Unlike
    // the crashed owner's abandoned lease, that is newer intent.
    let releaseCompeting!: () => void;
    const competing = new Promise<void>((resolve) => { releaseCompeting = resolve; });
    const competingMutation = withPacketLifecycleMutationLock(fixture.packetId, async () => {
      await competing;
    });
    const pending = resetRoute.POST(operatorPost(fixture.requestBody));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseCompeting();
    await competingMutation;
    const response = await pending;

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId)).toHaveLength(1);
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);

  it('resumes a started-phase request from its own recorded generation', async () => {
    const fixture = buildFixture('started-phase');
    // The hold landed but the journal only reached `started`: the request named
    // this generation before stamping it.
    const guard = await holdPacketForRetrySalvage({ packetId: fixture.packetId, clearWorktree: false });
    writeResetRequestJournal(fixture.requestKey, {
      phase: 'started',
      packetId: fixture.packetId,
      clearWorktree: false,
      generation: guard!.generation,
    });
    seedUnfinishedReservation(fixture, { pid: exitedPid(), identityJson: DEAD_OWNER_IDENTITY });
    quarantineDeadIdempotencyReservations(getSqlite());

    // Caller evidence cannot overwrite a recorded generation.
    const conflicting = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: {
        expectedGeneration: '00000000-0000-4000-8000-000000000000',
        expectedCandidateLaneId: fixture.laneId,
      },
    }));
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();

    const resumed = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(resumed.status).toBe(200);
    const body = await resumed.json() as { result: { laneId: string; salvaged: boolean } };
    expect(body.result).toMatchObject({ salvaged: true, replayed: true });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId).map((lane) => lane.id))
      .toEqual([body.result.laneId]);
  }, 30_000);

  it('fails closed on an unreadable correlation record even with correct evidence', async () => {
    const fixture = buildFixture('corrupt-journal');
    const generation = await interruptAfterHold(fixture, { journal: true });
    // A correlation WAS recorded but can no longer be trusted. That must not
    // degrade to "no journal", where caller evidence would be accepted.
    getSqlite().prepare(
      "UPDATE idempotency_keys SET result_json = '{\"phase\":\"guarded\"' WHERE verb = 'reset_packet.journal' AND packet_id = ?",
    ).run(fixture.packetId);
    expect(readResetRequestJournal(fixture.requestKey).status).toBe('unreadable');

    const response = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: { expectedGeneration: generation, expectedCandidateLaneId: fixture.laneId },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
  }, 30_000);

  it('keeps a completed correlation record while its reservation is unresolved', async () => {
    const fixture = buildFixture('retention');
    await interruptAfterHold(fixture, { journal: true });
    const resumed = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(resumed.status).toBe(200);

    // Age the completed record past any bounded retention window.
    const aged = journalEntry(fixture.requestKey)!;
    getSqlite().prepare(
      "UPDATE idempotency_keys SET result_json = ? WHERE verb = 'reset_packet.journal' AND packet_id = ?",
    ).run(JSON.stringify({ ...aged, updatedAt: 0 }), fixture.packetId);
    // Re-open the reservation: this request is unsettled again, so its record
    // is the only evidence that can ever answer it.
    getSqlite().prepare('UPDATE idempotency_keys SET result_json = NULL, pid = NULL WHERE key = ?')
      .run(fixture.requestKey);

    // Any later journal write runs the retention sweep, and any later route
    // call runs the idempotency store's own TTL prune. Neither may erase the
    // only evidence that can still answer an unresolved reservation.
    const unrelated = buildFixture('retention-sweeper');
    await interruptAfterHold(unrelated, { journal: true });
    await resetRoute.POST(operatorPost(unrelated.requestBody));
    expect(journalEntry(fixture.requestKey)?.phase).toBe('completed');

    // Once the reservation is settled, the aged record becomes collectable.
    getSqlite().prepare("UPDATE idempotency_keys SET result_json = '{\"ok\":true}' WHERE key = ?")
      .run(fixture.requestKey);
    const sweeper = buildFixture('retention-sweeper-2');
    await interruptAfterHold(sweeper, { journal: true });
    expect(readResetRequestJournal(fixture.requestKey).status).toBe('absent');
  }, 30_000);

  it('refuses to resume when the packet moved to a newer generation', async () => {
    const fixture = buildFixture('newer-generation');
    await interruptAfterHold(fixture, { journal: true });
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === fixture.packetId);
      if (packet) packet.releaseStatePayload = { source: 'retry_salvage:newer-generation' };
    });

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(livePacket(fixture.packetId)).toMatchObject({
      releaseStatePayload: { source: 'retry_salvage:newer-generation' },
    });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);

  it('refuses to resume when the candidate lane drifted', async () => {
    const fixture = buildFixture('candidate-drift');
    await interruptAfterHold(fixture, { journal: true });
    // The packet still carries the hold, but the candidate lane's session no
    // longer matches the one the interrupted request captured.
    updateLane(fixture.laneId, { sessionKey: 'codex-owned:someone-else' });

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    // The committed candidate can no longer be proven, so the request is HELD
    // with a precise reason. It must never fall through to the generation-scoped
    // reset, whose archival and cleanup effects would be unrepeatable.
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('outcome_unknown');
    expect(body.error.message).toContain('no committed candidate could be proven');
    expect(getLane(fixture.laneId)).toMatchObject({
      status: 'paused',
      packetId: fixture.packetId,
      worktreePath: fixture.repoDir,
      sessionKey: 'codex-owned:someone-else',
    });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId).map((lane) => lane.id))
      .toEqual([fixture.laneId]);
    expect(livePacket(fixture.packetId)).toMatchObject({ queueState: 'held', operatorStopped: true });
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);
});
