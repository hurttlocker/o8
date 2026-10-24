import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_STALE_FIXTURE_AGE_MS = 2 * 60 * 60 * 1_000;
export const TEST_RUN_OWNER_FILE = '.o8-test-run-owner.json';
export const TEST_RUN_RETAIN_FILE = '.o8-test-run-retain.json';

const FIXTURE_NAME = /^o8-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUN_FIXTURE_NAME = /^o8-test-data-run-[A-Za-z0-9]{6}$/;

interface TestRunOwner {
  pid: number;
  startedAt: string;
}

interface AttachedFixtureImage {
  baseDevice: string | null;
  fixtureRoot: string;
  imagePath: string;
}

export interface FixtureSweepReceipt {
  detachedImages: string[];
  pendingDetachImages: string[];
  pendingRemovalPaths: string[];
  receiptPath: string;
  skippedRetainedPaths: string[];
  skippedOwnershipPaths: string[];
  reclaimedBytes: number;
  removedPaths: string[];
  retainedImages: string[];
  skippedLivePaths: string[];
  skippedMountedPaths: string[];
  thresholdMs: number;
}

function pathAliases(input: string): string[] {
  const resolved = path.resolve(input);
  const aliases = new Set([resolved]);
  try {
    aliases.add(realpathSync(resolved));
  } catch { /* The path can disappear between inspection steps. */ }
  for (const candidate of [...aliases]) {
    if (candidate.startsWith('/private/var/')) aliases.add(candidate.slice('/private'.length));
    else if (candidate.startsWith('/var/')) aliases.add(`/private${candidate}`);
  }
  return [...aliases];
}

function decodeMountPath(input: string): string {
  return input
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

export function mountedPathsFromOutput(output: string): string[] {
  const mounts = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.match(/\son\s(.+?)(?:\s\(|\stype\s)/);
    if (!match?.[1]) continue;
    for (const alias of pathAliases(decodeMountPath(match[1]))) mounts.add(alias);
  }
  return [...mounts];
}

export function fixturePathHasMount(target: string, mountedPaths: string[]): boolean {
  return pathAliases(target).some((targetAlias) => mountedPaths.some((mountPath) => (
    mountPath === targetAlias || mountPath.startsWith(`${targetAlias}${path.sep}`)
  )));
}

function mountCommand(): string {
  return existsSync('/sbin/mount') ? '/sbin/mount' : 'mount';
}

async function readMountPaths(): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(mountCommand(), [], { encoding: 'utf8' });
    return mountedPathsFromOutput(stdout);
  } catch {
    return null;
  }
}

