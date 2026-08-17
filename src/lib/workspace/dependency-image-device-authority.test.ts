import { createHash } from 'node:crypto';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, unlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertDependencyImageAttachUsable,
  captureDependencyImageAttachCleanupAuthority,
  classifyDependencyLeaseDevices,
  parseDependencyAttachInfo,
  parseDependencyImageHelperFiles,
  type HdiImageInfo,
} from './dependency-image-device-authority';
import { withHeldExactDependencyFile } from './dependency-image-file-authority';

const roots: string[] = [];
const helperIdentity = {
  version: 1 as const,
  platform: 'darwin' as const,
  bootId: 'boot-session',
  startId: 'Sun Aug 17 01:00:00 2026',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function plist(systemEntities: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict><key>system-entities</key><array>${systemEntities}</array></dict></plist>`);
}

function entity(device: string, mountPath?: string): string {
  return `<dict><key>dev-entry</key><string>${device}</string><key>content-hint</key><string>APFS</string>${
    mountPath ? `<key>mount-point</key><string>${mountPath}</string>` : ''
  }</dict>`;
}

function liveDevice(imagePath: string, shadowPath: string, mountPath: string): HdiImageInfo {
  return {
    imagePath,
    shadowPath,
    deviceEntry: '/dev/disk60',
    mountPath,
    mountDevice: '/dev/disk61s1',
    systemEntities: [
      { deviceEntry: '/dev/disk60', mountPath: null, contentHint: 'GUID_partition_scheme' },
      { deviceEntry: '/dev/disk60s1', mountPath: null, contentHint: 'Apple_APFS' },
      { deviceEntry: '/dev/disk61', mountPath: null, contentHint: 'APFS' },
      { deviceEntry: '/dev/disk61s1', mountPath, contentHint: 'APFS' },
    ],
    helperPid: 8001,
    writable: true,
  };
}

describe('dependency image device authority', () => {
  it('retains every attach entity before deciding whether the mount is usable', async () => {
    await expect(parseDependencyAttachInfo(plist([
      entity('/dev/disk60'),
      entity('/dev/disk61s1', '/tmp/expected'),
      entity('/dev/disk61s2', '/tmp/unexpected'),
    ].join('')))).resolves.toMatchObject({
      deviceEntry: '/dev/disk60',
      mountPath: null,
      mountDevice: null,
      systemEntities: [
        { deviceEntry: '/dev/disk60', mountPath: null },
        { deviceEntry: '/dev/disk61s1', mountPath: '/tmp/expected' },
        { deviceEntry: '/dev/disk61s2', mountPath: '/tmp/unexpected' },
      ],
    });
  });

  it('parses the exact lsof helper vnode fields', () => {
    const parsed = parseDependencyImageHelperFiles(Buffer.from([
      'p8001', 'cdiskimages-helper', '\nf3', 'ar', 'tREG', 'D0x1000006',
      'i123', 'k1', 'n/private/tmp/base.dmg', '\nf5', 'au', 'tREG',
      'D0x1000006', 'i456', 'k1', 'n/private/tmp/base.shadow', '',
    ].join('\0')));
    expect(parsed).toMatchObject({
      pid: 8001,
      command: 'diskimages-helper',
      files: [
        { fd: '3', access: 'r', type: 'REG', device: 0x1000006, inode: 123, links: 1 },
        { fd: '5', access: 'u', type: 'REG', device: 0x1000006, inode: 456, links: 1 },
      ],
    });
  });

  it('keeps the exact image descriptor across a same-content namespace swap', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'o8-held-image-'));
    roots.push(root);
    const imagePath = path.join(root, 'image.dmg');
    const displaced = path.join(root, 'displaced.dmg');
    const bytes = Buffer.from('same dependency tree bytes');
    await writeFile(imagePath, bytes, { mode: 0o444 });
    const entry = await lstat(imagePath);
    const authority = {
      device: entry.dev,
      inode: entry.ino,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
    await expect(withHeldExactDependencyFile(imagePath, authority, async (held) => {
      await rename(imagePath, displaced);
      await copyFile(displaced, imagePath);
      await chmod(imagePath, 0o444);
      await held.verifyUnchanged();
    })).rejects.toThrow(/lost its exact namespace/);
  });

  it('captures cleanup evidence before rejecting a different opened base vnode', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'o8-device-attest-'));
    roots.push(root);
    const imagePath = path.join(root, 'image.dmg');
    const shadowPath = path.join(root, 'image.shadow');
    const mountPath = path.join(root, 'mount');
    await writeFile(imagePath, 'image');
    await writeFile(shadowPath, 'shadow');
    await mkdir(mountPath);
    const [image, shadow] = await Promise.all([lstat(imagePath), lstat(shadowPath)]);
    const live = liveDevice(imagePath, shadowPath, mountPath);
    const verifyUnchanged = vi.fn(async () => undefined);
    let openedBaseInode = image.ino;
    const seams = {
      listDevices: vi.fn(async () => [live]),
      probeProcess: vi.fn(async () => ({ state: 'live' as const, identity: helperIdentity })),
      listHelperFiles: vi.fn(async () => ({
        pid: 8001,
        command: 'diskimages-helper',
        files: [
          { fd: '3', access: 'r', type: 'REG', device: image.dev, inode: openedBaseInode, links: 1, name: imagePath },
          { fd: '5', access: 'u', type: 'REG', device: shadow.dev, inode: shadow.ino, links: 1, name: shadowPath },
        ],
      })),
    };
    const input = {
      attach: {
        deviceEntry: live.deviceEntry,
        mountPath,
        mountDevice: live.mountDevice!,
        systemEntities: live.systemEntities,
      },
      imagePath,
      shadowPath,
      mountPath,
      heldImage: {
        device: image.dev,
        inode: image.ino,
        digest: 'ignored-by-seam',
        verifyUnchanged,
      },
    };
    const cleanupAuthority = await captureDependencyImageAttachCleanupAuthority(input, seams);
    expect(cleanupAuthority).toMatchObject({
      rootDeviceEntry: '/dev/disk60',
      helperPid: 8001,
      baseDevice: image.dev,
      baseInode: image.ino,
      shadowDevice: shadow.dev,
      shadowInode: shadow.ino,
    });
    expect(verifyUnchanged).not.toHaveBeenCalled();
    await expect(assertDependencyImageAttachUsable({
      ...input,
      authority: cleanupAuthority,
    })).resolves.toBeUndefined();
    expect(verifyUnchanged).toHaveBeenCalledTimes(2);
    openedBaseInode += 1;
    verifyUnchanged.mockClear();
    const wrongBaseAuthority = await captureDependencyImageAttachCleanupAuthority(input, seams);
    expect(wrongBaseAuthority.baseInode).toBe(openedBaseInode);
    await expect(assertDependencyImageAttachUsable({
      ...input,
      authority: wrongBaseAuthority,
    })).rejects.toThrow(/different base vnode/);
    expect(verifyUnchanged).not.toHaveBeenCalled();
  });

  it('classifies two path-related live roots as ambiguous without detaching either', async () => {
    const lease = {
      shadowPath: '/tmp/lease.shadow',
      mountPath: '/tmp/workspace/node_modules',
      deviceEntry: null,
      systemEntities: null,
      helperPid: null,
      helperIdentity: null,
      baseDevice: null,
      baseInode: null,
      shadowDevice: null,
      shadowInode: null,
    };
    const first = liveDevice('/tmp/image.dmg', lease.shadowPath, lease.mountPath);
    const second = {
      ...first,
      deviceEntry: '/dev/disk70',
      helperPid: 8002,
      systemEntities: first.systemEntities.map((entry, index) => ({
        ...entry,
        deviceEntry: index === 0 ? '/dev/disk70' : entry.deviceEntry.replace('disk61', 'disk71'),
      })),
    };
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath: '/tmp/image.dmg',
      inventory: [first, second],
    })).resolves.toEqual({ state: 'ambiguous', reason: 'Lease authority matched 2 live devices.' });
  });

  it('ignores only mount-path drift when cleanup reattests complete durable authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'o8-device-cleanup-path-'));
    roots.push(root);
    const imagePath = path.join(root, 'image.dmg');
    const shadowPath = path.join(root, 'image.shadow');
    const priorMountPath = path.join(root, 'workspace', 'node_modules');
    const movedMountPath = path.join(root, 'workspace-moved', 'node_modules');
    await writeFile(imagePath, 'image');
    await writeFile(shadowPath, 'shadow');
    const [image, shadow] = await Promise.all([lstat(imagePath), lstat(shadowPath)]);
    const prior = liveDevice(imagePath, shadowPath, priorMountPath);
    const live = liveDevice(imagePath, shadowPath, movedMountPath);
    const authority = {
      rootDeviceEntry: prior.deviceEntry,
      systemEntities: prior.systemEntities,
      helperPid: prior.helperPid!,
      helperIdentity,
      baseDevice: image.dev,
      baseInode: image.ino,
      shadowDevice: shadow.dev,
      shadowInode: shadow.ino,
    };
    const lease = {
      shadowPath,
      mountPath: priorMountPath,
      deviceEntry: authority.rootDeviceEntry,
      systemEntities: authority.systemEntities,
      helperPid: authority.helperPid,
      helperIdentity,
      baseDevice: authority.baseDevice,
      baseInode: authority.baseInode,
      shadowDevice: authority.shadowDevice,
      shadowInode: authority.shadowInode,
    };
    const seams = {
      probeProcess: vi.fn(async () => ({ state: 'live' as const, identity: helperIdentity })),
      listHelperFiles: vi.fn(async () => ({
        pid: authority.helperPid,
        command: 'diskimages-helper',
        files: [
          { fd: '3', access: 'r', type: 'REG', device: image.dev, inode: image.ino, links: 1, name: imagePath },
          { fd: '5', access: 'u', type: 'REG', device: shadow.dev, inode: shadow.ino, links: 1, name: shadowPath },
        ],
      })),
    };

    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [live],
    }, seams)).resolves.toMatchObject({ state: 'incomplete' });
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [live],
      purpose: 'cleanup',
    }, seams)).resolves.toEqual({
      state: 'exact',
      authority: { ...authority, systemEntities: live.systemEntities },
    });

    const unmounted = {
      ...live,
      mountPath: null,
      mountDevice: null,
      systemEntities: live.systemEntities.map((entry) => ({ ...entry, mountPath: null })),
    };
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [unmounted],
      purpose: 'cleanup',
    }, seams)).resolves.toMatchObject({ state: 'incomplete' });
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [unmounted],
      purpose: 'cleanup',
      cleanupMountState: 'unmounted',
    }, seams)).resolves.toEqual({
      state: 'exact',
      authority: { ...authority, systemEntities: unmounted.systemEntities },
    });
  });

  it('allows an absent unlinked shadow only for durable cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'o8-device-cleanup-unlinked-'));
    roots.push(root);
    const imagePath = path.join(root, 'image.dmg');
    const shadowPath = path.join(root, 'image.shadow');
    const mountPath = path.join(root, 'workspace', 'node_modules');
    await writeFile(imagePath, 'image');
    await writeFile(shadowPath, 'shadow');
    const [image, shadow] = await Promise.all([lstat(imagePath), lstat(shadowPath)]);
    const live = liveDevice(imagePath, shadowPath, mountPath);
    const authority = {
      rootDeviceEntry: live.deviceEntry,
      systemEntities: live.systemEntities,
      helperPid: live.helperPid!,
      helperIdentity,
      baseDevice: image.dev,
      baseInode: image.ino,
      shadowDevice: shadow.dev,
      shadowInode: shadow.ino,
    };
    const lease = {
      shadowPath,
      mountPath,
      deviceEntry: authority.rootDeviceEntry,
      systemEntities: authority.systemEntities,
      helperPid: authority.helperPid,
      helperIdentity,
      baseDevice: authority.baseDevice,
      baseInode: authority.baseInode,
      shadowDevice: authority.shadowDevice,
      shadowInode: authority.shadowInode,
    };
    const seams = {
      probeProcess: vi.fn(async () => ({ state: 'live' as const, identity: helperIdentity })),
      listHelperFiles: vi.fn(async () => ({
        pid: authority.helperPid,
        command: 'diskimages-helper',
        files: [
          { fd: '3', access: 'r', type: 'REG', device: image.dev, inode: image.ino, links: 0, name: imagePath },
          { fd: '5', access: 'u', type: 'REG', device: shadow.dev, inode: shadow.ino, links: 0, name: shadowPath },
        ],
      })),
    };

    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [live],
    }, seams)).resolves.toMatchObject({ state: 'incomplete' });
    await unlink(shadowPath);
    await writeFile(shadowPath, 'wrong shadow occupant');
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [live],
      purpose: 'cleanup',
    }, seams)).resolves.toMatchObject({ state: 'incomplete' });
    await unlink(shadowPath);
    await expect(classifyDependencyLeaseDevices({
      lease,
      imagePath,
      expectedAuthority: authority,
      inventory: [live],
      purpose: 'cleanup',
    }, seams)).resolves.toMatchObject({ state: 'exact' });
  });
});
