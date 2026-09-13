// Real reset-route regression (#2313): the interrupted-BIND window and the
// strictness boundaries around recovery evidence.
//
// A bind persists its review lane before it persists the packet. An owner that
// dies between them leaves a real lane behind an intact guard, so a naive
// same-key replay would bind a second review lane. These cases drive the real
// POST handler against that durable partial state, and against attestation that
// is malformed, partial, or contradicts what the request itself recorded.
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
      return { archived: true };
    },
  };
});

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-2313-partial-bind-data-'));
const wsToken = 'partial-bind-recovery-operator-token-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${wsToken}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { createLane, getLane, listLanes, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { holdPacketForRetrySalvage } = await import('@/lib/orchestrator/operator-mission-service/retry-salvage');
const {
  readResetRequestJournal,
  writeResetRequestJournal,
} = await import('@/lib/orchestrator/operator-mission-service/reset-recovery-journal');
type JournalEntry = import('@/lib/orchestrator/operator-mission-service/reset-recovery-journal').ResetRequestJournalEntry;
const { bindIdempotencyClientMutation, deriveIdempotencyKey } = await import('@/lib/orchestrator/idempotency-store');
const { quarantineDeadIdempotencyReservations } = await import('@/lib/db/idempotency-reservation-recovery');

const DEAD_OWNER_IDENTITY = '{"version":1,"platform":"darwin","bootId":"stale-boot","startId":"stale-start"}';
const tempDirs: string[] = [];
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function git(cwd: string, args: string[]): string {
  return execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function journalEntry(requestKey: string): JournalEntry | null {
  const read = readResetRequestJournal(requestKey);
  return read.status === 'present' ? read.entry : null;
}

function createRepoWithCommittedWork(branch: string): string {
  const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-2313-partial-bind-repo-'));
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
}

function buildFixture(name: string, clearWorktree = false): Fixture {
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
  const state = createEmptyOrchestratorMissionState();
  state.missionId = `mission-${packetId}`;
  state.repoPath = repoDir;
  state.prompt = packetId;
  state.summary = packetId;
  state.packets = [packetFixture({ packetId, repoPath: repoDir, branch, laneId: lane.id })];
  writeOrchestratorControlPlaneState(state);
  reapSessions.killLaneSessionsConfirmed.mockResolvedValue([
    { laneId: lane.id, sessionKey: reapSessions.sessionKey, runtime: 'codex', confirmed: true, alreadyDead: true, stages: [], note: 'already stopped' },
  ]);
  const requestBody = {
    packetId,
    reason: `2313 ${name}`,
    clearWorktree,
    idempotencyKey: `idem-2313-${name}`,
  };
  return {
    packetId,
    repoDir,
    laneId: lane.id,
    branch,
    requestBody,
    requestKey: deriveIdempotencyKey({
      verb: 'reset_packet',
      scopeId: packetId,
      clientKey: requestBody.idempotencyKey,
      body: JSON.stringify({ packetId, clearWorktree, reason: requestBody.reason }),
    }),
  };
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

/** The exact row shape `reserve()` leaves behind for an in-flight request. */
function seedUnfinishedReservation(fixture: Fixture, ownerPid: number): void {
  const now = Date.now();
  bindIdempotencyClientMutation({
    namespace: 'reset_packet',
    clientKey: String(fixture.requestBody.idempotencyKey),
    body: JSON.stringify({ packetId: fixture.packetId, clearWorktree: fixture.requestBody.clearWorktree, reason: fixture.requestBody.reason }),
  });
  getSqlite().prepare(
    `INSERT OR REPLACE INTO idempotency_keys
       (key, verb, packet_id, result_json, pid, reservation_id, owner_identity_json, created_at, expires_at)
     VALUES (?, 'reset_packet', ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    fixture.requestKey,
    fixture.packetId,
    ownerPid,
    `reservation-${fixture.packetId}`,
    DEAD_OWNER_IDENTITY,
    now,
    now + 600_000,
  );
}

/** A pid that certainly exited: the shell that printed it. */
function exitedPid(): number {
  return Number(execFileSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' }).trim());
}

/** Interrupt after the hold, with the request's guard journaled. */
async function interruptAfterHold(fixture: Fixture): Promise<string> {
  const guard = await holdPacketForRetrySalvage({ packetId: fixture.packetId, clearWorktree: false });
  if (!guard) throw new Error('fixture did not take a retry-salvage hold');
  writeResetRequestJournal(fixture.requestKey, {
    phase: 'guarded',
    packetId: fixture.packetId,
    clearWorktree: false,
    generation: guard.generation,
    guard,
  });
  seedUnfinishedReservation(fixture, exitedPid());
  quarantineDeadIdempotencyReservations(getSqlite());
  return guard.generation;
}

function livePacket(packetId: string): OrchestratorPacket | undefined {
  return readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
}

function stablePacket(packet: OrchestratorPacket | undefined) {
  if (!packet) return packet;
  const snapshot = structuredClone(packet);
  if (!snapshot.workerRouting) return snapshot;
  const { decidedAt: _volatileRoutingTimestamp, ...workerRouting } = snapshot.workerRouting;
  return { ...snapshot, workerRouting };
}

beforeEach(() => {
  reapSessions.killLaneSessionsConfirmed.mockReset();
  reapSessions.archiveStarted = 0;
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reset partial-bind recovery and evidence strictness (#2313)', () => {
  /**
   * Interrupt the REAL route inside the bind.
   *
   * TEMP SQLite triggers on the app's own connection do three things, all of
   * which a dying owner would do implicitly: fault one write inside the bind,
   * ignore the terminal journal update, and ignore reservation finalization.
   * The zero-row finalization raises ReservationOwnershipLostError, which the
   * store deliberately does NOT keep in its in-process fallback, so the
   * reservation is left genuinely unresolved. A BEFORE INSERT assertion on
   * `lanes` proves the production bind checkpoint already exists before the
   * first lane write — if the checkpoint ever moved after lane creation, the
   * insert aborts and this fixture fails loudly.
   */
  const TRIGGERS = [
    'o8_2313_assert_checkpoint',
    'o8_2313_ignore_journal_completion',
    'o8_2313_ignore_finalization',
    'o8_2313_fault_review_status',
    'o8_2313_fault_old_lane_unbind',
  ];

  function dropInterruptTriggers(): void {
    for (const name of TRIGGERS) getSqlite().exec(`DROP TRIGGER IF EXISTS ${name}`);
  }

  function installInterruptTriggers(packetId: string, fault: 'review-status' | 'old-lane-unbind'): void {
    const quoted = `'${packetId.replace(/'/g, "''")}'`;
    getSqlite().exec(`
      CREATE TEMP TRIGGER o8_2313_assert_checkpoint BEFORE INSERT ON lanes
      WHEN NEW.packet_id = ${quoted} AND (SELECT COUNT(*) FROM idempotency_keys
              WHERE verb = 'reset_packet.journal'
                AND packet_id = ${quoted}
                AND result_json LIKE '%"phase":"binding"%') = 0
      BEGIN SELECT RAISE(ABORT, 'bind checkpoint missing before the first lane write'); END;

      CREATE TEMP TRIGGER o8_2313_ignore_journal_completion BEFORE UPDATE ON idempotency_keys
      WHEN NEW.verb = 'reset_packet.journal' AND NEW.packet_id = ${quoted} AND NEW.result_json LIKE '%"phase":"completed"%'
      BEGIN SELECT RAISE(IGNORE); END;

      CREATE TEMP TRIGGER o8_2313_ignore_finalization BEFORE UPDATE ON idempotency_keys
      WHEN OLD.verb = 'reset_packet' AND OLD.packet_id = ${quoted} AND OLD.result_json IS NULL AND NEW.result_json IS NOT NULL
      BEGIN SELECT RAISE(IGNORE); END;
    `);
    if (fault === 'review-status') {
      getSqlite().exec(`
        CREATE TEMP TRIGGER o8_2313_fault_review_status BEFORE UPDATE OF status ON lanes
        WHEN NEW.packet_id = ${quoted} AND NEW.status = 'reviewing'
        BEGIN SELECT RAISE(ABORT, 'simulated owner exit before the review status landed'); END;
      `);
    } else {
      getSqlite().exec(`
        CREATE TEMP TRIGGER o8_2313_fault_old_lane_unbind BEFORE UPDATE ON lanes
        WHEN OLD.packet_id = ${quoted} AND NEW.packet_id = ''
        BEGIN SELECT RAISE(ABORT, 'simulated owner exit before the old lane was retired'); END;
      `);
    }
  }

  /** Run the real request, interrupt it mid-bind, then leave a dead owner. */
  async function interruptRealBind(
    fixture: Fixture,
    fault: 'review-status' | 'old-lane-unbind',
  ): Promise<{ inventoryBefore: string[]; response: Response }> {
    const inventoryBefore = listLanes().map((lane) => lane.id).sort();
    installInterruptTriggers(fixture.packetId, fault);
    let response: Response;
    try {
      response = await resetRoute.POST(operatorPost(fixture.requestBody));
    } finally {
      dropInterruptTriggers();
    }
    // The interrupted owner is gone; its reservation stays unresolved.
    getSqlite().prepare(
      'UPDATE idempotency_keys SET pid = ?, owner_identity_json = ? WHERE key = ?',
    ).run(exitedPid(), DEAD_OWNER_IDENTITY, fixture.requestKey);
    quarantineDeadIdempotencyReservations(getSqlite());
    const reservation = getSqlite()
      .prepare('SELECT result_json, pid FROM idempotency_keys WHERE key = ?')
      .get(fixture.requestKey) as { result_json: string | null; pid: number | null };
    expect(reservation).toMatchObject({ result_json: null, pid: null });
    expect(journalEntry(fixture.requestKey)?.phase).toBe('binding');
    return { inventoryBefore, response };
  }

  it('holds an interrupted bind without adopting or duplicating its reviewing lane', async () => {
    const fixture = buildFixture('partial-bind');
    // The real bind created a reviewing lane but never retired the old lane
    // or persisted the packet. A later matching lane cannot prove ownership.
    const { inventoryBefore } = await interruptRealBind(fixture, 'old-lane-unbind');
    const createdDuringBind = listLanes().filter((lane) => !inventoryBefore.includes(lane.id));
    expect(createdDuringBind).toHaveLength(1);
    expect(createdDuringBind[0]).toMatchObject({ status: 'reviewing', worktreePath: fixture.repoDir });
    const lanesAfterInterrupt = listLanes();
    const packetAfterInterrupt = stablePacket(livePacket(fixture.packetId));
    const headAfterInterrupt = git(fixture.repoDir, ['rev-parse', 'HEAD']);
    const archivesDuringBind = reapSessions.archiveStarted;
    const killsDuringBind = reapSessions.killLaneSessionsConfirmed.mock.calls.length;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await resetRoute.POST(operatorPost(fixture.requestBody));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'outcome_unknown', message: expect.stringContaining('partial bind remains held') },
      });
      // Compare every lane row, including any lane no longer packet-bound.
      expect(listLanes()).toEqual(lanesAfterInterrupt);
      expect(stablePacket(livePacket(fixture.packetId))).toEqual(packetAfterInterrupt);
      expect(git(fixture.repoDir, ['rev-parse', 'HEAD'])).toBe(headAfterInterrupt);
      expect(reapSessions.archiveStarted).toBe(archivesDuringBind);
      expect(reapSessions.killLaneSessionsConfirmed.mock.calls.length).toBe(killsDuringBind);
      expect(journalEntry(fixture.requestKey)).toMatchObject({
        phase: 'binding', held: { reason: expect.stringContaining('partial bind remains held') },
      });
    }
  }, 30_000);

  it('holds a bind interrupted before its lane reached a bound reviewing state', async () => {
    const fixture = buildFixture('partial-bind-unreviewed');
    const { inventoryBefore } = await interruptRealBind(fixture, 'review-status');
    const createdDuringBind = listLanes().filter((lane) => !inventoryBefore.includes(lane.id));
    expect(createdDuringBind).toHaveLength(1);
    expect(createdDuringBind[0]!.status).not.toBe('reviewing');
    const inventoryAfterInterrupt = listLanes();
    const archivesDuringBind = reapSessions.archiveStarted;
    const killsDuringBind = reapSessions.killLaneSessionsConfirmed.mock.calls.length;

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('outcome_unknown');
    expect(body.error.message).toContain('partial bind remains held');
    // No rebind, no retirement, no archival, no cleanup, no launch.
    expect(listLanes()).toEqual(inventoryAfterInterrupt);
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(livePacket(fixture.packetId)).toMatchObject({ queueState: 'held', operatorStopped: true });
    expect(reapSessions.archiveStarted).toBe(archivesDuringBind);
    expect(reapSessions.killLaneSessionsConfirmed.mock.calls.length).toBe(killsDuringBind);
    expect(journalEntry(fixture.requestKey)?.phase).toBe('binding');
  }, 30_000);

  it('holds a partial bind whose worktree gained another lane', async () => {
    const fixture = buildFixture('partial-bind-ambiguous');
    const { inventoryBefore } = await interruptRealBind(fixture, 'old-lane-unbind');
    // Even matching caller evidence must not authorize adopting a later lane
    // or restarting an interrupted bind.
    createLane({
      repoPath: fixture.repoDir,
      worktreePath: fixture.repoDir,
      branch: fixture.branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: 'foreign',
    });
    const inventoryAfterInterrupt = listLanes();

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('outcome_unknown');
    expect(body.error.message).toContain('partial bind remains held');
    expect(listLanes()).toEqual(inventoryAfterInterrupt);
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(journalEntry(fixture.requestKey)?.phase).toBe('binding');
    expect(inventoryBefore.length).toBeLessThan(inventoryAfterInterrupt.length);
    // The binding phase never falls through to the legacy-evidence path.
    const legacyAttempt = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: {
        expectedGeneration: journalEntry(fixture.requestKey)!.generation,
        expectedCandidateLaneId: fixture.laneId,
      },
    }));
    expect(legacyAttempt.status).toBe(409);
    expect(journalEntry(fixture.requestKey)?.phase).toBe('binding');
  }, 30_000);

  it('holds instead of resetting when no committed candidate can be proven', async () => {
    const fixture = buildFixture('unproven');
    // Uncommitted changes in the worktree: the salvage probe cannot prove a
    // clean committed candidate for this request.
    writeFileSync(join(fixture.repoDir, 'dirty.txt'), 'uncommitted\n', 'utf8');
    await interruptAfterHold(fixture);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('outcome_unknown');
    expect(body.error.message).toContain('the generation-scoped reset is never resumed');
    // The reset fallback did NOT run: the lane is still bound and the worktree
    // still exists with its committed work.
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(listLanes().filter((lane) => lane.packetId === fixture.packetId)).toHaveLength(1);
    expect(livePacket(fixture.packetId)).toMatchObject({ queueState: 'held', operatorStopped: true });
    expect(git(fixture.repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(fixture.branch);
    expect(journalEntry(fixture.requestKey)?.held?.reason).toContain('no committed candidate');
  }, 30_000);

  it('keeps its candidate correlation after completion and refuses a contradictory candidate', async () => {
    const fixture = buildFixture('completed-candidate');
    await interruptAfterHold(fixture);
    const settled = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(settled.status).toBe(200);
    // Completion must not drop the guard: without it the record's generation
    // still matches but its candidate is unknown, and any candidate would pass.
    const completed = journalEntry(fixture.requestKey);
    expect(completed).toMatchObject({ phase: 'completed' });
    expect(completed?.guard?.candidateLane?.id).toBe(fixture.laneId);
    getSqlite().prepare('UPDATE idempotency_keys SET result_json = NULL, pid = NULL WHERE key = ?')
      .run(fixture.requestKey);

    const wrongCandidate = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: {
        expectedGeneration: completed!.generation,
        expectedCandidateLaneId: 'lane-not-ours',
      },
    }));

    expect(wrongCandidate.status).toBe(409);
    expect(await wrongCandidate.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
  }, 30_000);

  it('refuses to replay a stored success that neither reset nor salvaged', async () => {
    const fixture = buildFixture('semantic-success');
    await interruptAfterHold(fixture);
    const settled = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(settled.status).toBe(200);
    const completed = journalEntry(fixture.requestKey)!;
    // A stored ok:true whose result did neither is not a receipt this code
    // could have written; replaying it as success would invent an outcome.
    getSqlite().prepare(
      "UPDATE idempotency_keys SET result_json = ? WHERE verb = 'reset_packet.journal' AND packet_id = ?",
    ).run(JSON.stringify({
      ...completed,
      receipt: {
        ok: true,
        result: {
          reset: false,
          salvaged: false,
          packetId: fixture.packetId,
          referenceLabel: fixture.packetId,
          worktreePruned: false,
          branchDeleted: false,
          note: 'nothing happened',
        },
      },
    }), fixture.packetId);
    getSqlite().prepare('UPDATE idempotency_keys SET result_json = NULL, pid = NULL WHERE key = ?')
      .run(fixture.requestKey);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'outcome_unknown' } });
    expect(readResetRequestJournal(fixture.requestKey).status).toBe('unreadable');
  }, 30_000);

  it('holds a corrupted journal phase without touching packet or lane state', async () => {
    const fixture = buildFixture('corrupt-phase');
    await interruptAfterHold(fixture);
    const lanesBefore = listLanes();
    const packetBefore = stablePacket(livePacket(fixture.packetId));
    const headBefore = git(fixture.repoDir, ['rev-parse', 'HEAD']);
    getSqlite().prepare(
      "UPDATE idempotency_keys SET result_json = json_set(result_json, '$.phase', 'toString') WHERE verb = 'reset_packet.journal' AND packet_id = ?",
    ).run(fixture.packetId);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'outcome_unknown', message: expect.stringContaining('unrecognized shape') },
    });
    expect(readResetRequestJournal(fixture.requestKey).status).toBe('unreadable');
    expect(listLanes()).toEqual(lanesBefore);
    expect(stablePacket(livePacket(fixture.packetId))).toEqual(packetBefore);
    expect(git(fixture.repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(reapSessions.archiveStarted).toBe(0);
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
  }, 30_000);

  it('does not overwrite a terminal journal receipt when a held duplicate races it', async () => {
    const fixture = buildFixture('held-write-race');
    await interruptAfterHold(fixture);
    const guarded = journalEntry(fixture.requestKey)!;
    const completed: JournalEntry = {
      ...guarded,
      phase: 'completed',
      updatedAt: guarded.updatedAt + 1,
      receipt: {
        ok: true,
        result: {
          reset: false,
          salvaged: true,
          packetId: fixture.packetId,
          referenceLabel: fixture.packetId,
          worktreePruned: false,
          branchDeleted: false,
          note: 'same request completed while duplicate was resolving',
          laneId: fixture.laneId,
        },
      },
    };
    const sqlite = getSqlite();
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let injected = false;
    // This models a duplicate reading `guarded`, then the original request
    // completing before the duplicate's held-metadata statement reaches the
    // database. The spy advances with the real journal writer before forwarding
    // the stale statement, so the corrected SQL CAS is evaluated afterward.
    const prepareSpy = vi.spyOn(sqlite, 'prepare').mockImplementation(((sql: string) => {
      const statement = originalPrepare(sql);
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property !== 'run') {
            const value = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return (...args: unknown[]) => {
            const heldWrite = args.some((arg) => (
              typeof arg === 'string'
              && arg.includes('"held"')
              && arg.includes(fixture.packetId)
            ));
            if (!injected && heldWrite) {
              injected = true;
              const { updatedAt: _ignored, ...next } = completed;
              writeResetRequestJournal(fixture.requestKey, next);
            }
            return (Reflect.get(target, 'run') as (...values: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof sqlite.prepare);
    try {
      const response = await resetRoute.POST(operatorPost({
        ...fixture.requestBody,
        recovery: {
          expectedGeneration: guarded.generation,
          expectedCandidateLaneId: 'lane-contradictory',
        },
      }));
      expect(response.status).toBe(409);
    } finally {
      prepareSpy.mockRestore();
    }

    expect(injected).toBe(true);

    expect(journalEntry(fixture.requestKey)).toMatchObject({
      phase: 'completed',
      receipt: { ok: true, result: { salvaged: true, laneId: fixture.laneId } },
    });
  }, 30_000);

  it('refuses recovery under a new key without changing the original held request', async () => {
    const fixture = buildFixture('unknown-recovery-key');
    const generation = await interruptAfterHold(fixture);
    const lanesBefore = listLanes();
    const packetBefore = stablePacket(livePacket(fixture.packetId));
    const headBefore = git(fixture.repoDir, ['rev-parse', 'HEAD']);

    const response = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      idempotencyKey: 'mistyped-original-key',
      recovery: { expectedGeneration: generation, expectedCandidateLaneId: fixture.laneId },
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'recovery_request_not_found' } });
    expect(listLanes()).toEqual(lanesBefore);
    expect(stablePacket(livePacket(fixture.packetId))).toEqual(packetBefore);
    expect(git(fixture.repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(reapSessions.archiveStarted).toBe(0);
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
    expect(journalEntry(fixture.requestKey)).toMatchObject({ phase: 'guarded', generation });
    expect(getSqlite().prepare('SELECT result_json FROM idempotency_keys WHERE key = ?')
      .get(fixture.requestKey)).toEqual({ result_json: null });
  }, 30_000);

  it('holds an unfinished worktree-clearing request instead of resuming cleanup', async () => {
    const fixture = buildFixture('interrupted-clear-worktree', true);
    seedUnfinishedReservation(fixture, exitedPid());
    quarantineDeadIdempotencyReservations(getSqlite());
    writeResetRequestJournal(fixture.requestKey, {
      phase: 'started', packetId: fixture.packetId, clearWorktree: true, generation: 'interrupted-clear',
    });
    const lanesBefore = listLanes();
    const packetBefore = stablePacket(livePacket(fixture.packetId));
    const headBefore = git(fixture.repoDir, ['rev-parse', 'HEAD']);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'outcome_unknown', message: expect.stringContaining('worktree-clearing request remains held') },
    });
    expect(listLanes()).toEqual(lanesBefore);
    expect(stablePacket(livePacket(fixture.packetId))).toEqual(packetBefore);
    expect(git(fixture.repoDir, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(reapSessions.archiveStarted).toBe(0);
    expect(reapSessions.killLaneSessionsConfirmed).not.toHaveBeenCalled();
  }, 30_000);

  it('preserves the accepted generation when a journal write names a different request', async () => {
    const fixture = buildFixture('journal-identity');
    const generation = await interruptAfterHold(fixture);
    const original = journalEntry(fixture.requestKey)!;
    writeResetRequestJournal(fixture.requestKey, { ...original, generation: 'another-generation' });
    writeResetRequestJournal(fixture.requestKey, { ...original, packetId: 'another-packet' });
    writeResetRequestJournal(fixture.requestKey, { ...original, clearWorktree: true });
    expect(journalEntry(fixture.requestKey)).toEqual(original);

    const response = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(response.status).toBe(200);
    expect(journalEntry(fixture.requestKey)).toMatchObject({ phase: 'completed', generation });
  }, 30_000);

  it('preserves absent candidates and existing bind identity byte for byte', async () => {
    const fixture = buildFixture('immutable-journal-identity');
    await interruptAfterHold(fixture);
    const { updatedAt: _ignored, ...guarded } = journalEntry(fixture.requestKey)!;
    const unselectedKey = `${fixture.requestKey}-unselected`;
    writeResetRequestJournal(unselectedKey, {
      ...guarded, guard: { ...guarded.guard!, candidateLane: null },
    });
    const binding = {
      ...guarded, phase: 'binding' as const,
      bind: { candidateLaneId: fixture.laneId, worktreePath: fixture.repoDir },
    };
    writeResetRequestJournal(fixture.requestKey, binding);
    const journalRows = () => getSqlite().prepare(
      "SELECT key, result_json FROM idempotency_keys WHERE verb = 'reset_packet.journal' AND packet_id = ? ORDER BY key",
    ).all(fixture.packetId);
    const before = journalRows();

    writeResetRequestJournal(unselectedKey, guarded);
    writeResetRequestJournal(fixture.requestKey, {
      ...binding, bind: { ...binding.bind, candidateLaneId: 'another-candidate' },
    });
    writeResetRequestJournal(fixture.requestKey, {
      ...binding, bind: { ...binding.bind, worktreePath: `${fixture.repoDir}/another-worktree` },
    });

    expect(journalRows()).toEqual(before);
    expect((await resetRoute.POST(operatorPost(fixture.requestBody))).status).toBe(409);
  }, 30_000);

  it('refuses attestation on a worktree-clearing reset', async () => {
    const fixture = buildFixture('clear-worktree-evidence');
    const generation = await interruptAfterHold(fixture);

    const response = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      clearWorktree: true,
      recovery: { expectedGeneration: generation, expectedCandidateLaneId: fixture.laneId },
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_recovery_evidence' } });
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);

  it('refuses to replay a completed record for contradictory evidence', async () => {
    const fixture = buildFixture('contradictory-replay');
    await interruptAfterHold(fixture);
    const settled = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(settled.status).toBe(200);
    const settledBody = await settled.json() as { result: { laneId: string } };
    // Re-open the reservation so reconciliation runs again for this key.
    getSqlite().prepare('UPDATE idempotency_keys SET result_json = NULL, pid = NULL WHERE key = ?')
      .run(fixture.requestKey);

    const contradictory = await resetRoute.POST(operatorPost({
      ...fixture.requestBody,
      recovery: {
        expectedGeneration: '00000000-0000-4000-8000-000000000000',
        expectedCandidateLaneId: fixture.laneId,
      },
    }));
    expect(contradictory.status).toBe(409);
    expect(await contradictory.json()).toMatchObject({ error: { code: 'outcome_unknown' } });

    // The truthful request still replays the same terminal receipt.
    const honest = await resetRoute.POST(operatorPost(fixture.requestBody));
    expect(honest.status).toBe(200);
    expect(await honest.json()).toMatchObject({ result: { laneId: settledBody.result.laneId, replayed: true } });
  }, 30_000);

  it.each([
    ['a non-object', 'not-an-object'],
    ['an unsupported field', { expectedGeneration: 'g', expectedCandidateLaneId: 'l', force: true }],
    ['an empty generation', { expectedGeneration: '   ', expectedCandidateLaneId: 'lane-1' }],
    ['a missing candidate lane', { expectedGeneration: 'g' }],
  ] as const)('rejects recovery evidence that is %s', async (label, recovery) => {
    const fixture = buildFixture(`evidence-${label.replace(/[^a-z]+/gi, '-')}`);
    await interruptAfterHold(fixture);

    const response = await resetRoute.POST(operatorPost({ ...fixture.requestBody, recovery }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_recovery_evidence' } });
    // Rejected before any reconciliation ran.
    expect(getLane(fixture.laneId)).toMatchObject({ status: 'paused', packetId: fixture.packetId });
    expect(journalEntry(fixture.requestKey)?.phase).toBe('guarded');
  }, 30_000);

});
