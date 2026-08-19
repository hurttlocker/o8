import { lstat, unlink } from 'node:fs/promises';

import { getSqlite } from '@/lib/db';
import {
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  classifyDependencyLeaseDevices,
  listLiveDependencyImageDevices,
  listMountedFilesystems,
  relatedDependencyLeaseDevices,
  unmountDependencyImageDevice,
  type DependencyImageDeviceAuthority,
  type DependencyImageDeviceAuthoritySeams,
  type HdiImageInfo,
  type HdiSystemEntity,
  type MountedFilesystem,
} from './dependency-image-device-authority';
import {
  recordAttachedDependencySeedLease,
  readDependencySeedLease,
  removePreparedDependencySeedLease,
  type DependencySeedImageRecord,
  type DependencySeedLeaseRecord,
} from './dependency-seed-registry';

/** ~3s of bounded re-observation for a helper that has not exited yet. */
const DETACH_SETTLE_ATTEMPTS = 15;
const DETACH_SETTLE_INTERVAL_MS = 200;

export type DependencySeedCleanupPhase = 'planned' | 'detaching' | 'verifying' | 'blocked';
export type DependencySeedCleanupTargetState = 'planned' | 'absent';

export interface DependencySeedCleanupAction {
  leaseId: string;
  phase: DependencySeedCleanupPhase;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DependencySeedCleanupTarget extends DependencyImageDeviceAuthority {
  leaseId: string;
  imagePath: string;
  shadowPath: string;
  mountPath: string;
  provenance: 'attested' | 'lease' | 'attach-recovery';
  state: DependencySeedCleanupTargetState;
  createdAt: number;
  updatedAt: number;
}

export interface DependencySeedCleanupOptions {
  afterShadowUnlinked?: (leaseId: string) => Promise<void>;
  afterTargetAbsent?: (leaseId: string, rootDeviceEntry: string) => Promise<void>;
  unmountDevice?: (deviceEntry: string) => Promise<void>;
  listDevices?: () => Promise<HdiImageInfo[]>;
  listMounts?: () => Promise<MountedFilesystem[]>;
  authoritySeams?: Omit<DependencyImageDeviceAuthoritySeams, 'listDevices'>;
}

interface ActionRow {
  lease_id: string;
  phase: string;
  reason: string | null;
  created_at: number;
  updated_at: number;
}

interface TargetRow {
  lease_id: string;
  root_device_entry: string;
  system_entities_json: string;
  helper_pid: number;
  helper_identity_json: string;
  base_device: number;
  base_inode: number;
  shadow_device: number;
  shadow_inode: number;
  image_path: string;
  shadow_path: string;
  mount_path: string;
  provenance: string;
  state: string;
  created_at: number;
  updated_at: number;
}

let initializedDatabasePath: string | null = null;

function sqlite() {
  const db = getSqlite();
  if (initializedDatabasePath !== db.name) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_seed_lease_cleanup_actions (
        lease_id TEXT PRIMARY KEY,
        phase TEXT NOT NULL CHECK (phase IN ('planned', 'detaching', 'verifying', 'blocked')),
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (lease_id) REFERENCES dependency_seed_leases(lease_id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS dependency_seed_lease_cleanup_targets (
        lease_id TEXT NOT NULL,
        root_device_entry TEXT NOT NULL,
        system_entities_json TEXT NOT NULL,
        helper_pid INTEGER NOT NULL,
        helper_identity_json TEXT NOT NULL,
        base_device INTEGER NOT NULL,
        base_inode INTEGER NOT NULL,
        shadow_device INTEGER NOT NULL,
        shadow_inode INTEGER NOT NULL,
        image_path TEXT NOT NULL,
        shadow_path TEXT NOT NULL,
        mount_path TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK (provenance IN ('attested', 'lease', 'attach-recovery')),
        state TEXT NOT NULL CHECK (state IN ('planned', 'absent')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (lease_id, root_device_entry),
        FOREIGN KEY (lease_id) REFERENCES dependency_seed_lease_cleanup_actions(lease_id) ON DELETE RESTRICT
      );
    `);
    initializedDatabasePath = db.name;
  }
  return db;
}

function decodeAction(row: ActionRow): DependencySeedCleanupAction {
  return {
    leaseId: row.lease_id,
    phase: row.phase as DependencySeedCleanupPhase,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decodeTarget(row: TargetRow): DependencySeedCleanupTarget {
  return {
    leaseId: row.lease_id,
    rootDeviceEntry: row.root_device_entry,
    systemEntities: JSON.parse(row.system_entities_json) as HdiSystemEntity[],
    helperPid: row.helper_pid,
    helperIdentity: JSON.parse(row.helper_identity_json),
    baseDevice: row.base_device,
    baseInode: row.base_inode,
    shadowDevice: row.shadow_device,
    shadowInode: row.shadow_inode,
    imagePath: row.image_path,
    shadowPath: row.shadow_path,
    mountPath: row.mount_path,
    provenance: row.provenance as DependencySeedCleanupTarget['provenance'],
    state: row.state as DependencySeedCleanupTargetState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function readDependencySeedLeaseCleanupAction(
  leaseId: string,
): DependencySeedCleanupAction | null {
  const row = sqlite().prepare(`
    SELECT * FROM dependency_seed_lease_cleanup_actions WHERE lease_id = ?
  `).get(leaseId) as ActionRow | undefined;
  return row ? decodeAction(row) : null;
}

export function listDependencySeedLeaseCleanupTargets(
  leaseId: string,
): DependencySeedCleanupTarget[] {
  return (sqlite().prepare(`
    SELECT * FROM dependency_seed_lease_cleanup_targets
    WHERE lease_id = ? ORDER BY root_device_entry ASC
  `).all(leaseId) as TargetRow[]).map(decodeTarget);
}

function sameTarget(first: DependencySeedCleanupTarget, second: DependencySeedCleanupTarget): boolean {
  return first.rootDeviceEntry === second.rootDeviceEntry
    && first.helperPid === second.helperPid
    && sameMetadataLockProcessIdentity(first.helperIdentity, second.helperIdentity)
    && first.baseDevice === second.baseDevice && first.baseInode === second.baseInode
    && first.shadowDevice === second.shadowDevice && first.shadowInode === second.shadowInode
    && first.imagePath === second.imagePath && first.shadowPath === second.shadowPath
    && first.mountPath === second.mountPath && first.provenance === second.provenance
    && JSON.stringify(first.systemEntities) === JSON.stringify(second.systemEntities);
}

export function planDependencySeedLeaseCleanup(input: {
  leaseId: string;
  targets: Array<Omit<DependencySeedCleanupTarget, 'leaseId' | 'state' | 'createdAt' | 'updatedAt'>>;
  reason: string;
  now?: number;
}): DependencySeedCleanupAction {
  if (input.targets.length === 0) throw new Error('Dependency image cleanup requires exact targets.');
  if (new Set(input.targets.map((target) => target.rootDeviceEntry)).size !== input.targets.length) {
    throw new Error('Dependency image cleanup requires unique exact root targets.');
  }
  const db = sqlite();
  const plan = db.transaction(() => {
    const now = input.now ?? Date.now();
    const lease = readDependencySeedLease(input.leaseId);
    if (!lease) throw new Error('Dependency image cleanup lost its durable lease.');
    db.prepare(`
      INSERT INTO dependency_seed_lease_cleanup_actions (
        lease_id, phase, reason, created_at, updated_at
      ) VALUES (?, 'planned', ?, ?, ?)
      ON CONFLICT(lease_id) DO UPDATE SET
        phase = CASE WHEN phase = 'blocked' THEN 'planned' ELSE phase END,
        reason = excluded.reason, updated_at = excluded.updated_at
    `).run(input.leaseId, input.reason, now, now);
    for (const target of input.targets) {
      db.prepare(`
        INSERT OR IGNORE INTO dependency_seed_lease_cleanup_targets (
          lease_id, root_device_entry, system_entities_json,
          helper_pid, helper_identity_json, base_device, base_inode,
          shadow_device, shadow_inode, image_path, shadow_path, mount_path,
          provenance, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)
      `).run(
        input.leaseId,
        target.rootDeviceEntry,
        JSON.stringify(target.systemEntities),
        target.helperPid,
        JSON.stringify(target.helperIdentity),
        target.baseDevice,
        target.baseInode,
        target.shadowDevice,
        target.shadowInode,
        target.imagePath,
        target.shadowPath,
        target.mountPath,
        target.provenance,
        now,
        now,
      );
    }
    const stored = listDependencySeedLeaseCleanupTargets(input.leaseId);
    if (stored.length !== input.targets.length || input.targets.some((target) => {
      const durable = stored.find((candidate) => (
        candidate.rootDeviceEntry === target.rootDeviceEntry
      ));
      const expected = {
        ...target,
        leaseId: input.leaseId,
        state: 'planned' as const,
        createdAt: now,
        updatedAt: now,
      };
      return !durable || !sameTarget(durable, expected);
    })) {
      throw new Error('Dependency image cleanup target set differs from durable authority.');
    }
    db.prepare(`
      UPDATE dependency_seed_leases SET state = 'detaching', updated_at = ?
      WHERE lease_id = ? AND state IN ('mounting', 'mounted', 'detaching', 'blocked')
    `).run(now, input.leaseId);
    return readDependencySeedLeaseCleanupAction(input.leaseId)!;
  });
  return plan.immediate();
}

export function blockDependencySeedLeaseCleanup(
  leaseId: string,
  reason: string,
  now = Date.now(),
): DependencySeedCleanupAction {
  const db = sqlite();
  const block = db.transaction(() => {
    if (!readDependencySeedLease(leaseId)) {
      throw new Error('Dependency image cleanup cannot block a missing lease.');
    }
    db.prepare(`
      INSERT INTO dependency_seed_lease_cleanup_actions (
        lease_id, phase, reason, created_at, updated_at
      ) VALUES (?, 'blocked', ?, ?, ?)
      ON CONFLICT(lease_id) DO UPDATE SET
        phase = 'blocked', reason = excluded.reason, updated_at = excluded.updated_at
    `).run(leaseId, reason, now, now);
    db.prepare(`
      UPDATE dependency_seed_leases SET state = 'blocked', updated_at = ? WHERE lease_id = ?
    `).run(now, leaseId);
    return readDependencySeedLeaseCleanupAction(leaseId)!;
  });
  return block.immediate();
}

export function transitionDependencySeedLeaseCleanup(
  leaseId: string,
  phase: Exclude<DependencySeedCleanupPhase, 'blocked'>,
  now = Date.now(),
): DependencySeedCleanupAction {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_lease_cleanup_actions SET phase = ?, reason = NULL, updated_at = ?
    WHERE lease_id = ? AND phase != 'blocked'
  `).run(phase, now, leaseId);
  const current = readDependencySeedLeaseCleanupAction(leaseId);
  if (!current || (result.changes !== 1 && current.phase !== phase)) {
    throw new Error('Dependency image cleanup action lost its durable phase.');
  }
  return current;
}

export function markDependencySeedLeaseCleanupTargetAbsent(
  leaseId: string,
  rootDeviceEntry: string,
  now = Date.now(),
): void {
  const result = sqlite().prepare(`
    UPDATE dependency_seed_lease_cleanup_targets SET state = 'absent', updated_at = ?
    WHERE lease_id = ? AND root_device_entry = ? AND state IN ('planned', 'absent')
  `).run(now, leaseId, rootDeviceEntry);
  if (result.changes !== 1) throw new Error('Dependency image cleanup lost its exact target.');
}

export function completeDependencySeedLeaseCleanup(leaseId: string): void {
  const db = sqlite();
  const complete = db.transaction(() => {
    const action = readDependencySeedLeaseCleanupAction(leaseId);
    const targets = listDependencySeedLeaseCleanupTargets(leaseId);
    const lease = readDependencySeedLease(leaseId);
    if (!action || action.phase !== 'verifying' || targets.length === 0
      || targets.some((target) => target.state !== 'absent')
      || !lease || lease.state !== 'detaching') {
      throw new Error('Dependency image cleanup cannot release incomplete durable authority.');
    }
    db.prepare('DELETE FROM dependency_seed_lease_cleanup_targets WHERE lease_id = ?').run(leaseId);
    db.prepare('DELETE FROM dependency_seed_lease_cleanup_actions WHERE lease_id = ?').run(leaseId);
    const removed = db.prepare(`
      DELETE FROM dependency_seed_leases WHERE lease_id = ? AND state = 'detaching'
    `).run(leaseId);
    if (removed.changes !== 1) throw new Error('Dependency image cleanup lost its detaching lease.');
  });
  complete.immediate();
}

export async function unlinkExactDependencyShadow(
  lease: DependencySeedLeaseRecord,
): Promise<void> {
  let entry;
  try {
    entry = await lstat(lease.shadowPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && lease.state === 'detaching') return;
    throw error;
  }
  if (lease.shadowDevice === null || lease.shadowInode === null) {
    throw new Error('Dependency image shadow has no exact durable identity.');
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || entry.dev !== lease.shadowDevice || entry.ino !== lease.shadowInode) {
    throw new Error('Dependency image shadow identity drifted; it was preserved.');
  }
  await unlink(lease.shadowPath);
}

function authorityFromLease(lease: DependencySeedLeaseRecord): DependencyImageDeviceAuthority | null {
  if (!lease.attachedImagePath || !lease.deviceEntry || !lease.systemEntities
    || lease.helperPid === null || !lease.helperIdentity
    || lease.baseDevice === null || lease.baseInode === null
    || lease.shadowDevice === null || lease.shadowInode === null) return null;
  return {
    rootDeviceEntry: lease.deviceEntry,
    systemEntities: lease.systemEntities,
    helperPid: lease.helperPid,
    helperIdentity: lease.helperIdentity,
    baseDevice: lease.baseDevice,
    baseInode: lease.baseInode,
    shadowDevice: lease.shadowDevice,
    shadowInode: lease.shadowInode,
  };
}

async function cleanupTargetMountPath(
  lease: DependencySeedLeaseRecord,
  authority: DependencyImageDeviceAuthority,
): Promise<string> {
  const mounted = authority.systemEntities.flatMap((entity) => (
    entity.mountPath === null ? [] : [entity.mountPath]
  ));
  const named = mounted.filter((mountPath) => mountPath === lease.mountPath);
  if (named.length === 1) return named[0]!;
  // The workspace directory can be renamed out from under a live mount. The lease
  // stays the detach authority, so re-identify its leaf by the durable mount vnode
  // that was recorded at attach rather than by the name it used to carry.
  if (mounted.length === 0 || named.length > 1
    || lease.mountDevice === null || lease.mountInode === null) {
    throw new Error('Dependency image cleanup authority lost its requested mounted leaf.');
  }
  const drifted: string[] = [];
  for (const mountPath of mounted) {
    const entry = await lstat(mountPath).catch(() => null);
    if (entry && entry.dev === lease.mountDevice && entry.ino === lease.mountInode) {
      drifted.push(mountPath);
    }
  }
  if (drifted.length !== 1) {
    throw new Error('Dependency image cleanup authority lost its requested mounted leaf.');
  }
  return drifted[0]!;
}

async function cleanupTarget(
  lease: DependencySeedLeaseRecord,
  image: DependencySeedImageRecord | null,
  authority: DependencyImageDeviceAuthority,
  provenance: DependencySeedCleanupTarget['provenance'],
): Promise<Omit<DependencySeedCleanupTarget, 'leaseId' | 'state' | 'createdAt' | 'updatedAt'>> {
  const mountPath = await cleanupTargetMountPath(lease, authority);
  const imagePath = lease.attachedImagePath ?? image?.imagePath;
  if (!imagePath) throw new Error('Dependency image cleanup lost its invocation image path.');
  return {
    ...authority,
    imagePath,
    shadowPath: lease.shadowPath,
    mountPath,
    provenance,
  };
}

function cleanupTargetInput(
  target: DependencySeedCleanupTarget,
): Omit<DependencySeedCleanupTarget, 'leaseId' | 'state' | 'createdAt' | 'updatedAt'> {
  return {
    ...targetAuthority(target),
    imagePath: target.imagePath,
    shadowPath: target.shadowPath,
    mountPath: target.mountPath,
    provenance: target.provenance,
  };
}

function targetAuthority(target: DependencySeedCleanupTarget): DependencyImageDeviceAuthority {
  return {
    rootDeviceEntry: target.rootDeviceEntry,
    systemEntities: target.systemEntities,
    helperPid: target.helperPid,
    helperIdentity: target.helperIdentity,
    baseDevice: target.baseDevice,
    baseInode: target.baseInode,
    shadowDevice: target.shadowDevice,
    shadowInode: target.shadowInode,
  };
}

function exactCleanupMountedDevices(target: DependencySeedCleanupTarget): string[] {
  const mounted = target.systemEntities.filter((entity) => entity.mountPath !== null);
  if (mounted.length === 0
    || mounted.filter((entity) => entity.mountPath === target.mountPath).length !== 1) {
    throw new Error('Dependency image cleanup durable authority lost its requested mounted device.');
  }
  return mounted.map((entity) => entity.deviceEntry);
}

function targetDeviceIsMounted(
  target: DependencySeedCleanupTarget,
  mounts: MountedFilesystem[],
): boolean {
  const deviceEntries = new Set(target.systemEntities.map((entity) => entity.deviceEntry));
  return mounts.some((mount) => deviceEntries.has(mount.deviceEntry));
}

async function proveTargetAbsent(
  target: DependencySeedCleanupTarget,
  inventory: HdiImageInfo[],
  mounts: MountedFilesystem[],
  probeProcess = probeMetadataLockProcessIdentity,
): Promise<boolean> {
  const deviceEntries = new Set(target.systemEntities.map((entity) => entity.deviceEntry));
  if (inventory.some((device) => device.deviceEntry === target.rootDeviceEntry
    || device.helperPid === target.helperPid
    || device.systemEntities.some((entity) => deviceEntries.has(entity.deviceEntry)
      || entity.mountPath === target.mountPath))
    || mounts.some((mount) => deviceEntries.has(mount.deviceEntry)
      || mount.mountPath === target.mountPath)) return false;
  const helper = await probeProcess(target.helperPid);
  if (helper.state === 'unknown') {
    throw new Error('Dependency image cleanup cannot prove the helper process is absent.');
  }
  return helper.state === 'absent'
    || !sameMetadataLockProcessIdentity(helper.identity, target.helperIdentity);
}

function assertInventoryMatchesCleanupJournal(
  lease: DependencySeedLeaseRecord,
  targets: DependencySeedCleanupTarget[],
  inventory: HdiImageInfo[],
): void {
  const related = relatedDependencyLeaseDevices({
    lease,
    authorities: targets.map(targetAuthority),
    inventory,
  });
  const counts = new Map<string, number>();
  for (const device of related) {
    counts.set(device.deviceEntry, (counts.get(device.deviceEntry) ?? 0) + 1);
    const target = targets.find((candidate) => candidate.rootDeviceEntry === device.deviceEntry);
    if (!target) {
      throw new Error('Dependency cleanup found a related device outside the durable journal.');
    }
    if (target.state === 'absent') {
      throw new Error('Dependency cleanup found a target that was durably marked absent.');
    }
  }
  if ([...counts.values()].some((count) => count !== 1)) {
    throw new Error('Dependency cleanup inventory duplicated a durable root target.');
  }
}

async function detachReattestedUnmountedTarget(input: {
  target: DependencySeedCleanupTarget;
  lease: DependencySeedLeaseRecord;
  journalTargets: DependencySeedCleanupTarget[];
  inventory: HdiImageInfo[];
  mounts: MountedFilesystem[];
  detachDevice: (deviceEntry: string) => Promise<void>;
  listDevices: () => Promise<HdiImageInfo[]>;
  listMounts: () => Promise<MountedFilesystem[]>;
  authoritySeams: Omit<DependencyImageDeviceAuthoritySeams, 'listDevices'>;
}): Promise<HdiImageInfo[]> {
  if (targetDeviceIsMounted(input.target, input.mounts)) {
    throw new Error('Dependency image cleanup target remained mounted after normal unmount.');
  }
  const unmounted = await classifyDependencyLeaseDevices({
    lease: input.lease,
    imagePath: input.target.imagePath,
    expectedAuthority: targetAuthority(input.target),
    inventory: input.inventory.filter((device) => (
      device.deviceEntry === input.target.rootDeviceEntry
    )),
    purpose: 'cleanup',
    cleanupMountState: 'unmounted',
  }, input.authoritySeams);
  if (unmounted.state === 'absent') {
    if (!await proveTargetAbsent(
      input.target,
      input.inventory,
      input.mounts,
      input.authoritySeams.probeProcess,
    )) {
      throw new Error('Dependency image cleanup could not prove an absent target.');
    }
    return input.inventory;
  }
  if (unmounted.state !== 'exact') throw new Error(unmounted.reason);
  let detachError: unknown = null;
  try {
    await input.detachDevice(input.target.rootDeviceEntry);
  } catch (error) {
    detachError = error;
  }
  // hdiutil returns before its helper releases the image, so the inventory can still
  // carry the target — as a device-less record its helper still holds — for a short
  // window after a detach that landed. Re-observe on a bounded budget instead of
  // failing a cleanup that is only mid-teardown; a target that never clears still
  // fails closed with the same refusal.
  let observed: [HdiImageInfo[], MountedFilesystem[]] = [[], []];
  let settleError: unknown = null;
  for (let attempt = 0; attempt < DETACH_SETTLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, DETACH_SETTLE_INTERVAL_MS));
    }
    observed = await Promise.all([
      input.listDevices(),
      input.listMounts(),
    ]);
    try {
      assertInventoryMatchesCleanupJournal(input.lease, input.journalTargets, observed[0]);
      if (await proveTargetAbsent(
        input.target,
        observed[0],
        observed[1],
        input.authoritySeams.probeProcess,
      )) return observed[0];
      settleError = null;
    } catch (error) {
      settleError = error;
    }
  }
  if (settleError) throw settleError;
  const detail = detachError
    ? ` after detach reported: ${detachError instanceof Error ? detachError.message : String(detachError)}`
    : '';
  throw new Error(`Dependency image cleanup still contains its exact target${detail}.`);
}

