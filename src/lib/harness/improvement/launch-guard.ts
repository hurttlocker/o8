import 'server-only';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { createImprovementJournal } from './journal';
import type { ImprovementManifest } from './types';
import { canonical, digest, manifest as validateManifest, object, text } from './validation';

const PREFIX = 'harness-refinement-';
const PACKET_ID = /^harness-refinement-[a-f0-9]{64}-[a-f0-9]{64}$/;
const MAX_BYTES = 3 * 1024 * 1024;

/** Durable preparation, never approval. The registry is outside every packet checkout. */
export interface ImprovementPacketBinding {
  schema: 'o8/harness-refinement-packet/v1';
  packetId: string;
  experimentId: string;
  requestId: string;
  requestDigest: string;
  manifestDigest: string;
  manifest: ImprovementManifest;
  mountDigest: string;
  executionCarrier: string | null;
  claudeCodeCarrier: string | null;
}

/**
 * A future trusted consent verifier must authenticate these exact pins and atomically
 * consume the grant before any execution. A JSON file, actor, or approved boolean
 * cannot prove consent. There is deliberately no grant-writing/acceptance API here.
 */
export interface ImprovementPacketLaunchGrant {
  schema: 'o8/harness-refinement-launch-grant/v1';
  packetId: string;
  bindingDigest: string;
  manifestDigest: string;
  requestDigest: string;
  permissionsDigest: string;
  verifierDigest: string;
  mountDigest: string;
  authorizationId: string;
  issuer: string;
  proof: string;
  expiresAt: number;
}

export interface ImprovementPacketLaunchInput {
  packetId?: string | null;
  laneId?: string;
  repository: string | null | undefined;
  sourcePath?: string | null;
  runtime: string;
  model: string | null | undefined;
  effort: string | null | undefined;
  executionCarrier?: string | null;
  claudeCodeCarrier?: string | null;
  boundary: 'dispatch' | 'lane-recovery' | 'lane-spawn';
}