function readMountPathsSync(): string[] | null {
  try {
    return mountedPathsFromOutput(execFileSync(mountCommand(), [], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

function isPidLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readTestRunOwner(target: string): Promise<TestRunOwner | null> {
  try {
    const ownerPath = path.join(target, TEST_RUN_OWNER_FILE);
    const identity = await lstat(ownerPath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) return null;
    const owner = JSON.parse(
      await readFile(ownerPath, 'utf8'),
    ) as TestRunOwner;
    if (!Number.isInteger(owner.pid) || owner.pid <= 0
      || !Number.isFinite(Date.parse(owner.startedAt))) return null;
    return owner;
  } catch {
    return null;
  }
}

type FixtureGuard = { fingerprint: string; reason: null | 'live' | 'retained' | 'ownership' };

async function fixtureGuard(target: string): Promise<FixtureGuard> {
  const held = (reason: FixtureGuard['reason']): FixtureGuard => ({ fingerprint: '', reason });
  const identity = await lstat(target).catch(() => null);
  if (!identity?.isDirectory() || identity.isSymbolicLink()) return held('ownership');
  if (testRunRetainedAfterTimeout(target)) return held('retained');
  const ownerPath = path.join(target, TEST_RUN_OWNER_FILE);
  const before = await lstat(ownerPath).catch(() => null);
  const owner = await readTestRunOwner(target);
  const after = await lstat(ownerPath).catch(() => null);
  if (!owner || !before || !after || before.dev !== after.dev || before.ino !== after.ino
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return held('ownership');
  if (isPidLive(owner.pid)) return held('live');
  const final = await lstat(target).catch(() => null);
  if (!final?.isDirectory() || final.isSymbolicLink()
    || final.dev !== identity.dev || final.ino !== identity.ino) return held('ownership');
  if (testRunRetainedAfterTimeout(target)) return held('retained');
  return {
    fingerprint: JSON.stringify([identity.dev, identity.ino, before.dev, before.ino,
      before.mtimeMs, before.ctimeMs, owner]),
    reason: null,
  };
}

// A dead outer run does not release evidence or a still-live nested fixture.
async function nestedFixtureState(target: string): Promise<FixtureGuard> {
  const snapshots: unknown[] = [];
  try {
    for (const entry of await readdir(target, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(target, entry.name);
      const identity = await lstat(child);
      if (!identity.isDirectory() || identity.isSymbolicLink()) return { fingerprint: '', reason: 'ownership' };
      if (testRunRetainedAfterTimeout(child)) return { fingerprint: '', reason: 'retained' };
      const marker = await lstat(path.join(child, TEST_RUN_OWNER_FILE)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      const guard = marker ? await fixtureGuard(child) : { fingerprint: '', reason: null };
      if (guard.reason) return guard;
      const nested = await nestedFixtureState(child);
      if (nested.reason) return nested;
      snapshots.push([entry.name, identity.dev, identity.ino, guard.fingerprint, nested.fingerprint]);
    }
    snapshots.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { fingerprint: createHash('sha256').update(JSON.stringify(snapshots)).digest('hex'), reason: null };
  } catch {
    return { fingerprint: '', reason: 'ownership' };
  }
}

function pathIsInsideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realTemporaryRoots(): Promise<string[]> {
  const candidates = process.platform === 'win32'
    ? [os.tmpdir()]
    : ['/tmp', '/var/tmp'];
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], {
        encoding: 'utf8',
      });
      if (stdout.trim()) candidates.push(stdout.trim());
    } catch { /* Fixed system temporary roots remain the fail-closed fallback. */ }
  }
  const roots = await Promise.all(candidates.map((candidate) => realpath(candidate).catch(() => null)));
  return [...new Set(roots.filter((candidate): candidate is string => candidate !== null))];
}

export async function pathIsWithinRealTemporaryRoot(target: string): Promise<boolean> {
  const canonical = await realpath(target).catch(() => null);
  if (canonical === null) return false;
  const temporaryRoots = await realTemporaryRoots();
  return temporaryRoots.some((root) => pathIsInsideRoot(canonical, root));
}

async function assertTemporarySweepParent(canonicalParent: string): Promise<void> {
  if (!await pathIsWithinRealTemporaryRoot(canonicalParent)) {
    throw new Error(`Fixture sweep parent is outside a real temporary root: ${canonicalParent}`);
  }
}

function fixtureRootForImage(parentDir: string, imagePath: string): string | null {
  const parentAliases = pathAliases(parentDir);
  for (const parentAlias of parentAliases) {
    const imageAlias = pathAliases(imagePath).find((candidate) => (
      candidate === parentAlias || candidate.startsWith(`${parentAlias}${path.sep}`)
    ));
    if (!imageAlias) continue;
    const segments = path.relative(parentAlias, imageAlias).split(path.sep);
    const fixtureIndex = segments.findIndex((segment) => segment.startsWith('o8-apfs-'));
    if (fixtureIndex < 0) continue;
    return path.join(parentAlias, ...segments.slice(0, fixtureIndex + 1));
  }
  return null;
}

function attachedFixtureImages(parentDir: string, output: string): AttachedFixtureImage[] {
  const images: AttachedFixtureImage[] = [];
  for (const block of output.split(/^={10,}\s*$/m)) {
    const imagePath = block.match(/^image-path\s*:\s*(.+)$/m)?.[1]?.trim();
    if (!imagePath) continue;
    const fixtureRoot = fixtureRootForImage(parentDir, imagePath);
    if (!fixtureRoot) continue;
    const devices = block.split('\n')
      .map((line) => line.split('\t').map((column) => column.trim()))
      .filter((columns) => /^\/dev\/disk\d+(s\d+)?$/.test(columns[0] ?? ''));
    images.push({
      baseDevice: devices[0]?.[0] ?? null,
      fixtureRoot,
      imagePath,
    });
  }
  return images;
}

function enclosingRunRoot(parentDir: string, fixtureRoot: string): string | null {
  const relative = path.relative(path.resolve(parentDir), path.resolve(fixtureRoot));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const parts = relative.split(path.sep);
  const runIndex = parts.findIndex((part) => RUN_FIXTURE_NAME.test(part));
  return runIndex < 0 ? null : path.join(path.resolve(parentDir), ...parts.slice(0, runIndex + 1));
}

async function fixtureOwnershipRoot(
  parentDir: string,
  fixtureRoot: string,
): Promise<string | null> {
  const runRoot = enclosingRunRoot(parentDir, fixtureRoot);
  for (const candidate of [fixtureRoot, runRoot]) {
    if (candidate && await readTestRunOwner(candidate)) return candidate;
  }
  return null;
}

async function imageIsOrphaned(
  parentDir: string,
  image: AttachedFixtureImage,
  now: number,
  thresholdMs: number,
): Promise<boolean> {
  const runRoot = enclosingRunRoot(parentDir, image.fixtureRoot);
  if (runRoot && (await fixtureGuard(runRoot)).reason) return false;
  const [imageIdentity, fixtureIdentity] = await Promise.all([
    lstat(image.imagePath).catch(() => null),
    lstat(image.fixtureRoot).catch(() => null),
  ]);
  return !imageIdentity || !fixtureIdentity || now - fixtureIdentity.mtimeMs >= thresholdMs;
}

async function detachOrphanedFixtureImages(
  parentDir: string,
  now: number,
  thresholdMs: number,
  receipt: FixtureSweepReceipt,
  persist: () => Promise<void>,
): Promise<{ detached: string[]; retained: string[]; inspectionFailed: boolean }> {
  if (process.platform !== 'darwin') return { detached: [], retained: [], inspectionFailed: false };
  let output: string;
  try {
    output = (await execFileAsync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' })).stdout;
  } catch {
    return { detached: [], retained: [], inspectionFailed: true };
  }
  const detached: string[] = [];
  const retained: string[] = [];
  for (const image of attachedFixtureImages(parentDir, output)) {
    const ownershipRoot = await fixtureOwnershipRoot(parentDir, image.fixtureRoot);
    if (!ownershipRoot) {
      retained.push(image.fixtureRoot);
      continue;
    }
    const imageIdentity = await lstat(image.imagePath).catch(() => null);
    if (!imageIdentity?.isFile() || imageIdentity.isSymbolicLink()) {
      retained.push(image.fixtureRoot);
      continue;
    }
    const runRoot = enclosingRunRoot(parentDir, image.fixtureRoot);
    const scopes = [...new Set([ownershipRoot, ...(runRoot ? [runRoot] : [])])];
    const authorize = async (): Promise<string | null> => {
      const fingerprints: string[] = [];
      for (const scope of scopes) {
        const nested = await nestedFixtureState(scope);
        const guard = await fixtureGuard(scope);
        if (nested.reason || guard.reason) return null;
        fingerprints.push(JSON.stringify([guard.fingerprint, nested.fingerprint]));
      }
      const currentImage = await lstat(image.imagePath).catch(() => null);
      if (!currentImage?.isFile() || currentImage.isSymbolicLink()
        || currentImage.dev !== imageIdentity.dev || currentImage.ino !== imageIdentity.ino
        || !await imageIsOrphaned(parentDir, image, now, thresholdMs)) return null;
      return JSON.stringify(fingerprints);
    };
    const initial = await authorize();
    if (initial === null) {
      retained.push(image.fixtureRoot);
      continue;
    }
    receipt.pendingDetachImages.push(image.imagePath);
    await persist();
    if (await authorize() !== initial) {
      receipt.pendingDetachImages = [];
      await persist();
      retained.push(image.fixtureRoot);
      continue;
    }
    if (await detachImage(image, async () => await authorize() === initial)) {
      detached.push(image.imagePath);
      receipt.detachedImages.push(image.imagePath);
    } else retained.push(image.fixtureRoot);
    receipt.pendingDetachImages = [];
    await persist();
  }
  return { detached, retained, inspectionFailed: false };
}

async function detachImage(
  image: AttachedFixtureImage,
  authorize: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  if (!image.baseDevice) return false;
  const stillAttached = async () => {
    try {
      const { stdout } = await execFileAsync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
      return attachedFixtureImages(path.dirname(image.fixtureRoot), stdout).some((current) => (
        current.baseDevice === image.baseDevice && current.imagePath === image.imagePath
      ));
    } catch { return false; }
  };
  try {
    if (!await authorize() || !await stillAttached()) return false;
    await execFileAsync('/usr/bin/hdiutil', ['detach', image.baseDevice], { timeout: 15_000 });
    return true;
  } catch {
    try {
      // A failed detach can release the device before reporting failure. Never
      // force a stale device identifier that the OS may already have reused.
      if (!await authorize() || !await stillAttached()) return false;
      await execFileAsync('/usr/bin/hdiutil', ['detach', image.baseDevice, '-force'], {
        timeout: 15_000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export async function detachAttachedApfsFixtureImages(
  fixtureRoot: string,
): Promise<{ detached: string[]; retained: string[] }> {
  if (process.platform !== 'darwin') return { detached: [], retained: [] };
  const canonicalRoot = path.resolve(fixtureRoot);
  let output: string;
  try {
    output = (await execFileAsync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' })).stdout;
  } catch {
    return { detached: [], retained: [canonicalRoot] };
  }
  const images = attachedFixtureImages(path.dirname(canonicalRoot), output).filter((image) => (
    pathAliases(image.fixtureRoot).some((alias) => pathAliases(canonicalRoot).includes(alias))
  ));
  const detached: string[] = [];
  const retained: string[] = [];
  for (const image of images) {
    if (await detachImage(image)) detached.push(image.imagePath);
    else retained.push(image.imagePath);
  }
  return { detached, retained };
}

async function allocatedBytes(target: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/du', ['-sk', target], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const kibibytes = Number(stdout.trim().split(/\s+/)[0]);
    return Number.isFinite(kibibytes) ? kibibytes * 1024 : 0;
  } catch {
    return 0;
  }
}

export async function sweepStaleTestFixtures(
  parentDir: string,
  options: { now?: number; thresholdMs?: number } = {},
): Promise<FixtureSweepReceipt> {
  const now = options.now ?? Date.now();
  const thresholdMs = options.thresholdMs ?? DEFAULT_STALE_FIXTURE_AGE_MS;
  const canonicalParent = await realpath(parentDir);
  await assertTemporarySweepParent(canonicalParent);
  const receiptRoot = await mkdtemp(path.join(canonicalParent, '.o8-fixture-sweep-'));
  const receipt: FixtureSweepReceipt = {
    detachedImages: [], pendingDetachImages: [], pendingRemovalPaths: [],
    receiptPath: path.join(receiptRoot, 'receipt.json'),
    reclaimedBytes: 0, removedPaths: [], retainedImages: [],
    skippedLivePaths: [], skippedMountedPaths: [], skippedRetainedPaths: [],
    skippedOwnershipPaths: [], thresholdMs,
  };
  const persist = async () => {
    const pending = path.join(receiptRoot, 'pending.json');
    const file = await open(pending, 'w', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(pending, receipt.receiptPath);
    // POSIX directory sync makes the renamed receipt survive a crash before
    // the following destructive action. Windows cannot open directories here.
    if (process.platform !== 'win32') {
      for (const directory of [receiptRoot, canonicalParent]) {
        const handle = await open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
  };
  await persist();
  const imageSweep = await detachOrphanedFixtureImages(canonicalParent, now, thresholdMs, receipt, persist);
  receipt.retainedImages = imageSweep.retained;
  const mountPaths = await readMountPaths();
  const hold = (target: string, reason: FixtureGuard['reason']) => {
    const paths = reason === 'live' ? receipt.skippedLivePaths
      : reason === 'retained' ? receipt.skippedRetainedPaths : receipt.skippedOwnershipPaths;
    paths.push(target);
  };
  const entries = await readdir(canonicalParent, { withFileTypes: true });
  const candidates: Array<{ target: string; fingerprint: string; nestedFingerprint: string }> = [];
  for (const entry of entries) {
    if (!FIXTURE_NAME.test(entry.name)) continue;
    const target = path.join(canonicalParent, entry.name);
    const identity = await lstat(target).catch(() => null);
    if (!identity || identity.isSymbolicLink() || !identity.isDirectory()) continue;
    if (now - identity.mtimeMs < thresholdMs) continue;
    const nested = await nestedFixtureState(target);
    const guard = await fixtureGuard(target);
    const reason = guard.reason ?? nested.reason;
    if (reason) {
      hold(target, reason);
      continue;
    }
    if (imageSweep.inspectionFailed || imageSweep.retained.some((root) => (
      root === target || root.startsWith(`${target}${path.sep}`)
    )) || !mountPaths || fixturePathHasMount(target, mountPaths)) {
      receipt.skippedMountedPaths.push(target);
      continue;
    }
    candidates.push({ target, fingerprint: guard.fingerprint, nestedFingerprint: nested.fingerprint });
  }

  for (const { target, fingerprint, nestedFingerprint } of candidates) {
    const bytes = await allocatedBytes(target);
    receipt.pendingRemovalPaths = [target];
    await persist();
    const finalMountPaths = await readMountPaths();
    const nested = await nestedFixtureState(target);
    const guard = await fixtureGuard(target);
    const reason = guard.reason ?? nested.reason;
    if (reason || guard.fingerprint !== fingerprint || nested.fingerprint !== nestedFingerprint) {
      hold(target, reason ?? 'ownership');
    } else if (!finalMountPaths || fixturePathHasMount(target, finalMountPaths)) {
      receipt.skippedMountedPaths.push(target);
    } else {
      await rm(target, { recursive: true, force: false });
      receipt.reclaimedBytes += bytes;
      receipt.removedPaths.push(target);
    }
    receipt.pendingRemovalPaths = [];
    await persist();
  }
  await persist();
  return receipt;
}

function attachedImageReferencesPathSync(target: string): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    const output = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
    return attachedFixtureImages(path.dirname(target), output).some((image) => (
      image.fixtureRoot === target || image.fixtureRoot.startsWith(`${target}${path.sep}`)
    ));
  } catch {
    return true;
  }
}

export function removeOwnedTestRunRootSync(parentDir: string, runRoot: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedRoot = path.resolve(runRoot);
  if (path.dirname(resolvedRoot) !== resolvedParent || !RUN_FIXTURE_NAME.test(path.basename(resolvedRoot))) {
    throw new Error('Vitest run root is outside its owned fixture parent.');
  }
  let identity;
  try {
    identity = lstatSync(resolvedRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error('Vitest run root changed before teardown.');
  }
  return removeFixtureDirectoryIfUnmountedSync(resolvedRoot);
}

export function removeFixtureDirectoryIfUnmountedSync(target: string): boolean {
  const resolvedTarget = path.resolve(target);
  const mountPaths = readMountPathsSync();
  if (!mountPaths || fixturePathHasMount(resolvedTarget, mountPaths)) return false;
  if (attachedImageReferencesPathSync(resolvedTarget)) return false;
  rmSync(resolvedTarget, { recursive: true, force: false });
  return true;
}

export function writeTestRunOwner(runRoot: string): void {
  const owner: TestRunOwner = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(path.join(runRoot, TEST_RUN_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
    flag: 'wx',
  });
}

export function retainTestRunAfterTimeout(
  runRoot: string,
  reason: 'test_timeout_or_cancellation' | 'failed_test_evidence' = 'test_timeout_or_cancellation',
): void {
  const resolvedRoot = path.resolve(runRoot);
  if (!RUN_FIXTURE_NAME.test(path.basename(resolvedRoot))) {
    throw new Error('Vitest retained run root does not have an owned run name.');
  }
  try {
    writeFileSync(path.join(resolvedRoot, TEST_RUN_RETAIN_FILE), `${JSON.stringify({
      retainedAt: new Date().toISOString(),
      reason,
    })}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export function testRunRetainedAfterTimeout(runRoot: string): boolean {
  try {
    lstatSync(path.join(path.resolve(runRoot), TEST_RUN_RETAIN_FILE));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Cleanup is fail-closed: an unreadable marker must never arm deletion.
    return true;
  }
}

export function fixtureSweepSummary(receipt: FixtureSweepReceipt): string {
  return `[fixture-cleanup] Reclaimed ${receipt.reclaimedBytes} fixture bytes from ${receipt.removedPaths.length} stale o8-* directories; detached ${receipt.detachedImages.length} orphaned o8-apfs-* images; skipped ${receipt.skippedMountedPaths.length} mounted directories; held ${receipt.skippedLivePaths.length} live, ${receipt.skippedRetainedPaths.length} retained and ${receipt.skippedOwnershipPaths.length} unknown or changed owners; receipt ${receipt.receiptPath}.`;
}