async function ensureCleanupPlan(
  lease: DependencySeedLeaseRecord,
  image: DependencySeedImageRecord | null,
  options: DependencySeedCleanupOptions = {},
): Promise<'planned' | 'cancelled'> {
  const existingTargets = listDependencySeedLeaseCleanupTargets(lease.leaseId);
  if (existingTargets.length > 0) {
    planDependencySeedLeaseCleanup({
      leaseId: lease.leaseId,
      targets: existingTargets.map(cleanupTargetInput),
      reason: 'Resume durable dependency image cleanup.',
    });
    return 'planned';
  }
  const listDevices = options.listDevices ?? listLiveDependencyImageDevices;
  const persisted = authorityFromLease(lease);
  let inventory: HdiImageInfo[];
  try {
    inventory = await listDevices();
  } catch (error) {
    blockDependencySeedLeaseCleanup(
      lease.leaseId,
      `Disk image inventory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  let cleanupLease = lease;
  let classified: Awaited<ReturnType<typeof classifyDependencyLeaseDevices>>;
  if (!persisted) {
    const candidates = inventory.filter((device) => device.shadowPath === lease.shadowPath);
    if (candidates.length === 0) {
      try {
        await lstat(lease.shadowPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          removePreparedDependencySeedLease(lease.leaseId);
          return 'cancelled';
        }
        throw error;
      }
      const reason = 'Prepared dependency attach left a shadow without one live root.';
      blockDependencySeedLeaseCleanup(lease.leaseId, reason);
      throw new Error(reason);
    }
    if (candidates.length !== 1) {
      const reason = `Lease authority matched ${candidates.length} live devices.`;
      blockDependencySeedLeaseCleanup(lease.leaseId, reason);
      throw new Error(reason);
    }
    if (!image || image.generation !== lease.generation) {
      const reason = 'Prepared dependency attach lost its invocation image authority.';
      blockDependencySeedLeaseCleanup(lease.leaseId, reason);
      throw new Error(reason);
    }
    classified = await classifyDependencyLeaseDevices({
      lease,
      imagePath: image.imagePath,
      inventory: candidates,
      purpose: 'cleanup',
    }, options.authoritySeams);
    if (classified.state === 'exact') {
      const mount = await lstat(lease.mountPath);
      if (!mount.isDirectory() || mount.isSymbolicLink()) {
        const reason = 'Prepared dependency attach requested mount identity is unsafe.';
        blockDependencySeedLeaseCleanup(lease.leaseId, reason);
        throw new Error(reason);
      }
      cleanupLease = recordAttachedDependencySeedLease({
        leaseId: lease.leaseId,
        imagePath: candidates[0]!.imagePath,
        deviceEntry: classified.authority.rootDeviceEntry,
        systemEntities: classified.authority.systemEntities,
        helperPid: classified.authority.helperPid,
        helperIdentity: classified.authority.helperIdentity,
        baseDevice: classified.authority.baseDevice,
        baseInode: classified.authority.baseInode,
        shadowDevice: classified.authority.shadowDevice,
        shadowInode: classified.authority.shadowInode,
        mountDevice: mount.dev,
        mountInode: mount.ino,
      });
    }
  } else {
    classified = await classifyDependencyLeaseDevices({
      lease,
      imagePath: lease.attachedImagePath!,
      expectedAuthority: persisted,
      inventory,
      purpose: 'cleanup',
      cleanupMountState: 'partial',
    }, options.authoritySeams);
  }
  if (classified.state !== 'exact' && classified.state !== 'absent') {
    blockDependencySeedLeaseCleanup(lease.leaseId, classified.reason);
    throw new Error(classified.reason);
  }
  planDependencySeedLeaseCleanup({
    leaseId: lease.leaseId,
    targets: [await cleanupTarget(
      cleanupLease,
      image,
      classified.authority,
      persisted ? 'lease' : 'attach-recovery',
    )],
    reason: 'Dependency image lease cleanup requested.',
  });
  return 'planned';
}

export async function reconcileDependencyMountLeaseCleanup(
  leaseId: string,
  image: DependencySeedImageRecord | null,
  detachDevice: (deviceEntry: string) => Promise<void>,
  options: DependencySeedCleanupOptions = {},
): Promise<void> {
  const initial = readDependencySeedLease(leaseId);
  if (!initial) return;
  if (await ensureCleanupPlan(initial, image, options) === 'cancelled') return;
  try {
    const listDevices = options.listDevices ?? listLiveDependencyImageDevices;
    const listMounts = options.listMounts ?? listMountedFilesystems;
    const authoritySeams = options.authoritySeams ?? {};
    transitionDependencySeedLeaseCleanup(leaseId, 'detaching');
    let inventory = await listDevices();
    for (const target of listDependencySeedLeaseCleanupTargets(leaseId)) {
      if (target.state === 'absent') continue;
      const lease = readDependencySeedLease(leaseId);
      if (!lease) throw new Error('Dependency image cleanup lost its lease before detach.');
      const journalTargets = listDependencySeedLeaseCleanupTargets(leaseId);
      assertInventoryMatchesCleanupJournal(lease, journalTargets, inventory);
      const classified = await classifyDependencyLeaseDevices({
        lease,
        imagePath: target.imagePath,
        expectedAuthority: targetAuthority(target),
        inventory: inventory.filter((device) => (
          device.deviceEntry === target.rootDeviceEntry
        )),
        purpose: 'cleanup',
        cleanupMountState: 'partial',
      }, authoritySeams);
      if (classified.state === 'ambiguous') throw new Error(classified.reason);
      if (classified.state === 'exact') {
        const mountedDevices = new Set(exactCleanupMountedDevices(target));
        const liveMounted = classified.authority.systemEntities.filter((entity) => (
          entity.mountPath !== null
        ));
        if (liveMounted.some((entity) => !mountedDevices.has(entity.deviceEntry))) {
          throw new Error('Dependency image cleanup mounted device differs from durable authority.');
        }
        for (const mounted of liveMounted) {
          await (options.unmountDevice ?? unmountDependencyImageDevice)(mounted.deviceEntry);
        }
        const observed = await Promise.all([
          listDevices(),
          listMounts(),
        ]);
        assertInventoryMatchesCleanupJournal(lease, journalTargets, observed[0]);
        inventory = await detachReattestedUnmountedTarget({
          target,
          lease,
          journalTargets,
          inventory: observed[0],
          mounts: observed[1],
          detachDevice,
          listDevices,
          listMounts,
          authoritySeams,
        });
      } else if (classified.state === 'incomplete') {
        const mounts = await listMounts();
        inventory = await detachReattestedUnmountedTarget({
          target,
          lease,
          journalTargets,
          inventory,
          mounts,
          detachDevice,
          listDevices,
          listMounts,
          authoritySeams,
        });
      } else {
        const mounts = await listMounts();
        if (!await proveTargetAbsent(
          target,
          inventory,
          mounts,
          authoritySeams.probeProcess,
        )) {
          throw new Error('Dependency image cleanup could not prove an absent target.');
        }
      }
      markDependencySeedLeaseCleanupTargetAbsent(leaseId, target.rootDeviceEntry);
      await options.afterTargetAbsent?.(leaseId, target.rootDeviceEntry);
    }
    transitionDependencySeedLeaseCleanup(leaseId, 'verifying');
    const [finalInventory, finalMounts] = await Promise.all([
      listDevices(),
      listMounts(),
    ]);
    const finalTargets = listDependencySeedLeaseCleanupTargets(leaseId);
    const finalLease = readDependencySeedLease(leaseId);
    if (!finalLease) throw new Error('Dependency image cleanup lost its lease during final proof.');
    assertInventoryMatchesCleanupJournal(finalLease, finalTargets, finalInventory);
    if (relatedDependencyLeaseDevices({
      lease: finalLease,
      authorities: finalTargets.map(targetAuthority),
      inventory: finalInventory,
    }).length !== 0) {
      throw new Error('Dependency image cleanup final inventory contains an unremoved related device.');
    }
    for (const target of finalTargets) {
      if (target.state !== 'absent'
        || !await proveTargetAbsent(
          target,
          finalInventory,
          finalMounts,
          authoritySeams.probeProcess,
        )) {
        throw new Error('Dependency image cleanup final inventory still contains a related device.');
      }
    }
    const lease = readDependencySeedLease(leaseId);
    if (!lease) throw new Error('Dependency image cleanup lost its lease before shadow release.');
    const targets = listDependencySeedLeaseCleanupTargets(leaseId);
    const shadowAuthority = new Set(targets.map((target) => (
      `${target.shadowDevice}:${target.shadowInode}`
    )));
    if (shadowAuthority.size !== 1) {
      throw new Error('Dependency image cleanup targets disagree on exact shadow authority.');
    }
    const first = targets[0]!;
    await unlinkExactDependencyShadow({
      ...lease,
      shadowDevice: first.shadowDevice,
      shadowInode: first.shadowInode,
    });
    await options.afterShadowUnlinked?.(leaseId);
    completeDependencySeedLeaseCleanup(leaseId);
  } catch (error) {
    blockDependencySeedLeaseCleanup(
      leaseId,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function requestDependencyMountLeaseCleanup(
  lease: DependencySeedLeaseRecord,
  image: DependencySeedImageRecord | null,
  detachDevice: (deviceEntry: string) => Promise<void>,
  options: DependencySeedCleanupOptions = {},
): Promise<void> {
  await ensureCleanupPlan(lease, image, options);
  await reconcileDependencyMountLeaseCleanup(lease.leaseId, image, detachDevice, options);
}