export class ImprovementPacketLaunchHeldError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`Refinement packet launch held: ${detail}`);
    this.name = 'ImprovementPacketLaunchHeldError';
  }
}
function held(code: string, detail: string): never { throw new ImprovementPacketLaunchHeldError(code, detail); }
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
function sha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) held('invalid_binding', 'Invalid digest pin.');
}
function privateOwner(stat: Stats): void {
  if (typeof process.geteuid !== 'function' || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) {
    held('unsafe_registry', 'Registry storage must be private and owned by this process user.');
  }
}
function dataRoot(): string {
  // Inject a copied environment so a missing read NEVER triggers app-data migration.
  return resolve(getDataDir({ ...process.env }));
}
function registryRoot(): string { return join(dataRoot(), 'harness-refinement-packets'); }
interface Directory { path: string; stat: Stats; fd: number }
function directory(path: string, privateRequired: boolean): Directory {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) held('unsafe_registry', 'Registry directory must not be a symlink.');
  if (privateRequired) privateOwner(stat);
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) held('unsafe_registry', 'Unsafe writable registry ancestor.');
  if (stat.uid !== process.geteuid!() && stat.uid !== 0) held('unsafe_registry', 'Untrusted registry ancestor owner.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  if (!same(stat, fstatSync(fd))) { closeSync(fd); held('unsafe_registry', 'Registry directory changed.'); }
  return { path, stat, fd };
}
function check(dirs: Directory[]): void {
  for (const entry of dirs) {
    if (!same(entry.stat, lstatSync(entry.path)) || !same(entry.stat, fstatSync(entry.fd))) {
      held('unsafe_registry', 'Registry directory identity changed.');
    }
  }
}
function access<T>(create: boolean, operation: (path: string, dirs: Directory[]) => T): T | null {
  const root = registryRoot();
  if (!create) {
    try { lstatSync(root); } catch (error) { if (missing(error)) return null; throw error; }
  }
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY || typeof process.geteuid !== 'function') {
    held('unsafe_registry', 'Private registry requires POSIX no-follow support.');
  }
  const parts = root.slice(parse(root).root.length).split(sep).filter(Boolean);
  const dirs: Directory[] = []; let current = parse(root).root;
  try {
    dirs.push(directory(current, false));
    for (let i = 0; i < parts.length; i += 1) {
      current = join(current, parts[i]!);
      try { dirs.push(directory(current, i === parts.length - 1)); } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return null;
        check(dirs);
        try { mkdirSync(current, { mode: 0o700 }); } catch (creationError) {
          if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError;
        }
        fsyncSync(dirs[dirs.length - 1]!.fd);
        dirs.push(directory(current, i === parts.length - 1));
      }
    }
    check(dirs); const result = operation(root, dirs); check(dirs); return result;
  } finally { for (const entry of dirs) closeSync(entry.fd); }
}
function readFile(path: string): unknown | null {
  let before: Stats;
  try { before = lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; }
  privateOwner(before);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES) held('unsafe_registry', 'Unsafe or oversized registry entry.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const unchanged = (stat: Stats): boolean => same(before, stat) && stat.size === before.size
    && stat.nlink === before.nlink && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
  try {
    if (!unchanged(fstatSync(fd))) held('unsafe_registry', 'Registry entry changed before read.');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) held('unsafe_registry', 'Truncated registry entry.');
      offset += count;
    }
    if (!unchanged(fstatSync(fd)) || !unchanged(lstatSync(path))) held('unsafe_registry', 'Registry entry changed while reading.');
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
}
function read(name: string): unknown | null { return access(false, (root) => readFile(join(root, name))); }
function publish(name: string, value: unknown): void {
  const bytes = Buffer.from(`${canonical(value)}\n`);
  if (bytes.length > MAX_BYTES) held('invalid_binding', 'Registry entry exceeds its byte budget.');
  access(true, (root, dirs) => {
    const target = join(root, name); const prior = readFile(target);
    if (prior !== null) {
      if (canonical(prior) !== canonical(value)) held('binding_conflict', 'Immutable registry binding already differs.');
      return;
    }
    const temp = join(root, `.pending-${randomUUID()}`);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const owned = fstatSync(fd); let published = false;
    try {
      writeFileSync(fd, bytes); fsyncSync(fd); check(dirs);
      if (!same(owned, lstatSync(temp))) held('unsafe_registry', 'Registry scratch identity changed.');
      linkSync(temp, target); published = true;
      if (!same(owned, lstatSync(temp))) held('unsafe_registry', 'Registry scratch changed after publication.');
      unlinkSync(temp); fsyncSync(dirs[dirs.length - 1]!.fd);
      if (canonical(readFile(target)) !== canonical(value)) held('unsafe_registry', 'Published binding differs.');
    } catch (error) {
      // No retry after an uncertain publication; preserve the durable evidence.
      if (published) held('publication_uncertain', 'Registry publication outcome requires reconciliation.');
      if (same(owned, lstatSync(temp))) unlinkSync(temp);
      throw error;
    } finally { closeSync(fd); }
  });
}
const bindingName = (packetId: string): string => `${digest(packetId)}.binding.json`;
const laneName = (laneId: string): string => `${digest(laneId)}.lane.json`;

export function improvementPacketId(experimentId: string, requestId: string): string {
  text(experimentId, 1024); text(requestId, 1024);
  return `${PREFIX}${digest(experimentId)}-${digest(requestId)}`;
}
function validateBinding(value: unknown): asserts value is ImprovementPacketBinding {
  const row = object(value, ['schema', 'packetId', 'experimentId', 'requestId', 'requestDigest', 'manifestDigest',
    'manifest', 'mountDigest', 'executionCarrier', 'claudeCodeCarrier']);
  if (row.schema !== 'o8/harness-refinement-packet/v1') held('invalid_binding', 'Unknown registry schema.');
  for (const key of ['packetId', 'experimentId', 'requestId']) text(row[key], 1024);
  for (const key of ['requestDigest', 'manifestDigest', 'mountDigest']) sha(row[key]);
  for (const key of ['executionCarrier', 'claudeCodeCarrier']) if (row[key] !== null) text(row[key], 128);
  validateManifest(row.manifest);
  if (row.packetId !== improvementPacketId(row.experimentId as string, row.requestId as string)
    || row.manifest.id !== row.experimentId || digest(row.manifest) !== row.manifestDigest
    || !isAbsolute(row.manifest.repository) || row.manifest.provenance !== 'native'
    || !isManualThinkingEffort(row.manifest.effort)) held('invalid_binding', 'Invalid immutable native execution binding.');
}
function loadBinding(packetId: string): ImprovementPacketBinding | null {
  if (!packetId.startsWith(PREFIX)) return null;
  if (!PACKET_ID.test(packetId)) held('missing_binding', 'Malformed reserved experiment packet ID.');
  const value = read(bindingName(packetId));
  if (value === null) held('missing_binding', 'Reserved experiment packet has no durable binding.');
  validateBinding(value);
  if (value.packetId !== packetId) held('binding_conflict', 'Registry packet identity differs.');
  return value;
}
function assertPending(binding: ImprovementPacketBinding): void {
  const state = createImprovementJournal(join(dataRoot(), 'harness-refinement')).read(binding.experimentId);
  if (!state || state.manifestDigest !== binding.manifestDigest || canonical(state.manifest) !== canonical(binding.manifest)
    || state.status !== 'pending' || state.pendingReceipt || state.pending?.kind !== 'execute'
    || state.pending.id !== binding.requestId || digest(state.pending) !== binding.requestDigest) {
    held('stale_binding', 'Packet no longer matches its exact durable pending execution.');
  }
}

