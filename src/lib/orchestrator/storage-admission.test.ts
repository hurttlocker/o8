import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import type { OrchestratorPacket } from './types';
import {
  createPacketStorageAdmissionCoordinator,
  PacketStorageAdmissionError,
  reconcileExpiredPacketStorageReservations,
  resolveDurablePacketStorageOwner,
  type RepoStorageEstimate,
} from './storage-admission';
import { resolveManagedWorktreeStorageTarget } from '@/lib/worktree/root-layout';
import {
  StorageAdmissionStore,
  type StorageVolumeObservation,
} from '@/lib/workspace/storage-admission';

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function sqlite(): Database.Database {
  const db = new Database(':memory:');
  ensureV38StorageAdmissionSchema(db);
  databases.push(db);
  return db;
}

function packet(id: string, launchAttempts = 0): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: id,
    summary: id,
    workspaceTargetPath: '/repo',
    branchTarget: `inline/${id}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    launchAttempts,
  };
}

function observed(at: number, availableBytes = 1_000): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath: '/repo',
    probePath: '/',
    volumeId: 'device:test',
    availableBytes,
    freeBytes: availableBytes,
    totalBytes: 1_000,
    observedAt: at,
    error: null,
  };
}

function estimate(bytes: number, paths: string[] = []): RepoStorageEstimate {
  return {
    status: 'observed',
    exactBytes: bytes,
    source: paths.length > 0 ? 'same-repo-history' : 'source-size-fallback',
    historySamples: paths.length,
    workspacePaths: paths,
    error: null,
  };
}

function coordinator(input: {
  db?: Database.Database;
  availableBytes?: number;
  estimate?: RepoStorageEstimate;
  currentPaths?: string[];
  reservationTarget?: string;
  volumeId?: string;
}) {
  const db = input.db ?? sqlite();
  const targetPath = input.reservationTarget ?? '/repo';
  const observeVolume = async (target: string) => ({
    ...observed(1_000, input.availableBytes ?? 1_000),
    targetPath: resolve(target),
    volumeId: input.volumeId ?? 'device:test',
  });
  const store = new StorageAdmissionStore(db, {
    now: () => 1_000,
    observeVolume,
  });
  return createPacketStorageAdmissionCoordinator({
    sqlite: db,
    store,
    now: () => 1_000,
    observeEstimate: async () => input.estimate ?? estimate(300),
    observeWorkspacePaths: async () => input.currentPaths ?? [],
    resolveReservationTarget: () => targetPath,
    observeReservationVolume: observeVolume,
    resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('packet dispatch storage admission', () => {
  it('reserves the configured managed worktree root volume instead of the repository volume', async () => {
    const directory = mkdtempSync(join(os.tmpdir(), 'o8-admission-target-volume-'));
    temporaryDirectories.push(directory);
    const repoPath = join(directory, 'repo');
    const managedRoot = join(directory, 'managed-root');
    mkdirSync(repoPath);
    mkdirSync(managedRoot);
    vi.stubEnv('O8_WORKTREE_ROOT', managedRoot);
    const targetPath = resolveManagedWorktreeStorageTarget(repoPath);
    const canonicalManagedRoot = realpathSync.native(managedRoot);
    const candidate = packet('managed-volume');
    candidate.workspaceTargetPath = repoPath;
    const db = sqlite();
    const observeVolume = async (target: string) => ({
      ...observed(1_000),
      targetPath: resolve(target),
      volumeId: resolve(target).startsWith(`${canonicalManagedRoot}/`) ? 'device:managed' : 'device:repo',
    });
    const admission = createPacketStorageAdmissionCoordinator({
      sqlite: db,
      store: new StorageAdmissionStore(db, { now: () => 1_000, observeVolume }),
      now: () => 1_000,
      observeEstimate: async () => estimate(300),
      observeWorkspacePaths: async () => [],
      observeReservationVolume: observeVolume,
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    });

    const lease = await admission.reserveForLaunch(candidate);
    expect(lease.reservation).toMatchObject({
      targetPath,
      volumeId: 'device:managed',
    });
    expect(targetPath.startsWith(`${canonicalManagedRoot}/`)).toBe(true);
    expect(targetPath.endsWith('/.cortex-worktrees')).toBe(true);
    expect(targetPath.startsWith(`${repoPath}/`)).toBe(false);
  });

  it('reserves before launch and commits with physical and reservation truth separated', async () => {
    const admission = coordinator({});
    const lease = await admission.reserveForLaunch(packet('success'));
    expect(lease.receipt).toMatchObject({
      state: 'reserved',
      estimateBytes: 300,
      physicalAvailableBytes: 1_000,
      reservedBeforeBytes: 0,
      requiredReserveBytes: 100,
      dispatchHeadroomBytes: 900,
    });
    await expect(admission.commitAfterLaunch(lease)).resolves.toMatchObject({
      state: 'committed',
      reason: 'committed',
    });
  });

  it('holds low-space and unknown-accounting launches with a packet receipt', async () => {
    await expect(coordinator({ availableBytes: 350 }).reserveForLaunch(packet('low-space')))
      .rejects.toMatchObject({
        receipt: { state: 'held', reason: 'reserve_breached', estimateBytes: 300 },
      });
    const unknown = coordinator({
      estimate: {
        status: 'unknown',
        exactBytes: null,
        source: 'unknown',
        historySamples: 0,
        workspacePaths: [],
        error: 'permission denied',
      },
    });
    await expect(unknown.reserveForLaunch(packet('unknown')))
      .rejects.toBeInstanceOf(PacketStorageAdmissionError);
    await expect(unknown.reserveForLaunch(packet('unknown')))
      .rejects.toMatchObject({ receipt: { state: 'held', reason: expect.stringContaining('estimate_unknown') } });
  });

  it('serializes concurrent packet reservations so one volume cannot be overcommitted', async () => {
    const db = sqlite();
    const admission = coordinator({ db, estimate: estimate(500) });
    const results = await Promise.allSettled([
      admission.reserveForLaunch(packet('concurrent-a')),
      admission.reserveForLaunch(packet('concurrent-b')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const active = db.prepare(
      "SELECT COUNT(*) FROM storage_admission_reservations WHERE state = 'reserved'",
    ).pluck().get();
    expect(active).toBe(1);
  });

  it('releases only a proven pre-effect launch failure and quarantines ambiguous effects', async () => {
    const clean = coordinator({ estimate: estimate(300, ['/repo/worktree-a']), currentPaths: ['/repo/worktree-a'] });
    const cleanLease = await clean.reserveForLaunch(packet('pre-effect'));
    await expect(clean.settleFailedLaunch(packet('pre-effect'), cleanLease)).resolves.toMatchObject({
      state: 'released',
      reason: 'released',
    });

    const ambiguous = coordinator({ estimate: estimate(300), currentPaths: ['/repo/new-worktree'] });
    const ambiguousLease = await ambiguous.reserveForLaunch(packet('ambiguous'));
    await expect(ambiguous.settleFailedLaunch(packet('ambiguous'), ambiguousLease)).resolves.toMatchObject({
      state: 'quarantined',
      reason: 'launch_effect_unknown',
    });
  });

  it('reuses the durable launch-attempt decision after restart without creating another reservation', async () => {
    const db = sqlite();
    const first = coordinator({ db, estimate: estimate(300) });
    const initial = await first.reserveForLaunch(packet('restart'));
    const restarted = coordinator({ db, estimate: estimate(900) });
    const replay = await restarted.reserveForLaunch(packet('restart'));
    expect(replay.reservation.reservationId).toBe(initial.reservation.reservationId);
    expect(replay.reservation.exactBytes).toBe(300);
    expect(replay.receipt.estimateBytes).toBe(300);
    expect(db.prepare('SELECT COUNT(*) FROM storage_admission_reservations').pluck().get()).toBe(1);
  });

  it('holds a replay when the managed target volume identity changed', async () => {
    const db = sqlite();
    await coordinator({ db, reservationTarget: '/managed', volumeId: 'device:one' })
      .reserveForLaunch(packet('volume-replay'));
    await expect(coordinator({
      db,
      reservationTarget: '/managed',
      volumeId: 'device:two',
    }).reserveForLaunch(packet('volume-replay'))).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'volume_conflict' },
    });
  });

  it('holds when the managed root resolver is unknown or changes across replay', async () => {
    const db = sqlite();
    const store = new StorageAdmissionStore(db, {
      now: () => 1_000,
      observeVolume: async () => observed(1_000),
    });
    const dependencies = {
      sqlite: db,
      store,
      now: () => 1_000,
      observeEstimate: async () => estimate(300),
      observeWorkspacePaths: async () => [],
      observeReservationVolume: async () => observed(1_000),
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    };
    await createPacketStorageAdmissionCoordinator({
      ...dependencies,
      resolveReservationTarget: () => '/managed/one',
    }).reserveForLaunch(packet('target-change'));

    await expect(createPacketStorageAdmissionCoordinator({
      ...dependencies,
      resolveReservationTarget: () => '/managed/two',
    }).reserveForLaunch(packet('target-change'))).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'reservation_identity_conflict' },
    });
    await expect(createPacketStorageAdmissionCoordinator({
      ...dependencies,
      resolveReservationTarget: () => { throw new Error('layout unreadable'); },
    }).reserveForLaunch(packet('target-unknown'))).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'workspace_target_unknown: layout unreadable' },
    });

    const missingParent = mkdtempSync(join(os.tmpdir(), 'o8-missing-worktree-root-'));
    temporaryDirectories.push(missingParent);
    const missingRoot = join(missingParent, 'missing');
    vi.stubEnv('O8_WORKTREE_ROOT', missingRoot);
    const createdTarget = resolveManagedWorktreeStorageTarget('/repo', {
      ...process.env,
      O8_WORKTREE_ROOT: missingRoot,
    });
    expect(createdTarget).toContain(realpathSync(missingRoot));
    await expect(createPacketStorageAdmissionCoordinator(dependencies)
      .reserveForLaunch(packet('missing-root'))).resolves.toMatchObject({
      reservation: {
        rootIdentity: { canonicalPath: realpathSync(missingRoot) },
      },
    });
  });

  it('replays a same-epoch crash-persisted reservation after SQLite reopen', async () => {
    const directory = mkdtempSync(join(os.tmpdir(), 'o8-admission-crash-replay-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'admission.db');
    let db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    let store = new StorageAdmissionStore(db, {
      now: () => 1_000,
      observeVolume: async () => observed(1_000),
    });
    const initialCoordinator = createPacketStorageAdmissionCoordinator({
      sqlite: db,
      store,
      now: () => 1_000,
      observeEstimate: async () => estimate(300, ['/repo/existing']),
      observeWorkspacePaths: async () => ['/repo/existing'],
      resolveReservationTarget: (repoPath) => repoPath,
      observeReservationVolume: async () => observed(1_000),
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    });
    const initial = await initialCoordinator.reserveForLaunch(packet('crash-replay'));
    db.close();

    db = new Database(file);
    databases.push(db);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    store = new StorageAdmissionStore(db, {
      now: () => 1_100,
      observeVolume: async () => observed(1_100),
    });
    let estimateCalls = 0;
    let pathCalls = 0;
    const restarted = createPacketStorageAdmissionCoordinator({
      sqlite: db,
      store,
      now: () => 1_100,
      observeEstimate: async () => {
        estimateCalls += 1;
        return estimate(350, ['/repo/new']);
      },
      observeWorkspacePaths: async () => {
        pathCalls += 1;
        return ['/repo/existing'];
      },
      resolveReservationTarget: (repoPath) => repoPath,
      observeReservationVolume: async () => observed(1_100),
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    });

    const replay = await restarted.reserveForLaunch(packet('crash-replay'));
    expect(replay.receipt).toMatchObject({
      state: 'reserved',
      reservationId: 'packet-storage:crash-replay:1',
      ownerGeneration: 1,
      estimateBytes: 300,
      estimateSource: 'unknown',
    });
    expect(replay.reservation).toEqual(initial.reservation);
    expect(replay.baselineWorkspacePaths).toEqual(['/repo/existing']);
    expect(estimateCalls).toBe(0);
    expect(pathCalls).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM storage_admission_reservations').pluck().get()).toBe(1);
  });

  it('holds replay when its lease expires during the live volume probe after reopen', async () => {
    const directory = mkdtempSync(join(os.tmpdir(), 'o8-admission-replay-clock-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'admission.db');
    let now = 1_000;
    let db = new Database(file);
    ensureV38StorageAdmissionSchema(db);
    let store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now),
    });
    await store.reserve({
      mutationId: 'packet-storage-reserve:slow-replay:1',
      reservationId: 'packet-storage:slow-replay:1',
      targetPath: '/repo',
      exactBytes: 200,
      ownerId: 'slow-replay',
      ownerGeneration: 1,
      leaseExpiresAt: 1_100,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 100 },
    });
    db.close();

    db = new Database(file);
    databases.push(db);
    ensureV38StorageAdmissionSchema(db);
    store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now),
    });
    const restarted = createPacketStorageAdmissionCoordinator({
      sqlite: db,
      store,
      now: () => now,
      observeEstimate: async () => estimate(200),
      observeWorkspacePaths: async () => [],
      resolveReservationTarget: (repoPath) => repoPath,
      observeReservationVolume: async () => {
        now = 1_200;
        return observed(now);
      },
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    });

    await expect(restarted.reserveForLaunch(packet('slow-replay'))).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'lease_expired', recordedAt: 1_200 },
    });
  });

  it('uses authoritative terminal state and lease truth when replaying after SQLite reopen', async () => {
    const directory = mkdtempSync(join(os.tmpdir(), 'o8-admission-authoritative-replay-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'admission.db');
    let now = 1_000;
    let db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    let store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now),
    });
    for (const id of ['released-replay', 'committed-replay', 'reconciled-replay', 'expired-replay']) {
      await store.reserve({
        mutationId: `packet-storage-reserve:${id}:1`,
        reservationId: `packet-storage:${id}:1`,
        targetPath: '/repo',
        exactBytes: 200,
        ownerId: id,
        ownerGeneration: 1,
        leaseExpiresAt: 1_100,
        policy: { reserveRatio: 0.1, absoluteFloorBytes: 100 },
      });
    }
    await store.release({
      mutationId: 'packet-storage-release:released-replay:1',
      reservationId: 'packet-storage:released-replay:1',
      volumeId: 'device:test',
      ownerId: 'released-replay',
      ownerGeneration: 1,
      expectedGeneration: 1,
    });
    await store.commit({
      mutationId: 'packet-storage-commit:committed-replay:1',
      reservationId: 'packet-storage:committed-replay:1',
      volumeId: 'device:test',
      ownerId: 'committed-replay',
      ownerGeneration: 1,
      expectedGeneration: 1,
    });
    now = 1_200;
    await store.reconcile({
      mutationId: 'packet-storage-reconcile:reconciled-replay:1:1200',
      reservationId: 'packet-storage:reconciled-replay:1',
      volumeId: 'device:test',
      ownerId: 'reconciled-replay',
      ownerGeneration: 1,
      expectedGeneration: 1,
      ownerLiveness: 'dead',
      ownerDeathReceipt: {
        source: 'packet-generation',
        evidence: 'Durable generation 2 superseded generation 1.',
        observedAt: now,
        reservationId: 'packet-storage:reconciled-replay:1',
        volumeId: 'device:test',
        ownerId: 'reconciled-replay',
        ownerGeneration: 1,
      },
    });
    db.close();

    db = new Database(file);
    databases.push(db);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now),
    });
    let estimateCalls = 0;
    let pathCalls = 0;
    const restarted = createPacketStorageAdmissionCoordinator({
      sqlite: db,
      store,
      now: () => now,
      observeEstimate: async () => {
        estimateCalls += 1;
        return estimate(100);
      },
      observeWorkspacePaths: async () => {
        pathCalls += 1;
        return [];
      },
      resolveReservationTarget: (repoPath) => repoPath,
      observeReservationVolume: async () => observed(now),
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 100 }),
    });

    for (const id of ['released-replay', 'reconciled-replay']) {
      await expect(restarted.reserveForLaunch(packet(id))).resolves.toMatchObject({
        receipt: { state: 'reserved', ownerGeneration: 2 },
      });
    }
    await expect(restarted.reserveForLaunch(packet('expired-replay'))).rejects.toMatchObject({
      receipt: { state: 'held', reason: 'lease_expired', ownerGeneration: 1 },
    });
    const committed = await restarted.reserveForLaunch(packet('committed-replay'));
    expect(committed).toMatchObject({
      receipt: { state: 'committed', reason: 'committed' },
      reservation: { state: 'committed', generation: 2 },
      baselineWorkspacePaths: null,
    });
    await expect(restarted.commitAfterLaunch(committed)).resolves.toEqual(committed.receipt);
    expect(estimateCalls).toBe(2);
    expect(pathCalls).toBe(0);
  });

  it('uses the prior durable receipt as the generation floor after reset frees space', async () => {
    const db = sqlite();
    const previousPacket = packet('reset-after-hold');
    let heldReceipt: OrchestratorPacket['storageAdmission'] = null;
    try {
      await coordinator({ db, availableBytes: 350 }).reserveForLaunch(previousPacket);
    } catch (error) {
      expect(error).toBeInstanceOf(PacketStorageAdmissionError);
      heldReceipt = (error as PacketStorageAdmissionError).receipt;
    }
    expect(heldReceipt).toMatchObject({
      state: 'held',
      ownerGeneration: 1,
      mutationId: 'packet-storage-reserve:reset-after-hold:1',
    });

    const resetPacket = {
      ...previousPacket,
      launchAttempts: 0,
      status: 'queued' as const,
      queueState: 'queued' as const,
      storageAdmission: heldReceipt,
    };
    const lease = await coordinator({ db, availableBytes: 1_000 }).reserveForLaunch(resetPacket);
    expect(lease.receipt).toMatchObject({
      state: 'reserved',
      ownerGeneration: 2,
      mutationId: 'packet-storage-reserve:reset-after-hold:2',
      physicalAvailableBytes: 1_000,
    });
    expect(db.prepare(
      "SELECT COUNT(*) FROM storage_admission_reservations WHERE state = 'reserved'",
    ).pluck().get()).toBe(1);
  });

  it('keeps reset-generation retries serialized after space becomes available', async () => {
    const db = sqlite();
    const heldPackets = await Promise.all(['reset-a', 'reset-b'].map(async (id) => {
      const original = packet(id);
      try {
        await coordinator({ db, availableBytes: 550, estimate: estimate(500) })
          .reserveForLaunch(original);
      } catch (error) {
        expect(error).toBeInstanceOf(PacketStorageAdmissionError);
        return {
          ...original,
          launchAttempts: 0,
          storageAdmission: (error as PacketStorageAdmissionError).receipt,
        };
      }
      throw new Error('The first generation should have been held.');
    }));

    const available = coordinator({ db, availableBytes: 1_000, estimate: estimate(500) });
    const results = await Promise.allSettled(
      heldPackets.map((candidate) => available.reserveForLaunch(candidate)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.map((result) => (
      result.status === 'fulfilled'
        ? result.value.receipt.ownerGeneration
        : (result.reason as PacketStorageAdmissionError).receipt.ownerGeneration
    ))).toEqual([2, 2]);
    expect(db.prepare(
      "SELECT COUNT(*) FROM storage_admission_reservations WHERE state = 'reserved'",
    ).pluck().get()).toBe(1);
  });

  it('reconciles only an expired owner superseded by durable packet truth after SQLite reopen', async () => {
    const directory = mkdtempSync(join(os.tmpdir(), 'o8-packet-admission-startup-'));
    temporaryDirectories.push(directory);
    const file = join(directory, 'admission.db');
    let now = 1_000;
    let db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    let store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now, 1_000),
    });
    for (const id of ['dead', 'live', 'unknown']) {
      await store.reserve({
        mutationId: `reserve-${id}`,
        reservationId: `packet-storage:${id}:1`,
        targetPath: '/repo',
        exactBytes: 200,
        ownerId: id,
        ownerGeneration: 1,
        leaseExpiresAt: 1_100,
        policy: { reserveRatio: 0.1, absoluteFloorBytes: 100 },
      });
    }
    db.close();

    now = 2_000;
    db = new Database(file);
    databases.push(db);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    ensureV38StorageAdmissionSchema(db);
    store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => observed(now, 800),
    });
    const deadPacket = packet('dead');
    deadPacket.storageAdmission = {
      schema: 'o8/packet-storage-admission/v1',
      state: 'held',
      reason: 'reserve_breached',
      reservationId: 'packet-storage:dead:2',
      mutationId: 'packet-storage-reserve:dead:2',
      ownerId: 'dead',
      ownerGeneration: 2,
      estimateBytes: 200,
      estimateSource: 'source-size-fallback',
      historySamples: 0,
      volumeId: 'device:test',
      physicalAvailableBytes: 800,
      reservedBeforeBytes: 600,
      requiredReserveBytes: 100,
      dispatchHeadroomBytes: 700,
      pressure: null,
      recordedAt: now,
    };
    const livePacket = packet('live');
    livePacket.storageAdmission = {
      ...deadPacket.storageAdmission,
      state: 'quarantined',
      reason: 'launch_effect_unknown',
      reservationId: 'packet-storage:live:1',
      mutationId: 'packet-storage-reserve:live:1',
      ownerId: 'live',
      ownerGeneration: 1,
    };

    const result = await reconcileExpiredPacketStorageReservations({
      store,
      now: () => now,
      resolveOwner: (reservation) => resolveDurablePacketStorageOwner(
        reservation,
        reservation.ownerId === 'unknown' ? [] : [deadPacket, livePacket],
      ),
    });
    expect(result).toEqual({
      inspected: 3,
      reconciled: 1,
      retainedLive: 1,
      retainedUnknown: 1,
      held: 0,
    });
    expect(db.prepare(`
      SELECT owner_id, state FROM storage_admission_reservations ORDER BY owner_id
    `).all()).toEqual([
      { owner_id: 'dead', state: 'reconciled' },
      { owner_id: 'live', state: 'reserved' },
      { owner_id: 'unknown', state: 'reserved' },
    ]);
  });

  it('records an accounting hold without poisoning the next exact startup retry', async () => {
    const db = sqlite();
    let now = 1_000;
    let accountingObserved = true;
    const store = new StorageAdmissionStore(db, {
      now: () => now,
      observeVolume: async () => accountingObserved
        ? observed(now, 900)
        : {
            ...observed(now, 900),
            status: 'unknown',
            volumeId: null,
            availableBytes: null,
            freeBytes: null,
            totalBytes: null,
            error: { code: 'EIO', message: 'volume probe failed' },
          },
    });
    await store.reserve({
      mutationId: 'reserve-retry',
      reservationId: 'packet-storage:retry:1',
      targetPath: '/repo',
      exactBytes: 200,
      ownerId: 'retry',
      ownerGeneration: 1,
      leaseExpiresAt: 1_100,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 100 },
    });

    now = 2_000;
    accountingObserved = false;
    const owner = async () => ({
      liveness: 'dead' as const,
      source: 'packet-generation',
      evidence: 'Durable generation 2 superseded generation 1.',
    });
    await expect(reconcileExpiredPacketStorageReservations({
      store,
      now: () => now,
      resolveOwner: owner,
    })).resolves.toMatchObject({ inspected: 1, reconciled: 0, held: 1 });

    now = 2_010;
    accountingObserved = true;
    await expect(reconcileExpiredPacketStorageReservations({
      store,
      now: () => now,
      resolveOwner: owner,
    })).resolves.toMatchObject({ inspected: 1, reconciled: 1, held: 0 });
    expect(db.prepare(`
      SELECT mutation_id FROM storage_admission_mutations
      WHERE operation = 'reconcile' ORDER BY recorded_at
    `).pluck().all()).toEqual([
      'packet-storage-reconcile:packet-storage:retry:1:1:2000',
      'packet-storage-reconcile:packet-storage:retry:1:1:2010',
    ]);
  });
});
