import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';

import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import type { HeldExactDependencyFile } from './dependency-image-file-authority';
import {
  exactDependencyImageRoot,
  normalizedNamespacePath,
  type HdiSystemEntity,
} from './dependency-image-device-identity';

export { normalizedNamespacePath } from './dependency-image-device-identity';
export type { HdiSystemEntity } from './dependency-image-device-identity';

export interface HdiImageInfo {
  imagePath: string;
  shadowPath: string | null;
  deviceEntry: string;
  mountPath: string | null;
  mountDevice: string | null;
  systemEntities: HdiSystemEntity[];
  helperPid: number | null;
  writable: boolean;
}

export interface HdiAttachInfo {
  deviceEntry: string;
  mountPath: string | null;
  mountDevice: string | null;
  systemEntities: HdiSystemEntity[];
}

export interface MountedFilesystem {
  deviceEntry: string;
  mountPath: string;
}

export interface DependencyImageDeviceAuthority {
  rootDeviceEntry: string;
  systemEntities: HdiSystemEntity[];
  helperPid: number;
  helperIdentity: MetadataLockProcessIdentity;
  baseDevice: number;
  baseInode: number;
  shadowDevice: number;
  shadowInode: number;
}

export interface DependencyImageAttachCleanupAuthority
  extends DependencyImageDeviceAuthority {
  mountDevice: number;
  mountInode: number;
}

export interface DependencyLeaseDeviceShape {
  shadowPath: string;
  mountPath: string;
  deviceEntry: string | null;
  systemEntities: HdiSystemEntity[] | null;
  helperPid: number | null;
  helperIdentity: MetadataLockProcessIdentity | null;
  baseDevice: number | null;
  baseInode: number | null;
  shadowDevice: number | null;
  shadowInode: number | null;
}

interface CommandReceipt {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

export interface HelperFile {
  fd: string;
  access: string;
  type: string;
  device: number;
  inode: number;
  links: number;
  name: string;
}

export interface HelperFiles {
  pid: number;
  command: string;
  files: HelperFile[];
}

type RawHelperFile = Partial<Record<
  'fd' | 'access' | 'type' | 'device' | 'inode' | 'links' | 'name', string
>>;

export interface DependencyImageDeviceAuthoritySeams {
  listDevices?: () => Promise<HdiImageInfo[]>;
  listHelperFiles?: (pid: number) => Promise<HelperFiles>;
  probeProcess?: typeof probeMetadataLockProcessIdentity;
}

function runCommand(command: string, args: string[], input?: Buffer): Promise<CommandReceipt> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 127,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
    if (input) child.stdin!.end(input);
  });
}

export async function runHdiCommand(args: string[]): Promise<CommandReceipt> {
  const receipt = await runCommand('/usr/bin/hdiutil', args);
  if (receipt.code !== 0) {
    throw new Error(`hdiutil failed (${receipt.code}): ${receipt.stderr.toString('utf8').trim()}`);
  }
  return receipt;
}

export async function unmountDependencyImageDevice(deviceEntry: string): Promise<void> {
  if (!/^\/dev\/disk\d+(?:s\d+)*$/.test(deviceEntry)) {
    throw new Error('Dependency image unmount requires one exact device entry.');
  }
  const receipt = await runCommand('/sbin/umount', [deviceEntry]);
  if (receipt.code !== 0) {
    throw new Error(`umount failed (${receipt.code}): ${receipt.stderr.toString('utf8').trim()}`);
  }
}

async function plistJson(bytes: Buffer): Promise<Record<string, unknown>> {
  const receipt = await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], bytes);
  if (receipt.code !== 0) {
    throw new Error(`plutil failed (${receipt.code}): ${receipt.stderr.toString('utf8').trim()}`);
  }
  const parsed = JSON.parse(receipt.stdout.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Disk image plist did not contain an object.');
  }
  return parsed as Record<string, unknown>;
}

