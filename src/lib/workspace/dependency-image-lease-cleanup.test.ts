import {
  lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import type { HdiImageInfo } from './dependency-image-device-authority';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-dependency-cleanup-journal-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb } = await import('@/lib/db');
const {
  beginDependencySeedImage,
  beginDependencySeedLease,
  bindMountedDependencySeedLease,
  listDependencySeedLeases,
  publishDependencySeedImage,
  readDependencySeedLease,
  recordAttachedDependencySeedLease,
  recordBuiltDependencySeedImage,
} = await import('./dependency-seed-registry');
const {
  listDependencySeedLeaseCleanupTargets,
  planDependencySeedLeaseCleanup,
  readDependencySeedLeaseCleanupAction,
  reconcileDependencyMountLeaseCleanup,
  requestDependencyMountLeaseCleanup,
} = await import('./dependency-image-lease-cleanup');

const processIdentity = {
  version: 1 as const,
  platform: 'darwin' as const,
  bootId: 'boot-session',
  startId: 'Sun Aug 17 01:00:00 2026',
};

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('dependency image lease cleanup journal', () => {
  it('replays a lower-level pre-journaled target set after the first target crashes', async () => {
    const recipeKey = 'recipe-cleanup-replay';
    const generation = 'generation-cleanup-replay';
    const imagePath = path.join(dataDir, 'image.dmg');
    const shadowPath = path.join(dataDir, 'image.shadow');
    const firstMount = path.join(dataDir, 'workspace', 'node_modules');
    const secondMount = path.join(dataDir, 'extra-mount');
    mkdirSync(firstMount, { recursive: true });
    mkdirSync(secondMount, { recursive: true });
    writeFileSync(imagePath, 'image');
    writeFileSync(shadowPath, 'shadow');
    const imageEntry = lstatSync(imagePath);
    const shadowEntry = lstatSync(shadowPath);
    const firstIdentity = { ...processIdentity, startId: 'helper-8001' };
    const secondIdentity = { ...processIdentity, startId: 'helper-8002' };
    const entities = (root: number, synthesized: number, mountPath: string) => [
      { deviceEntry: `/dev/disk${root}`, mountPath: null, contentHint: 'GUID_partition_scheme' },
      { deviceEntry: `/dev/disk${root}s1`, mountPath: null, contentHint: 'Apple_APFS' },
      { deviceEntry: `/dev/disk${synthesized}`, mountPath: null, contentHint: 'APFS' },
      { deviceEntry: `/dev/disk${synthesized}s1`, mountPath, contentHint: 'APFS' },
    ];
    let inventory: HdiImageInfo[] = [
      {
        imagePath,
        shadowPath,
        deviceEntry: '/dev/disk60',
        mountPath: firstMount,
        mountDevice: '/dev/disk61s1',
        systemEntities: entities(60, 61, firstMount),
        helperPid: 8001,
        writable: true,
      },
      {
        imagePath,
        shadowPath,
        deviceEntry: '/dev/disk70',
        mountPath: secondMount,
        mountDevice: '/dev/disk71s1',
        systemEntities: entities(70, 71, secondMount),
        helperPid: 8002,
        writable: true,
      },
    ];
    beginDependencySeedImage({
      recipeKey,
      generation,
      sourceReceiptId: 'source-cleanup-replay',
      sourceTreeDigest: 'source-tree-digest',
      publisherPid: 7001,
      publisherIdentity: processIdentity,
      imagePath,
      manifestPath: path.join(dataDir, 'image.manifest.json'),
      stagingDirectory: path.join(dataDir, 'staging'),
      stagingPath: path.join(dataDir, 'staging', 'image.dmg'),
      stagingDevice: 1,
      stagingInode: 2,
    });
    recordBuiltDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7001,
      publisherIdentity: processIdentity,
      imageDevice: imageEntry.dev,
      imageInode: imageEntry.ino,
      imageDigest: 'image-digest',
      manifestDevice: 5,
      manifestInode: 6,
      manifestDigest: 'manifest-digest',
    });
    const image = publishDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7001,
      publisherIdentity: processIdentity,
    });
    const prepared = beginDependencySeedLease({
      leaseId: 'lease-cleanup-replay',
      recipeKey,
      generation,
      workspacePath: path.join(dataDir, 'workspace'),
      shadowPath,
      mountPath: firstMount,
      ownerPid: 7001,
      ownerIdentity: processIdentity,
    });
    const mountEntry = lstatSync(firstMount);
    recordAttachedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk60',
      systemEntities: inventory[0]!.systemEntities,
      helperPid: 8001,
      helperIdentity: firstIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const lease = bindMountedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk60',
      systemEntities: inventory[0]!.systemEntities,
      helperPid: 8001,
      helperIdentity: firstIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const identityFor = (pid: number) => pid === 8001 ? firstIdentity : secondIdentity;
    const listDevices = async () => inventory;
    const listMounts = async () => inventory.flatMap((device) => (
      device.mountDevice && device.mountPath
        ? [{ deviceEntry: device.mountDevice, mountPath: device.mountPath }]
        : []
    ));
    const authoritySeams = {
      probeProcess: async (pid: number) => inventory.some((device) => device.helperPid === pid)
        ? { state: 'live' as const, identity: identityFor(pid) }
        : { state: 'absent' as const },
      listHelperFiles: async (pid: number) => ({
        pid,
        command: 'diskimages-helper',
        files: [
          {
            fd: '3', access: 'r', type: 'REG', device: imageEntry.dev,
            inode: imageEntry.ino, links: 1, name: imagePath,
          },
          {
            fd: '5', access: 'u', type: 'REG', device: shadowEntry.dev,
            inode: shadowEntry.ino, links: 1, name: shadowPath,
          },
        ],
      }),
    };
    const unmounted: string[] = [];
    const detached: string[] = [];
    const unmountDevice = async (deviceEntry: string) => {
      expect(listDependencySeedLeaseCleanupTargets(lease.leaseId)).toHaveLength(2);
      const device = inventory.find((candidate) => (
        candidate.systemEntities.some((entity) => entity.deviceEntry === deviceEntry)
      ));
      if (!device) throw new Error('test lost mounted device');
      unmounted.push(deviceEntry);
      device.mountPath = null;
      device.mountDevice = null;
      device.systemEntities = device.systemEntities.map((entity) => ({
        ...entity,
        mountPath: null,
      }));
    };
    const detachDevice = async (deviceEntry: string) => {
      detached.push(deviceEntry);
      inventory = inventory.filter((device) => device.deviceEntry !== deviceEntry);
    };
    planDependencySeedLeaseCleanup({
      leaseId: lease.leaseId,
      targets: inventory.map((device) => ({
        rootDeviceEntry: device.deviceEntry,
        systemEntities: device.systemEntities,
        helperPid: device.helperPid!,
        helperIdentity: identityFor(device.helperPid!),
        baseDevice: imageEntry.dev,
        baseInode: imageEntry.ino,
        shadowDevice: shadowEntry.dev,
        shadowInode: shadowEntry.ino,
        imagePath,
        shadowPath,
        mountPath: device.mountPath!,
        provenance: 'attested' as const,
      })),
      reason: 'Lower-level multi-target journal replay fixture.',
    });
    let crashInjected = false;
    await expect(reconcileDependencyMountLeaseCleanup(lease.leaseId, image, detachDevice, {
      listDevices,
      listMounts,
      authoritySeams,
      unmountDevice,
      afterTargetAbsent: async () => {
        if (!crashInjected) {
          crashInjected = true;
          throw new Error('simulated child crash after first target');
        }
      },
    })).rejects.toThrow('simulated child crash after first target');

    expect(unmounted).toEqual(['/dev/disk61s1']);
    expect(detached).toEqual(['/dev/disk60']);
    expect(readDependencySeedLeaseCleanupAction(lease.leaseId)).toMatchObject({ phase: 'blocked' });
    expect(listDependencySeedLeaseCleanupTargets(lease.leaseId).map((target) => ({
      root: target.rootDeviceEntry,
      state: target.state,
    }))).toEqual([
      { root: '/dev/disk60', state: 'absent' },
      { root: '/dev/disk70', state: 'planned' },
    ]);
    closeDb();

    await reconcileDependencyMountLeaseCleanup(lease.leaseId, image, detachDevice, {
      listDevices,
      listMounts,
      authoritySeams,
      unmountDevice,
    });
    expect(unmounted).toEqual(['/dev/disk61s1', '/dev/disk71s1']);
    expect(detached).toEqual(['/dev/disk60', '/dev/disk70']);
    expect(readDependencySeedLeaseCleanupAction(lease.leaseId)).toBeNull();
    expect(readDependencySeedLease(lease.leaseId)).toBeNull();
    expect(listDependencySeedLeases(recipeKey)).toEqual([]);
  });

  it('journals one root with every mounted leaf before normal unmount and detach', async () => {
    const recipeKey = 'recipe-cleanup-extra-leaf';
    const generation = 'generation-cleanup-extra-leaf';
    const imagePath = path.join(dataDir, 'extra-leaf-image.dmg');
    const shadowPath = path.join(dataDir, 'extra-leaf-image.shadow');
    const mountPath = path.join(dataDir, 'extra-leaf-workspace', 'node_modules');
    const extraMountPath = path.join(dataDir, 'extra-leaf-volume');
    mkdirSync(mountPath, { recursive: true });
    mkdirSync(extraMountPath, { recursive: true });
    writeFileSync(imagePath, 'image');
    writeFileSync(shadowPath, 'shadow');
    const imageEntry = lstatSync(imagePath);
    const shadowEntry = lstatSync(shadowPath);
    const mountEntry = lstatSync(mountPath);
    const helperIdentity = { ...processIdentity, startId: 'helper-extra-leaf' };
    const systemEntities = [
      { deviceEntry: '/dev/disk100', mountPath: null, contentHint: 'GUID_partition_scheme' },
      { deviceEntry: '/dev/disk101s1', mountPath, contentHint: 'APFS' },
      { deviceEntry: '/dev/disk101s2', mountPath: extraMountPath, contentHint: 'APFS' },
    ];
    let inventory: HdiImageInfo[] = [{
      imagePath,
      shadowPath,
      deviceEntry: '/dev/disk100',
      mountPath: null,
      mountDevice: null,
      systemEntities,
      helperPid: 8201,
      writable: true,
    }];
    beginDependencySeedImage({
      recipeKey,
      generation,
      sourceReceiptId: 'source-extra-leaf',
      sourceTreeDigest: 'source-tree-digest',
      publisherPid: 7201,
      publisherIdentity: processIdentity,
      imagePath,
      manifestPath: path.join(dataDir, 'extra-leaf-image.manifest.json'),
      stagingDirectory: path.join(dataDir, 'extra-leaf-staging'),
      stagingPath: path.join(dataDir, 'extra-leaf-staging', 'image.dmg'),
      stagingDevice: 31,
      stagingInode: 32,
    });
    recordBuiltDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7201,
      publisherIdentity: processIdentity,
      imageDevice: imageEntry.dev,
      imageInode: imageEntry.ino,
      imageDigest: 'extra-leaf-image-digest',
      manifestDevice: 35,
      manifestInode: 36,
      manifestDigest: 'extra-leaf-manifest-digest',
    });
    publishDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7201,
      publisherIdentity: processIdentity,
    });
    const prepared = beginDependencySeedLease({
      leaseId: 'lease-cleanup-extra-leaf',
      recipeKey,
      generation,
      workspacePath: path.dirname(mountPath),
      shadowPath,
      mountPath,
      ownerPid: 7201,
      ownerIdentity: processIdentity,
    });
    recordAttachedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk100',
      systemEntities,
      helperPid: 8201,
      helperIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const lease = bindMountedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk100',
      systemEntities,
      helperPid: 8201,
      helperIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const listDevices = async () => inventory;
    const listMounts = async () => inventory.flatMap((device) => (
      device.systemEntities.flatMap((entity) => entity.mountPath
        ? [{ deviceEntry: entity.deviceEntry, mountPath: entity.mountPath }]
        : [])
    ));
    const unmounted: string[] = [];
    await requestDependencyMountLeaseCleanup(lease, null, async (deviceEntry) => {
      expect(deviceEntry).toBe('/dev/disk100');
      inventory = [];
    }, {
      listDevices,
      listMounts,
      authoritySeams: {
        probeProcess: async () => inventory.length > 0
          ? { state: 'live' as const, identity: helperIdentity }
          : { state: 'absent' as const },
        listHelperFiles: async () => ({
          pid: 8201,
          command: 'diskimages-helper',
          files: [
            {
              fd: '3', access: 'r', type: 'REG', device: imageEntry.dev,
              inode: imageEntry.ino, links: 1, name: imagePath,
            },
            {
              fd: '5', access: 'u', type: 'REG', device: shadowEntry.dev,
              inode: shadowEntry.ino, links: 1, name: shadowPath,
            },
          ],
        }),
      },
      unmountDevice: async (deviceEntry) => {
        expect(listDependencySeedLeaseCleanupTargets(lease.leaseId)[0]?.systemEntities
          .filter((entity) => entity.mountPath !== null)).toHaveLength(2);
        unmounted.push(deviceEntry);
        inventory[0]!.systemEntities = inventory[0]!.systemEntities.map((entity) => (
          entity.deviceEntry === deviceEntry ? { ...entity, mountPath: null } : entity
        ));
      },
    });
    expect(unmounted).toEqual(['/dev/disk101s1', '/dev/disk101s2']);
    expect(readDependencySeedLeaseCleanupAction(lease.leaseId)).toBeNull();
    expect(listDependencySeedLeaseCleanupTargets(lease.leaseId)).toEqual([]);
    expect(readDependencySeedLease(lease.leaseId)).toBeNull();
  });

  it('blocks ambiguous or other-shadow inventory without journaling or detaching', async () => {
    const recipeKey = 'recipe-cleanup-ambiguous';
    const generation = 'generation-cleanup-ambiguous';
    const imagePath = path.join(dataDir, 'ambiguous-image.dmg');
    const shadowPath = path.join(dataDir, 'ambiguous-image.shadow');
    const mountPath = path.join(dataDir, 'ambiguous-workspace', 'node_modules');
    mkdirSync(mountPath, { recursive: true });
    writeFileSync(imagePath, 'image');
    writeFileSync(shadowPath, 'shadow');
    const imageEntry = lstatSync(imagePath);
    const shadowEntry = lstatSync(shadowPath);
    const firstEntities = [
      { deviceEntry: '/dev/disk80', mountPath, contentHint: 'APFS' },
    ];
    const secondMount = path.join(dataDir, 'ambiguous-extra-mount');
    const secondEntities = [
      { deviceEntry: '/dev/disk90', mountPath: secondMount, contentHint: 'APFS' },
    ];
    mkdirSync(secondMount, { recursive: true });
    beginDependencySeedImage({
      recipeKey,
      generation,
      sourceReceiptId: 'source-cleanup-ambiguous',
      sourceTreeDigest: 'source-tree-digest',
      publisherPid: 7002,
      publisherIdentity: processIdentity,
      imagePath,
      manifestPath: path.join(dataDir, 'ambiguous-image.manifest.json'),
      stagingDirectory: path.join(dataDir, 'ambiguous-staging'),
      stagingPath: path.join(dataDir, 'ambiguous-staging', 'image.dmg'),
      stagingDevice: 21,
      stagingInode: 22,
    });
    recordBuiltDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7002,
      publisherIdentity: processIdentity,
      imageDevice: imageEntry.dev,
      imageInode: imageEntry.ino,
      imageDigest: 'ambiguous-image-digest',
      manifestDevice: 25,
      manifestInode: 26,
      manifestDigest: 'ambiguous-manifest-digest',
    });
    const image = publishDependencySeedImage({
      recipeKey,
      generation,
      publisherPid: 7002,
      publisherIdentity: processIdentity,
    });
    const prepared = beginDependencySeedLease({
      leaseId: 'lease-cleanup-ambiguous',
      recipeKey,
      generation,
      workspacePath: path.join(dataDir, 'ambiguous-workspace'),
      shadowPath,
      mountPath,
      ownerPid: 7002,
      ownerIdentity: processIdentity,
    });
    const helperIdentity = { ...processIdentity, startId: 'helper-8101' };
    const mountEntry = lstatSync(mountPath);
    recordAttachedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk80',
      systemEntities: firstEntities,
      helperPid: 8101,
      helperIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const lease = bindMountedDependencySeedLease({
      leaseId: prepared.leaseId,
      imagePath,
      deviceEntry: '/dev/disk80',
      systemEntities: firstEntities,
      helperPid: 8101,
      helperIdentity,
      baseDevice: imageEntry.dev,
      baseInode: imageEntry.ino,
      shadowDevice: shadowEntry.dev,
      shadowInode: shadowEntry.ino,
      mountDevice: mountEntry.dev,
      mountInode: mountEntry.ino,
    });
    const inventory: HdiImageInfo[] = [
      {
        imagePath,
        shadowPath,
        deviceEntry: '/dev/disk80',
        mountPath,
        mountDevice: '/dev/disk80',
        systemEntities: firstEntities,
        helperPid: 8101,
        writable: true,
      },
      {
        imagePath,
        shadowPath,
        deviceEntry: '/dev/disk90',
        mountPath: secondMount,
        mountDevice: '/dev/disk90',
        systemEntities: secondEntities,
        helperPid: 8102,
        writable: true,
      },
    ];
    let unmountCalls = 0;
    let detachCalls = 0;
    await expect(requestDependencyMountLeaseCleanup(
      lease,
      image,
      async () => { detachCalls += 1; },
      {
        listDevices: async () => inventory,
        listMounts: async () => [],
        unmountDevice: async () => { unmountCalls += 1; },
      },
    )).rejects.toThrow('Lease authority matched 2 live devices.');
    expect(readDependencySeedLeaseCleanupAction(lease.leaseId)).toMatchObject({
      phase: 'blocked',
      reason: 'Lease authority matched 2 live devices.',
    });
    expect(listDependencySeedLeaseCleanupTargets(lease.leaseId)).toEqual([]);
    expect(readDependencySeedLease(lease.leaseId)?.state).toBe('blocked');
    expect(unmountCalls).toBe(0);
    expect(detachCalls).toBe(0);
    inventory.splice(0, inventory.length, {
      ...inventory[0]!,
      shadowPath: path.join(dataDir, 'other-shadow-file'),
    });
    await expect(requestDependencyMountLeaseCleanup(
      lease,
      image,
      async () => { detachCalls += 1; },
      {
        listDevices: async () => inventory,
        listMounts: async () => [],
        unmountDevice: async () => { unmountCalls += 1; },
      },
    )).rejects.toThrow('Dependency image cleanup device differs from complete durable authority.');
    expect(listDependencySeedLeaseCleanupTargets(lease.leaseId)).toEqual([]);
    expect(readDependencySeedLease(lease.leaseId)?.state).toBe('blocked');
    expect(unmountCalls).toBe(0);
    expect(detachCalls).toBe(0);
    expect(lstatSync(shadowPath).ino).toBe(shadowEntry.ino);
  });
});
