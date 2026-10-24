import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface LaunchPolicy { policyFile: string; policyHash: string }
const unsafe = () => new Error('Provider launch policy unavailable or unsafe; previous credential state preserved.');
interface Parent { path: string; stat: Stats }
function parents(file: string, systemAliases = false): Parent[] {
  const observed: Parent[] = [];
  for (let path = dirname(file); ; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() && !(systemAliases && stat.isSymbolicLink() && ['/var', '/tmp', '/etc'].includes(path))) throw unsafe();
    observed.push({ path, stat });
    if (path === dirname(path)) return observed;
  }
}
function unchanged(observed: Parent[]): void {
  for (const { path, stat } of observed) {
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino || current.isDirectory() !== stat.isDirectory() || current.isSymbolicLink() !== stat.isSymbolicLink()) throw unsafe();
  }
}
function target(): { file: string; observed: Parent[] } {
  const input = join(resolve(getDataDir()), 'provider-launch-policy.json');
  const initial = parents(input, true);
  const file = join(realpathSync(dirname(input)), 'provider-launch-policy.json');
  unchanged(initial);
  return { file, observed: [...initial, ...parents(file)] };
}
function optionalStat(file: string): Stats | null {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function regular(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()) || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw unsafe();
}
function read(file: string, observed: Parent[]): string | null {
  const before = optionalStat(file);
  if (!before) { unchanged(observed); return null; }
  regular(before);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd); regular(opened);
    if (before.dev !== opened.dev || before.ino !== opened.ino || opened.size > 4096) throw unsafe();
    unchanged(observed);
    const raw = readFileSync(fd, 'utf8');
    unchanged(observed);
    const parsed = JSON.parse(raw) as { version?: unknown; epoch?: unknown };
    if (parsed.version !== 1 || typeof parsed.epoch !== 'string' || !/^[a-f0-9-]{32,64}$/.test(parsed.epoch)) throw unsafe();
    return raw;
  } finally { closeSync(fd); }
}
function replace(file: string, observed: Parent[]): string {
  const before = optionalStat(file); if (before) regular(before);
  unchanged(observed);
  const raw = `${JSON.stringify({ version: 1, epoch: randomUUID() })}\n`;
  const temporary = join(dirname(file), `.provider-launch-policy.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let renamed = false;
  try {
    regular(fstatSync(fd));
    unchanged(observed);
    writeFileSync(fd, raw, 'utf8');
    unchanged(observed);
    const current = optionalStat(file);
    if (current) regular(current);
    if (before && (!current || before.dev !== current.dev || before.ino !== current.ino) || !before && current) throw unsafe();
    renameSync(temporary, file); renamed = true;
    unchanged(observed);
    return raw;
  } finally {
    closeSync(fd);
    if (!renamed) { try { unchanged(observed); unlinkSync(temporary); } catch { /* Preserve uncertain paths. */ } }
  }
}
/** Caller already holds .provider-keys.lock. This file contains only an opaque epoch. */
export function ensureLaunchPolicy(): LaunchPolicy {
  const { file, observed } = target();
  const raw = read(file, observed) ?? replace(file, observed);
  return { policyFile: file, policyHash: createHash('sha256').update(raw).digest('hex') };
}
/** Caller already holds .provider-keys.lock. Invalidate before any credential/billing commit. */
export function invalidateLaunchPolicy(): void {
  const { file, observed } = target();
  read(file, observed);
  replace(file, observed);
}