/** Source-only preparation. This does not create a packet, grant consent, or launch. */
export function prepareImprovementPacketBinding(input: {
  experimentId: string; requestId: string; mountDigest: string;
  executionCarrier?: string | null; claudeCodeCarrier?: string | null;
}): ImprovementPacketBinding {
  text(input.experimentId, 1024); text(input.requestId, 1024); sha(input.mountDigest);
  const state = createImprovementJournal(join(dataRoot(), 'harness-refinement')).read(input.experimentId);
  if (!state?.pending || state.pending.id !== input.requestId) held('stale_binding', 'Exact pending execution is required.');
  const binding: ImprovementPacketBinding = {
    schema: 'o8/harness-refinement-packet/v1', packetId: improvementPacketId(input.experimentId, input.requestId),
    experimentId: input.experimentId, requestId: input.requestId, requestDigest: digest(state.pending),
    manifestDigest: state.manifestDigest, manifest: structuredClone(state.manifest), mountDigest: input.mountDigest,
    executionCarrier: input.executionCarrier ?? null, claudeCodeCarrier: input.claudeCodeCarrier ?? null,
  };
  validateBinding(binding); assertPending(binding);
  if (realpathSync(binding.manifest.repository) !== binding.manifest.repository) held('invalid_binding', 'Repository pin must be canonical.');
  publish(bindingName(binding.packetId), binding);
  return structuredClone(binding);
}

