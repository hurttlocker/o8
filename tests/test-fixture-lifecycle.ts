import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_STALE_FIXTURE_AGE_MS = 2 * 60 * 60 * 1_000;
export const TEST_RUN_OWNER_FILE = '.o8-test-run-owner.json';

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

async function hasLiveRunOwner(target: string): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(path.join(target, TEST_RUN_OWNER_FILE), 'utf8'),
    ) as TestRunOwner;
    return isPidLive(owner.pid);
  } catch {
    return false;
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

async function imageIsOrphaned(
  parentDir: string,
  image: AttachedFixtureImage,
  now: number,
  thresholdMs: number,
): Promise<boolean> {
  const runRoot = enclosingRunRoot(parentDir, image.fixtureRoot);
  if (runRoot && await hasLiveRunOwner(runRoot)) return false;
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
    if (!await imageIsOrphaned(parentDir, image, now, thresholdMs)) {
      retained.push(image.fixtureRoot);
      continue;
    }
    if (await detachImage(image)) detached.push(image.imagePath);
    else retained.push(image.fixtureRoot);
  }
  return { detached, retained, inspectionFailed: false };
}

async function detachImage(image: AttachedFixtureImage): Promise<boolean> {
  if (!image.baseDevice) return false;
  try {
    await execFileAsync('/usr/bin/hdiutil', ['detach', image.baseDevice], { timeout: 15_000 });
    return true;
  } catch {
    try {
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
  const imageSweep = await detachOrphanedFixtureImages(canonicalParent, now, thresholdMs);
  const mountPaths = await readMountPaths();
  const receipt: FixtureSweepReceipt = {
    detachedImages: imageSweep.detached,
    reclaimedBytes: 0,
    removedPaths: [],
    retainedImages: imageSweep.retained,
    skippedLivePaths: [],
    skippedMountedPaths: [],
    thresholdMs,
  };
  const entries = await readdir(canonicalParent, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!FIXTURE_NAME.test(entry.name)) continue;
    const target = path.join(canonicalParent, entry.name);
    const identity = await lstat(target).catch(() => null);
    if (!identity || identity.isSymbolicLink() || !identity.isDirectory()) continue;
    if (now - identity.mtimeMs < thresholdMs) continue;
    if (RUN_FIXTURE_NAME.test(entry.name) && await hasLiveRunOwner(target)) {
      receipt.skippedLivePaths.push(target);
      continue;
    }
    if (imageSweep.inspectionFailed || imageSweep.retained.some((root) => (
      root === target || root.startsWith(`${target}${path.sep}`)
    ))) {
      receipt.skippedMountedPaths.push(target);
      continue;
    }
    if (!mountPaths || fixturePathHasMount(target, mountPaths)) {
      receipt.skippedMountedPaths.push(target);
      continue;
    }
    candidates.push(target);
  }

  const finalMountPaths = await readMountPaths();
  for (const target of candidates) {
    if (!finalMountPaths || fixturePathHasMount(target, finalMountPaths)) {
      receipt.skippedMountedPaths.push(target);
      continue;
    }
    const bytes = await allocatedBytes(target);
    await rm(target, { recursive: true, force: false });
    receipt.reclaimedBytes += bytes;
    receipt.removedPaths.push(target);
  }
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

export function fixtureSweepSummary(receipt: FixtureSweepReceipt): string {
  return `[fixture-cleanup] Reclaimed ${receipt.reclaimedBytes} fixture bytes from ${receipt.removedPaths.length} stale o8-* directories; detached ${receipt.detachedImages.length} orphaned o8-apfs-* images; skipped ${receipt.skippedMountedPaths.length} mounted directories.`;
}