function parseSystemEntities(value: unknown): HdiSystemEntity[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Disk image record has no complete system-entity inventory.');
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Disk image system entity has an unsupported shape.');
    }
    const entity = raw as Record<string, unknown>;
    const deviceEntry = entity['dev-entry'];
    const mountPoint = entity['mount-point'];
    const contentHint = entity['content-hint'];
    if (typeof deviceEntry !== 'string' || !/^\/dev\/disk\d+(?:s\d+)*$/.test(deviceEntry)
      || seen.has(deviceEntry)
      || (mountPoint !== undefined && typeof mountPoint !== 'string')
      || (contentHint !== undefined && typeof contentHint !== 'string')) {
      throw new Error('Disk image system entity is incomplete or duplicated.');
    }
    seen.add(deviceEntry);
    return {
      deviceEntry,
      mountPath: typeof mountPoint === 'string' ? normalizedNamespacePath(mountPoint) : null,
      contentHint: typeof contentHint === 'string' ? contentHint : null,
    };
  });
}

function exactMountedEntity(systemEntities: HdiSystemEntity[], context: string): HdiSystemEntity {
  const mounted = systemEntities.filter((entity) => entity.mountPath !== null);
  if (mounted.length !== 1) {
    throw new Error(`${context} returned ${mounted.length} mounted volumes; exactly one is required.`);
  }
  return mounted[0]!;
}

export async function parseDependencyAttachInfo(bytes: Buffer): Promise<HdiAttachInfo> {
  const plist = await plistJson(bytes);
  const systemEntities = parseSystemEntities(plist['system-entities']);
  const root = exactDependencyImageRoot(systemEntities);
  const mounted = systemEntities.filter((entity) => entity.mountPath !== null);
  return {
    deviceEntry: root.deviceEntry,
    mountPath: mounted.length === 1 ? mounted[0]!.mountPath : null,
    mountDevice: mounted.length === 1 ? mounted[0]!.deviceEntry : null,
    systemEntities,
  };
}

export async function parseDependencyValidationAttachInfo(
  bytes: Buffer,
): Promise<{ deviceEntry: string; mountPath: string; systemEntities: HdiSystemEntity[] }> {
  const parsed = await parseDependencyAttachInfo(bytes);
  const mounted = exactMountedEntity(parsed.systemEntities, 'Disk image validation attach');
  return {
    deviceEntry: parsed.deviceEntry,
    mountPath: mounted.mountPath!,
    systemEntities: parsed.systemEntities,
  };
}

/** Null for an image whose device tree is already gone; see the teardown note below. */
function parseImageRecord(raw: unknown): HdiImageInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Disk image inventory contains an unsupported image record.');
  }
  const image = raw as Record<string, unknown>;
  const imagePath = image['image-path'];
  if (typeof imagePath !== 'string') {
    throw new Error('Disk image inventory contains an incomplete image record.');
  }
  const rawPid = image['hdid-pid'];
  const helperPid = Number.isInteger(rawPid) && Number(rawPid) > 0 ? Number(rawPid) : null;
  const rawEntities = image['system-entities'];
  const shadowPath = typeof image['shadow-path'] === 'string'
    ? normalizedNamespacePath(image['shadow-path']) : null;
  // hdiutil keeps reporting an image between the moment its device tree is torn down
  // and the moment its helper exits. That is a real teardown state, not a malformed
  // record, and it contributes no devices to a device inventory. Absence stays gated
  // on the helper-identity probe in proveTargetAbsent, which the record cannot fool.
  if (rawEntities === undefined || (Array.isArray(rawEntities) && rawEntities.length === 0)) {
    return null;
  }
  if (typeof image.writeable !== 'boolean') {
    throw new Error('Disk image inventory contains an incomplete image record.');
  }
  const systemEntities = parseSystemEntities(rawEntities);
  const root = exactDependencyImageRoot(systemEntities);
  const mounted = systemEntities.filter((entity) => entity.mountPath !== null);
  return {
    imagePath: normalizedNamespacePath(imagePath),
    shadowPath,
    deviceEntry: root.deviceEntry,
    mountPath: mounted.length === 1 ? mounted[0]!.mountPath : null,
    mountDevice: mounted.length === 1 ? mounted[0]!.deviceEntry : null,
    systemEntities,
    helperPid,
    writable: image.writeable,
  };
}