/** Keep ownership discoverable even if a mutable lane loses its packetId. */
export function bindImprovementPacketLane(packetId: string, laneId: string): void {
  text(laneId, 1024); const binding = loadBinding(packetId);
  if (!binding) return;
  assertPending(binding);
  publish(laneName(laneId), { schema: 'o8/harness-refinement-lane/v1', laneId, packetId, bindingDigest: digest(binding) });
}
function bindingFor(input: Pick<ImprovementPacketLaunchInput, 'packetId' | 'laneId'>): ImprovementPacketBinding | null {
  let associated = false;
  if (input.laneId) {
    const association = read(laneName(input.laneId));
    if (association !== null) {
      const row = object(association, ['schema', 'laneId', 'packetId', 'bindingDigest']);
      text(row.packetId, 1024); sha(row.bindingDigest);
      if (row.schema !== 'o8/harness-refinement-lane/v1' || row.laneId !== input.laneId || row.packetId !== input.packetId) {
        held('lane_binding_changed', 'Experiment lane ownership was removed or changed.');
      }
      const binding = loadBinding(row.packetId);
      if (!binding || digest(binding) !== row.bindingDigest) held('lane_binding_changed', 'Experiment lane manifest binding changed.');
      associated = true;
    }
  }
  const binding = input.packetId ? loadBinding(input.packetId) : null;
  if (binding && input.laneId && !associated) held('lane_binding_missing', 'Experiment lane has no durable packet association.');
  return binding;
}
/** Conservative retry suppression must remain usable after settlement or registry damage. */
export function improvementPacketRecoveryHeld(input: Pick<ImprovementPacketLaunchInput, 'packetId' | 'laneId'>): boolean {
  if (input.packetId?.startsWith(PREFIX)) return true;
  try { return bindingFor(input) !== null; } catch { return true; }
}
/** Resolve immutable ownership only; never a launch grant. */
export function readImprovementPacketBinding(input: Pick<ImprovementPacketLaunchInput, 'packetId' | 'laneId'>): ImprovementPacketBinding | null {
  const binding = bindingFor(input);
  if (binding) assertPending(binding);
  return binding;
}
/** Read source pins only; inspection does not confer packet or launch authority. */
export function observeImprovementSource({ manifest }: Pick<ImprovementPacketBinding, 'manifest'>, path: string): { head: string; tree: string } {
  // Do not let ambient Git overrides redirect source verification or repository
  // fsmonitor configuration execute a command during this read-only check.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    NODE_ENV: process.env.NODE_ENV, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const gitAt = (cwd: string, args: string[]): string => execFileSync('git', [
    '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.attributesFile=/dev/null', '-C', cwd, ...args,
  ], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const git = (args: string[]): string => gitAt(path, args);
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(path)) {
    held('repository_changed', 'Launch source must be the exact checkout root.');
  }
  if (git(['rev-parse', '--verify', 'HEAD']) !== manifest.baselineRevision) {
    held('source_revision_changed', 'Post-refresh checkout HEAD differs from the immutable source revision.');
  }
  // Refuse sources requiring unverified helper programs rather than invoke a
  // configured clean/process filter or descend into a submodule during status.
  if (git(['config', '--null', '--name-only', '--list']).split('\0').some((key) => key.toLowerCase().startsWith('filter.'))
    || /(^|\n)160000 /.test(git(['ls-files', '--stage']))) {
    held('source_helpers_unverified', 'Repository filters or submodules require separately verified source inspection.');
  }
  if (git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'])) {
    held('source_dirty', 'Launch checkout differs from the clean immutable source revision.');
  }
  const expectedCommon = realpathSync(resolve(manifest.repository,
    gitAt(manifest.repository, ['rev-parse', '--git-common-dir'])));
  const actualCommon = realpathSync(resolve(path, git(['rev-parse', '--git-common-dir'])));
  if (actualCommon !== expectedCommon) held('repository_changed', 'Launch checkout is not a worktree of the pinned repository.');
  return { head: git(['rev-parse', '--verify', 'HEAD']), tree: git(['rev-parse', '--verify', 'HEAD^{tree}']) };
}
function assertGrant(binding: ImprovementPacketBinding): never {
  const value = read(`${digest(binding.packetId)}.grant.json`);
  if (value !== null) {
    const row = object(value, ['schema', 'packetId', 'bindingDigest', 'manifestDigest', 'requestDigest',
      'permissionsDigest', 'verifierDigest', 'mountDigest', 'authorizationId', 'issuer', 'proof', 'expiresAt']);
    for (const key of ['bindingDigest', 'manifestDigest', 'requestDigest', 'permissionsDigest', 'verifierDigest', 'mountDigest']) sha(row[key]);
    for (const key of ['authorizationId', 'issuer', 'proof']) text(row[key], 4096);
    if (row.schema !== 'o8/harness-refinement-launch-grant/v1' || row.packetId !== binding.packetId
      || row.bindingDigest !== digest(binding) || row.manifestDigest !== binding.manifestDigest
      || row.requestDigest !== binding.requestDigest || row.permissionsDigest !== binding.manifest.permissionsDigest
      || row.verifierDigest !== binding.manifest.verifierDigest || row.mountDigest !== binding.mountDigest
      || typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= Date.now()) {
      held('invalid_grant', 'Launch grant does not match the exact immutable permission, verifier, mount and request pins.');
    }
    held('unverified_grant', 'A stored grant is not trusted authorization; no consent verifier or verified isolated carrier is installed.');
  }
  held('launch_authorization_required', 'Separate explicit trusted launch authorization and a verified isolated carrier are required.');
}

/** Read and validate current immutable experiment pins; this conveys no launch authority. */
export function readImprovementRuntimeBinding(input: ImprovementPacketLaunchInput): ImprovementPacketBinding | null {
  const binding = bindingFor(input);
  if (!binding) return null;
  assertPending(binding);
  if (!input.repository || realpathSync(input.repository) !== binding.manifest.repository
    || input.runtime !== binding.manifest.runtime || input.model !== binding.manifest.model
    || input.effort !== binding.manifest.effort || (input.executionCarrier ?? null) !== binding.executionCarrier
    || (input.claudeCodeCarrier ?? null) !== binding.claudeCodeCarrier) {
    held('launch_pins_changed', 'Effective repository, runtime, model, effort or carrier differs from the immutable manifest.');
  }
  return binding;
}

/** Called at real dispatch/recovery/spawn boundaries; every refinement launch remains held. */
export function assertImprovementPacketLaunch(input: ImprovementPacketLaunchInput): void {
  const binding = readImprovementRuntimeBinding(input);
  if (!binding) return;
  observeImprovementSource(binding, input.sourcePath ?? input.repository!);
  // Existing native carriers cannot attest Linux filesystem/network/credential isolation,
  // exact permission/mount enforcement, or launch-once consent. Never infer this from
  // platform, actor=user/operator, an Ori/auth preflight, or any request-body claim.
  assertGrant(binding);
}
