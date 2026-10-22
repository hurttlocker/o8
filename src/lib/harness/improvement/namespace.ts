import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, readSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { canonical, digest, integer, object, text } from './validation';

const MARKER = '.refinement-namespace.json';
export interface ImprovementNamespace {
  schema: 'o8/harness-refinement-namespace/v1';
  id: string;
  root: string;
  repository: string;
  experimentId: string;
  creatorPid: number;
  device: number;
  inode: number;
}
export interface ImprovementNamespaceLaunch {
  namespace: ImprovementNamespace;
  /** Merge into a new child process environment, never into the current process. */
  env: Record<string, string | undefined>;
}
function fail(message: string): never { throw new Error(`Refinement namespace held: ${message}`); }
function owner(stat: Stats, privateRequired: boolean): void {
  if (typeof process.geteuid !== 'function') fail('POSIX ownership proof is required.');
  if (privateRequired && (stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0)) fail('Private owner-only storage is required.');
  if (stat.uid !== process.geteuid!() && stat.uid !== 0) fail('Untrusted storage owner.');
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode; }
export function assertImprovementDirectory(path: string, privateRequired = true): Stats {
  if (!isAbsolute(path) || resolve(path) !== path || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) fail('Canonical POSIX storage is required.');
  let current = parse(path).root;
  const rootStat = lstatSync(current); owner(rootStat, privateRequired && current === path);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o022)) fail('Unsafe filesystem root.');
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Storage contains a symlink or non-directory.');
    owner(stat, privateRequired && current === path);
    if ((stat.mode & 0o022) && !(stat.mode & 0o1000)) fail('Storage has a writable ancestor.');
  }
  if (realpathSync(path) !== path) fail('Storage resolves outside its exact path.');
  return lstatSync(path);
}
export function readImprovementPrivateFile(path: string, maxBytes = 65536): string {
  const before = lstatSync(path); owner(before, true);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) fail('Unsafe private file.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const captured = fstatSync(fd);
    if (!same(before, captured) || captured.size !== before.size || captured.nlink !== 1) fail('Private file changed.');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail('Private file was truncated.');
      offset += count;
    }
    const after = fstatSync(fd); const named = lstatSync(path);
    if (!same(before, after) || !same(before, named) || after.size !== before.size || after.nlink !== 1
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('Private file changed while reading.');
    return bytes.toString('utf8');
  } finally { closeSync(fd); }
}
export function writeImprovementPrivateOnce(root: string, name: string, value: unknown): void {
  if (basename(name) !== name || !/^[a-zA-Z0-9_.-]+$/.test(name)) fail('Invalid immutable entry name.');
  const before = assertImprovementDirectory(root);
  const content = Buffer.from(`${canonical(value)}\n`);
  if (content.length > 65536) fail('Immutable entry exceeds its byte budget.');
  const dir = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  let file: number | undefined;
  try {
    if (!same(before, fstatSync(dir))) fail('Namespace identity changed.');
    file = openSync(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(file, content); fchmodSync(file, 0o400); fsyncSync(file); fsyncSync(dir);
    if (!same(before, assertImprovementDirectory(root)) || readImprovementPrivateFile(join(root, name)) !== content.toString('utf8')) {
      fail('Immutable publication outcome requires reconciliation.');
    }
  } finally { if (file !== undefined) closeSync(file); closeSync(dir); }
}
function outside(root: string, repository: string): void {
  const location = relative(repository, root);
  if (!location || (!location.startsWith(`..${sep}`) && location !== '..' && !isAbsolute(location))) fail('Namespace must be outside the repository.');
}

/** Filesystem-only initializer: deliberately imports no app-data, database, mission or runtime modules. */
export function createImprovementNamespace(input: { parentDirectory: string; repository: string; experimentId: string }): ImprovementNamespaceLaunch {
  object(input, ['parentDirectory', 'repository', 'experimentId']); text(input.experimentId, 128);
  assertImprovementDirectory(input.parentDirectory, false); assertImprovementDirectory(input.repository, false);
  outside(input.parentDirectory, input.repository);
  const root = mkdtempSync(join(input.parentDirectory, 'o8-refinement-'));
  const stat = assertImprovementDirectory(root);
  const namespace: ImprovementNamespace = { schema: 'o8/harness-refinement-namespace/v1', id: randomUUID(), root,
    repository: input.repository, experimentId: input.experimentId, creatorPid: process.pid, device: stat.dev, inode: stat.ino };
  writeImprovementPrivateOnce(root, MARKER, namespace);
  const parent = openSync(input.parentDirectory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { fsyncSync(parent); } finally { closeSync(parent); }
  return { namespace, env: {
    O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'cortex-ide.db'),
    O8_REFINEMENT_NAMESPACE_ID: namespace.id, O8_REFINEMENT_NAMESPACE_DIGEST: digest(namespace),
    O8_OPERATOR_DATA_DIR: undefined,
  } };
}

/** Marker proves only private namespace placement, never user consent or launch authority. */
export function requireImprovementNamespace(): ImprovementNamespace {
  const root = process.env.O8_DATA_DIR;
  if (!root || process.env.CORTEX_IDE_DATA_DIR !== root || process.env.CORTEX_IDE_DB_PATH !== join(root, 'cortex-ide.db')) {
    fail('Explicit consistent app-data and database environment pins are required.');
  }
  const stat = assertImprovementDirectory(root);
  if (!basename(root).startsWith('o8-refinement-')) fail('Not a dedicated refinement root.');
  const marker = join(root, MARKER);
  if ((lstatSync(marker).mode & 0o777) !== 0o400) fail('Namespace marker must be immutable owner-read-only.');
  const value = JSON.parse(readImprovementPrivateFile(marker, 8192)) as ImprovementNamespace;
  object(value, ['schema', 'id', 'root', 'repository', 'experimentId', 'creatorPid', 'device', 'inode']);
  for (const key of ['id', 'root', 'repository', 'experimentId'] as const) text(value[key], key === 'experimentId' ? 128 : 4096);
  integer(value.creatorPid, 1, Number.MAX_SAFE_INTEGER); integer(value.device, 0, Number.MAX_SAFE_INTEGER); integer(value.inode, 1, Number.MAX_SAFE_INTEGER);
  if (value.schema !== 'o8/harness-refinement-namespace/v1' || value.root !== root
    || value.id !== process.env.O8_REFINEMENT_NAMESPACE_ID || digest(value) !== process.env.O8_REFINEMENT_NAMESPACE_DIGEST
    || value.device !== stat.dev || value.inode !== stat.ino || value.creatorPid === process.pid) {
    fail('Marker, process or namespace identity differs; use a fresh dedicated child process.');
  }
  assertImprovementDirectory(value.repository, false); outside(root, value.repository);
  return value;
}