// Our images and shadows are content-addressed as <recipeKey>-<generation|leaseId>,
// and a publication validates its staging image before it is named. Any string that
// carries one of those marks makes a record ours no matter which registry root holds it.
const DEPENDENCY_ARTIFACT_NAME = /^[0-9a-f]{64}-[0-9a-f-]{36}\.(?:dmg|shadow)$/;

function salvagedRecordStrings(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const record = raw as Record<string, unknown>;
  const strings = Object.values(record).filter((value): value is string => typeof value === 'string');
  const entities = record['system-entities'];
  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (!entity || typeof entity !== 'object' || Array.isArray(entity)) continue;
      strings.push(...Object.values(entity as Record<string, unknown>)
        .filter((value): value is string => typeof value === 'string'));
    }
  }
  return strings;
}

function unreadableRecordIsOurs(raw: unknown): boolean {
  return salvagedRecordStrings(raw).some((value) => {
    if (value.includes('/dependency-images/')) return true;
    const name = value.slice(value.lastIndexOf('/') + 1);
    return name === 'image.dmg' || DEPENDENCY_ARTIFACT_NAME.test(name);
  });
}

/**
 * hdiutil reports every disk image on the host, including ones no o8 lease will ever
 * touch. A single foreign record caught mid-teardown used to throw here and poison the
 * inventory that every lease cleanup reads, so one unrelated image broke detach for all
 * of them. Foreign records that cannot be read are dropped; a record naming one of our
 * own artifacts still throws, because nothing can be proven about a device we could not
 * parse.
 */
export function parseLiveDependencyImageInventory(
  plist: Record<string, unknown>,
): HdiImageInfo[] {
  if (!Array.isArray(plist.images)) {
    throw new Error('Disk image inventory did not return a complete image list.');
  }
  const inventory: HdiImageInfo[] = [];
  for (const raw of plist.images) {
    try {
      const record = parseImageRecord(raw);
      if (record) inventory.push(record);
    } catch (error) {
      if (unreadableRecordIsOurs(raw)) throw error;
      console.warn(
        `[dependency-image] Skipped an unreadable foreign disk image record: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return inventory;
}

export async function listLiveDependencyImageDevices(): Promise<HdiImageInfo[]> {
  return parseLiveDependencyImageInventory(
    await plistJson((await runHdiCommand(['info', '-plist'])).stdout),
  );
}

export const mountedDependencyImages = listLiveDependencyImageDevices;

export async function listMountedFilesystems(): Promise<MountedFilesystem[]> {
  const receipt = await runCommand('/sbin/mount', []);
  if (receipt.code !== 0) {
    throw new Error(`mount inventory failed (${receipt.code}): ${receipt.stderr.toString('utf8').trim()}`);
  }
  return receipt.stdout.toString('utf8').split('\n').filter((line) => (
    line.startsWith('/dev/disk')
  )).map((line) => {
    const match = /^(\/dev\/disk\S+) on (.+) \([^)]+\)$/.exec(line);
    if (!match) throw new Error('Mount inventory contained an unsupported disk entry.');
    return {
      deviceEntry: match[1]!,
      mountPath: normalizedNamespacePath(match[2]!),
    };
  });
}

function numericField(value: string, base = 10): number {
  const parsed = Number.parseInt(value, base);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('lsof returned an invalid numeric vnode field.');
  }
  return parsed;
}

export function parseDependencyImageHelperFiles(bytes: Buffer): HelperFiles {
  let pid: number | null = null;
  let command: string | null = null;
  let current: RawHelperFile | null = null;
  const rawFiles: RawHelperFile[] = [];
  for (const rawToken of bytes.toString('utf8').split('\0')) {
    const token = rawToken.replace(/^\n+/, '');
    if (!token) continue;
    const field = token[0];
    const value = token.slice(1);
    if (field === 'p') pid = numericField(value);
    else if (field === 'c') command = value;
    else if (field === 'f') {
      if (current) rawFiles.push(current);
      current = { fd: value };
    } else if (current && field === 'a') current.access = value;
    else if (current && field === 't') current.type = value;
    else if (current && field === 'D') current.device = value;
    else if (current && field === 'i') current.inode = value;
    else if (current && field === 'k') current.links = value;
    else if (current && field === 'n') current.name = value;
  }
  if (current) rawFiles.push(current);
  if (pid === null || command === null) throw new Error('lsof returned no stable helper process header.');
  const files = rawFiles.filter((file) => /^\d+$/.test(file.fd ?? '')).map((file) => {
    if (file.fd === undefined || file.access === undefined || file.type === undefined
      || file.device === undefined || file.inode === undefined || file.links === undefined
      || file.name === undefined) {
      throw new Error('lsof returned an incomplete helper vnode record.');
    }
    return {
      fd: file.fd,
      access: file.access,
      type: file.type,
      device: numericField(file.device.replace(/^0x/, ''), file.device.startsWith('0x') ? 16 : 10),
      inode: numericField(file.inode),
      links: numericField(file.links),
      name: normalizedNamespacePath(file.name),
    };
  });
  return { pid, command, files };
}

async function listHelperFiles(pid: number): Promise<HelperFiles> {
  const receipt = await runCommand('/usr/sbin/lsof', [
    '-nP', '-a', '-p', String(pid), '-F0pcfatDikn',
  ]);
  if (receipt.code !== 0) {
    throw new Error(`lsof could not attest dependency image helper ${pid} (exit ${receipt.code}).`);
  }
  return parseDependencyImageHelperFiles(receipt.stdout);
}

function sameEntities(first: HdiSystemEntity[], second: HdiSystemEntity[]): boolean {
  const canonical = (entities: HdiSystemEntity[]) => entities
    .map((entry) => `${entry.deviceEntry}\0${entry.mountPath ?? ''}`)
    .sort()
    .join('\n');
  return canonical(first) === canonical(second);
}

function sameDeviceTopology(first: HdiSystemEntity[], second: HdiSystemEntity[]): boolean {
  const canonical = (entities: HdiSystemEntity[]) => entities
    .map((entry) => `${entry.deviceEntry}\0${entry.contentHint ?? ''}`)
    .sort()
    .join('\n');
  return first.length === second.length && canonical(first) === canonical(second);
}

function exactHelperFile(
  files: HelperFile[],
  filePath: string,
  access: 'read' | 'write',
  requireName = true,
): HelperFile {
  const expectedPath = normalizedNamespacePath(filePath);
  const candidates = files.filter((file) => /^\d+$/.test(file.fd)
    && (!requireName || file.name === expectedPath)
    && (access === 'read' ? file.access === 'r' : /^(?:u|w)$/.test(file.access))
    && file.type === 'REG');
  if (candidates.length !== 1) {
    throw new Error(`Dependency image helper exposed ${candidates.length} numeric vnodes for ${expectedPath}.`);
  }
  const candidate = candidates[0]!;
  if (candidate.links !== 1) {
    throw new Error(`Dependency image helper vnode for ${expectedPath} has unsafe access or type.`);
  }
  return candidate;
}

async function captureDeviceAuthority(
  live: HdiImageInfo,
  expected: { imagePath: string; shadowPath: string; mountPath: string },
  seams: DependencyImageDeviceAuthoritySeams,
): Promise<DependencyImageDeviceAuthority> {
  if (live.imagePath !== normalizedNamespacePath(expected.imagePath)
    || live.shadowPath !== normalizedNamespacePath(expected.shadowPath)
    || live.systemEntities.filter((entity) => (
      entity.mountPath === normalizedNamespacePath(expected.mountPath)
    )).length !== 1
    || !live.writable
    || live.helperPid === null) {
    throw new Error('Dependency image live device does not match its image, shadow, mount, and helper tuple.');
  }
  const probe = seams.probeProcess ?? probeMetadataLockProcessIdentity;
  const helperFiles = seams.listHelperFiles ?? listHelperFiles;
  const before = await probe(live.helperPid);
  if (before.state !== 'live') throw new Error('Dependency image helper identity is not live and stable.');
  const opened = await helperFiles(live.helperPid);
  if (opened.pid !== live.helperPid || opened.command !== 'diskimages-helper') {
    throw new Error('Dependency image helper process does not match the expected executable.');
  }
  const base = exactHelperFile(opened.files, expected.imagePath, 'read', false);
  const shadow = exactHelperFile(opened.files, expected.shadowPath, 'write');
  const namedShadow = await lstat(expected.shadowPath);
  if (!namedShadow.isFile() || namedShadow.isSymbolicLink() || namedShadow.nlink !== 1
    || namedShadow.dev !== shadow.device || namedShadow.ino !== shadow.inode) {
    throw new Error('Dependency image helper shadow vnode differs from its exact namespace.');
  }
  const after = await probe(live.helperPid);
  if (after.state !== 'live' || !sameMetadataLockProcessIdentity(before.identity, after.identity)) {
    throw new Error('Dependency image helper identity changed during vnode attestation.');
  }
  return {
    rootDeviceEntry: live.deviceEntry,
    systemEntities: live.systemEntities,
    helperPid: live.helperPid,
    helperIdentity: after.identity,
    baseDevice: base.device,
    baseInode: base.inode,
    shadowDevice: shadow.device,
    shadowInode: shadow.inode,
  };
}

async function exactDurableHelperFile(
  files: HelperFile[],
  expected: { path: string; device: number; inode: number; access: 'read' | 'write' },
  requireName: boolean,
): Promise<HelperFile> {
  const expectedPath = normalizedNamespacePath(expected.path);
  const candidates = files.filter((file) => /^\d+$/.test(file.fd)
    && (!requireName || file.name === expectedPath)
    && (expected.access === 'read' ? file.access === 'r' : /^(?:u|w)$/.test(file.access))
    && file.type === 'REG'
    && file.device === expected.device
    && file.inode === expected.inode
    && (file.links === 0 || file.links === 1));
  if (candidates.length !== 1) {
    throw new Error(`Dependency image cleanup found ${candidates.length} exact helper vnodes for ${expectedPath}.`);
  }
  const candidate = candidates[0]!;
  if (!requireName) return candidate;
  let named;
  try {
    named = await lstat(expected.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && candidate.links === 0) {
      return candidate;
    }
    throw error;
  }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1
    || named.dev !== candidate.device || named.ino !== candidate.inode
    || candidate.links !== 1) {
    throw new Error('Dependency image cleanup helper vnode differs from its exact namespace.');
  }
  return candidate;
}

async function captureDurableCleanupAuthority(
  live: HdiImageInfo,
  expected: DependencyImageDeviceAuthority,
  paths: { imagePath: string; shadowPath: string },
  requiredMountState: 'mounted' | 'partial' | 'unmounted',
  seams: DependencyImageDeviceAuthoritySeams,
): Promise<DependencyImageDeviceAuthority> {
  const expectedMounted = new Set(expected.systemEntities.flatMap((entity) => (
    entity.mountPath === null ? [] : [entity.deviceEntry]
  )));
  const liveMounted = live.systemEntities.filter((entity) => entity.mountPath !== null);
  const mountedStateMatches = requiredMountState === 'mounted'
    ? liveMounted.length === expectedMounted.size
      && liveMounted.every((entity) => expectedMounted.has(entity.deviceEntry))
    : requiredMountState === 'partial'
      ? liveMounted.every((entity) => expectedMounted.has(entity.deviceEntry))
      : liveMounted.length === 0;
  if (live.deviceEntry !== expected.rootDeviceEntry
    || live.shadowPath !== normalizedNamespacePath(paths.shadowPath)
    || live.helperPid !== expected.helperPid
    || !live.writable
    || !sameDeviceTopology(live.systemEntities, expected.systemEntities)
    || !mountedStateMatches) {
    throw new Error('Dependency image cleanup device differs from complete durable authority.');
  }
  const probe = seams.probeProcess ?? probeMetadataLockProcessIdentity;
  const before = await probe(expected.helperPid);
  if (before.state !== 'live'
    || !sameMetadataLockProcessIdentity(before.identity, expected.helperIdentity)) {
    throw new Error('Dependency image cleanup helper identity differs from durable authority.');
  }
  const opened = await (seams.listHelperFiles ?? listHelperFiles)(expected.helperPid);
  if (opened.pid !== expected.helperPid || opened.command !== 'diskimages-helper') {
    throw new Error('Dependency image cleanup helper executable differs from durable authority.');
  }
  await Promise.all([
    exactDurableHelperFile(opened.files, {
      path: paths.imagePath,
      device: expected.baseDevice,
      inode: expected.baseInode,
      access: 'read',
    }, false),
    exactDurableHelperFile(opened.files, {
      path: paths.shadowPath,
      device: expected.shadowDevice,
      inode: expected.shadowInode,
      access: 'write',
    }, true),
  ]);
  const after = await probe(expected.helperPid);
  if (after.state !== 'live'
    || !sameMetadataLockProcessIdentity(after.identity, expected.helperIdentity)
    || !sameMetadataLockProcessIdentity(before.identity, after.identity)) {
    throw new Error('Dependency image cleanup helper identity changed during reattestation.');
  }
  return { ...expected, systemEntities: live.systemEntities };
}

export async function captureDependencyImageAttachCleanupAuthority(input: {
  attach: HdiAttachInfo;
  imagePath: string;
  shadowPath: string;
  mountPath: string;
}, seams: DependencyImageDeviceAuthoritySeams = {}): Promise<DependencyImageAttachCleanupAuthority> {
  const listDevices = seams.listDevices ?? listLiveDependencyImageDevices;
  const firstInventory = await listDevices();
  const matches = firstInventory.filter((entry) => entry.deviceEntry === input.attach.deviceEntry);
  if (matches.length !== 1) {
    throw new Error(`Dependency image attach root matched ${matches.length} live device records.`);
  }
  const live = matches[0]!;
  if (!sameEntities(input.attach.systemEntities, live.systemEntities)) {
    throw new Error('Dependency image attach returned an unexpected system-entity inventory.');
  }
  const authority = await captureDeviceAuthority(live, input, seams);
  const mount = await lstat(input.mountPath);
  if (!mount.isDirectory() || mount.isSymbolicLink()) {
    throw new Error('Dependency image requested mountpoint has an unsafe identity.');
  }
  const secondInventory = await listDevices();
  const secondMatches = secondInventory.filter((entry) => (
    entry.deviceEntry === authority.rootDeviceEntry
  ));
  if (secondMatches.length !== 1
    || secondMatches[0]!.helperPid !== authority.helperPid
    || !sameEntities(secondMatches[0]!.systemEntities, authority.systemEntities)) {
    throw new Error('Dependency image device inventory changed during cleanup capture.');
  }
  const finalProbe = await (seams.probeProcess ?? probeMetadataLockProcessIdentity)(
    authority.helperPid,
  );
  if (finalProbe.state !== 'live'
    || !sameMetadataLockProcessIdentity(finalProbe.identity, authority.helperIdentity)) {
    throw new Error('Dependency image helper identity changed before cleanup capture completed.');
  }
  return { ...authority, mountDevice: mount.dev, mountInode: mount.ino };
}

export async function assertDependencyImageAttachUsable(input: {
  attach: HdiAttachInfo;
  authority: DependencyImageAttachCleanupAuthority;
  imagePath: string;
  shadowPath: string;
  mountPath: string;
  heldImage: HeldExactDependencyFile;
}): Promise<void> {
  const mounted = exactMountedEntity(input.attach.systemEntities, 'Dependency image attach');
  if (mounted.mountPath !== normalizedNamespacePath(input.mountPath)
    || input.attach.mountPath !== normalizedNamespacePath(input.mountPath)
    || input.attach.mountDevice !== mounted.deviceEntry) {
    throw new Error('Dependency image attach did not produce exactly one requested mount leaf.');
  }
  if (input.authority.baseDevice !== input.heldImage.device
    || input.authority.baseInode !== input.heldImage.inode) {
    throw new Error('Dependency image helper opened a different base vnode than the held image.');
  }
  await input.heldImage.verifyUnchanged();
  const [shadow, mount] = await Promise.all([
    lstat(input.shadowPath),
    lstat(input.mountPath),
  ]);
  if (!shadow.isFile() || shadow.isSymbolicLink() || shadow.nlink !== 1
    || shadow.dev !== input.authority.shadowDevice
    || shadow.ino !== input.authority.shadowInode
    || !mount.isDirectory() || mount.isSymbolicLink()
    || mount.dev !== input.authority.mountDevice
    || mount.ino !== input.authority.mountInode) {
    throw new Error('Dependency image shadow or mount identity changed after cleanup capture.');
  }
  await input.heldImage.verifyUnchanged();
}

export async function attestDependencyImageDevice(input: {
  attach: HdiAttachInfo;
  imagePath: string;
  shadowPath: string;
  mountPath: string;
  heldImage: HeldExactDependencyFile;
}, seams: DependencyImageDeviceAuthoritySeams = {}): Promise<DependencyImageDeviceAuthority> {
  const authority = await captureDependencyImageAttachCleanupAuthority(input, seams);
  await assertDependencyImageAttachUsable({ ...input, authority });
  return authority;
}

function completeLeaseAuthority(
  lease: DependencyLeaseDeviceShape,
): DependencyImageDeviceAuthority | null {
  if (!lease.deviceEntry || lease.helperPid === null || !isMetadataLockProcessIdentity(lease.helperIdentity)
    || !lease.systemEntities || lease.systemEntities.length === 0
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

function relatedToCleanupAuthority(
  device: HdiImageInfo,
  lease: DependencyLeaseDeviceShape,
  authorities: DependencyImageDeviceAuthority[],
): boolean {
  const roots = new Set(authorities.map((authority) => authority.rootDeviceEntry));
  const helpers = new Set(authorities.map((authority) => authority.helperPid));
  const deviceEntries = new Set(authorities.flatMap((authority) => (
    authority.systemEntities.map((entity) => entity.deviceEntry)
  )));
  const mountPaths = new Set(authorities.flatMap((authority) => (
    authority.systemEntities.flatMap((entity) => entity.mountPath ? [entity.mountPath] : [])
  )));
  return device.shadowPath === normalizedNamespacePath(lease.shadowPath)
    || roots.has(device.deviceEntry)
    || (device.helperPid !== null && helpers.has(device.helperPid))
    || device.systemEntities.some((entity) => (
      deviceEntries.has(entity.deviceEntry)
      || (entity.mountPath !== null && mountPaths.has(entity.mountPath))
    ));
}

export function relatedDependencyLeaseDevices(input: {
  lease: DependencyLeaseDeviceShape;
  authorities: DependencyImageDeviceAuthority[];
  inventory: HdiImageInfo[];
}): HdiImageInfo[] {
  return input.inventory.filter((device) => (
    relatedToCleanupAuthority(device, input.lease, input.authorities)
  ));
}

function sameAuthority(
  expected: DependencyImageDeviceAuthority,
  actual: DependencyImageDeviceAuthority,
): boolean {
  return expected.rootDeviceEntry === actual.rootDeviceEntry
    && expected.helperPid === actual.helperPid
    && sameMetadataLockProcessIdentity(expected.helperIdentity, actual.helperIdentity)
    && expected.baseDevice === actual.baseDevice
    && expected.baseInode === actual.baseInode
    && expected.shadowDevice === actual.shadowDevice
    && expected.shadowInode === actual.shadowInode;
}

export type DependencyLeaseDeviceClassification =
  | { state: 'exact'; authority: DependencyImageDeviceAuthority }
  | { state: 'absent'; authority: DependencyImageDeviceAuthority }
  | { state: 'ambiguous' | 'incomplete'; reason: string };

export async function classifyDependencyLeaseDevices(input: {
  lease: DependencyLeaseDeviceShape;
  imagePath: string;
  expectedAuthority?: DependencyImageDeviceAuthority;
  inventory?: HdiImageInfo[];
  purpose?: 'adoption' | 'cleanup';
  cleanupMountState?: 'mounted' | 'partial' | 'unmounted';
}, seams: DependencyImageDeviceAuthoritySeams = {}): Promise<DependencyLeaseDeviceClassification> {
  const inventory = input.inventory
    ?? await (seams.listDevices ?? listLiveDependencyImageDevices)();
  const expected = input.expectedAuthority ?? completeLeaseAuthority(input.lease);
  const durableCleanup = input.purpose === 'cleanup' && input.expectedAuthority;
  if (input.cleanupMountState && !durableCleanup) {
    return {
      state: 'incomplete',
      reason: 'Dependency cleanup mount state requires complete durable authority.',
    };
  }
  const expectedDeviceEntries = durableCleanup
    ? new Set(input.expectedAuthority!.systemEntities.map((entity) => entity.deviceEntry))
    : null;
  const candidates = durableCleanup
    ? inventory.filter((device) => (
        device.deviceEntry === input.expectedAuthority!.rootDeviceEntry
        || device.helperPid === input.expectedAuthority!.helperPid
        || device.shadowPath === normalizedNamespacePath(input.lease.shadowPath)
        || device.systemEntities.some((entity) => expectedDeviceEntries!.has(entity.deviceEntry))
      ))
    : expected
    ? inventory.filter((device) => device.deviceEntry === expected.rootDeviceEntry)
    : inventory.filter((device) => (
        device.shadowPath === normalizedNamespacePath(input.lease.shadowPath)
      ));
  if (candidates.length === 0) {
    return expected
      ? { state: 'absent', authority: expected }
      : { state: 'incomplete', reason: 'No exact device tuple exists for this path-only lease.' };
  }
  if (candidates.length !== 1) {
    return { state: 'ambiguous', reason: `Lease authority matched ${candidates.length} live devices.` };
  }
  let actual: DependencyImageDeviceAuthority;
  try {
    actual = durableCleanup
      ? await captureDurableCleanupAuthority(
          candidates[0]!, input.expectedAuthority!, {
            imagePath: input.imagePath,
            shadowPath: input.lease.shadowPath,
          }, input.cleanupMountState ?? 'mounted', seams,
        )
      : await captureDeviceAuthority(candidates[0]!, {
          imagePath: input.imagePath,
          shadowPath: input.lease.shadowPath,
          mountPath: input.lease.mountPath,
        }, seams);
  } catch (error) {
    return {
      state: 'incomplete',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (expected && (!sameAuthority(expected, actual)
    || (!durableCleanup && !sameEntities(expected.systemEntities, actual.systemEntities)))) {
    return { state: 'ambiguous', reason: 'Live dependency device differs from durable helper/vnode authority.' };
  }
  return { state: 'exact', authority: actual };
}
