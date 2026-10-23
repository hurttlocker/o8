import { closeSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getDataDir } from '@/lib/data-dir-migration';
import { decryptValueSync, encryptValueSync } from '@/lib/db/master-key';
import { sanitizeRuntimeConfigText } from './runtime-config';
import { withProviderStoreLock } from './store-lock';

interface Artifact { path: string; runtime: string; owner: 'o8'; replacement: string }
const registryPath = () => join(realpathSync(getDataDir()), 'owned-credential-artifacts.json');
const unsafe = () => new Error('Owned runtime credential artifacts unavailable or unsafe; previous credential state preserved.');
function canonical(file: string): string { assertParents(file, true); return join(realpathSync(dirname(file)), basename(file)); }
function assertParents(file: string, systemAliases = false): void {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() && !(systemAliases && stat.isSymbolicLink() && ['/var', '/tmp', '/etc'].includes(dir))) throw unsafe();
    dir = dirname(dir);
  }
}
function assertRegular(file: string): void {
  if (!existsSync(dirname(file))) return;
  assertParents(file);
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw unsafe();
}
function registry(): Artifact[] {
  assertRegular(registryPath());
  if (!existsSync(registryPath())) return [];
  const records: unknown = JSON.parse(readFileSync(registryPath(), 'utf8'));
  if (!Array.isArray(records) || records.length > 100_000) throw unsafe();
  return records.map(record => {
    if (!record || typeof record.path !== 'string' || !isAbsolute(record.path) || typeof record.runtime !== 'string' || typeof record.replacement !== 'string' || record.owner !== 'o8') throw unsafe();
    return record as Artifact;
  }).filter(record => record.runtime !== 'codex');
}
function encode(path: string, runtime: string, contents: string): string {
  const { iv, ciphertext } = encryptValueSync(JSON.stringify({ path, runtime, owner: 'o8', contents }));
  return `enc:${iv}:${ciphertext}`;
}
function decode(record: Artifact): string {
  const match = /^enc:([a-fA-F0-9]{24}):([a-fA-F0-9]+)$/.exec(record.replacement);
  const plain = match && decryptValueSync(match[2], match[1]);
  if (typeof plain !== 'string') throw unsafe();
  const payload = JSON.parse(plain) as { path?: unknown; runtime?: unknown; owner?: unknown; contents?: unknown };
  if (payload.path !== record.path || payload.runtime !== record.runtime || payload.owner !== record.owner || typeof payload.contents !== 'string') throw unsafe();
  return payload.contents;
}
function persist(records: Artifact[]): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
/** Caller holds the store lock. Persist cleanup ownership before any destination write. */
function register(file: string, runtime: string, safe: string): void {
  const records = registry();
  const path = canonical(file);
  const record: Artifact = { path, runtime, owner: 'o8', replacement: encode(path, runtime, safe) };
  const index = records.findIndex(entry => entry.path === record.path);
  if (index < 0) records.push(record); else records[index] = record;
  persist(records);
}
function replaceOpened(file: string, contents: string): void {
  assertRegular(file);
  const before = existsSync(file) ? lstatSync(file) : null;
  const parents = [];
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) parents.push({ dir, stat: lstatSync(dir) });
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw unsafe();
    if (before && (stat.dev !== before.dev || stat.ino !== before.ino)) throw unsafe();
    for (const parent of parents) {
      const current = lstatSync(parent.dir);
      if (!current.isDirectory() || current.dev !== parent.stat.dev || current.ino !== parent.stat.ino) throw unsafe();
    }
    if (process.platform !== 'win32') fchmodSync(fd, 0o600);
    // Open handles never redirect a scrub through a replaced parent directory.
    ftruncateSync(fd, 0);
    writeFileSync(fd, contents, 'utf8');
  } finally { closeSync(fd); }
}
export function writeOwnedRuntimeArtifact(file: string, runtime: string, contents: string): void {
  if (runtime === 'codex') throw new Error('Codex credential artifacts are not managed. See #4334.');
  const safe = sanitizeRuntimeConfigText(file, contents, runtime);
  file = canonical(file);
  withProviderStoreLock(() => {
    assertRegular(file);
    register(file, runtime, safe);
    replaceOpened(file, safe);
  });
}

/** Bounded migration of ordinary generated destinations, including archived homes. */
function discovered(): { path: string; runtime: string }[] {
  const found: { path: string; runtime: string }[] = [];
  let visited = 0;
  const walk = (dir: string, runtime: string, depth: number) => {
    if (!existsSync(dir)) return;
    if (!lstatSync(dir).isDirectory()) throw unsafe();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++visited > 100_000) throw unsafe();
      const path = join(dir, entry.name);
      // payer policy part c: .single-turns keeps its existing credential behavior until the supervisor resolves references.
      // Runtime/plugin/session links are borrowed code/state, never owned credentials.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && depth > 0 && !['sessions', 'npm', 'plugins', 'node_modules', '.git', '.single-turns'].includes(entry.name)) walk(path, runtime, depth - 1);
      else if (entry.isFile() && (/^(auth(?:-profiles|-state)?\.json|(?:config|requirements|managed_config)\.(?:toml|yaml|yml|json)|openclaw\.json|\.env|models_dev_cache\.json)$/.test(entry.name)
        || /^orchestrator-.*\.json$/.test(entry.name)
        || (runtime === 'openclaw' && dir.includes(`${join('credentials', '')}`) && entry.name.endsWith('.json')))) found.push({ path, runtime });
    }
  };
  for (const [name, runtime, depth] of [['hermes-o8', 'hermes', 3], ['mcp', 'claude-code', 1]] as const) walk(join(getDataDir(), name), runtime, depth);
  if (existsSync(getDataDir())) for (const entry of readdirSync(getDataDir(), { withFileTypes: true })) {
    if (!/^owned-[a-z0-9-]+$/.test(entry.name) || entry.name.includes('codex')) continue;
    walk(join(getDataDir(), entry.name), entry.name.slice('owned-'.length), 6);
  }
  for (const [name, value] of Object.entries(process.env)) if (/^(O8|CORTEX_IDE)_OWNED_[A-Z0-9_]+_ROOT$/.test(name) && !name.includes('CODEX') && value) {
    if (!isAbsolute(value)) throw unsafe();
    const runtime = name.split('_OWNED_')[1].replace(/_ROOT$/, '').toLowerCase().replaceAll('_', '-');
    walk(value, runtime, 6);
    walk(`${value.replace(/\/+$/, '')}-archive`, runtime, 6);
  }
  walk(join(homedir(), '.openclaw-o8'), 'openclaw', 5);
  return found;
}
/** Reconcile every owned file, even when a child does not declare that path or runtime. */
function reconcileOwnedRuntimeArtifacts(candidates: { path: string; runtime: string }[] = []): void {
  const records = registry();
  const previous = new Map(records.map(record => [record.path, decode(record)]));
  const entries = new Map(records.map(record => [record.path, { path: record.path, runtime: record.runtime }]));
  for (const record of [...discovered(), ...candidates]) { const path = canonical(record.path); entries.set(path, { ...record, path }); }
  const prepared: { path: string; safe: string; changed: boolean }[] = [];
  for (const record of entries.values()) {
    assertRegular(record.path);
    if (!existsSync(record.path)) continue;
    const raw = readFileSync(record.path, 'utf8');
    const safe = sanitizeRuntimeConfigText(record.path, raw, record.runtime);
    prepared.push({ path: record.path, safe, changed: raw !== safe });
  }
  // Retain ownership when a file is temporarily missing: an older child can
  // recreate it after revocation. Never restore contents from this registry.
  const next = new Map(records.map(record => [record.path, record]));
  for (const record of prepared) {
    const runtime = entries.get(record.path)!.runtime;
    if (next.get(record.path)?.runtime !== runtime || previous.get(record.path) !== record.safe) {
      next.set(record.path, { path: record.path, runtime, owner: 'o8', replacement: encode(record.path, runtime, record.safe) });
    }
  }
  // Commit cleanup ownership before any destination change, preserving fresh
  // OAuth while avoiding registry writes on unchanged ordinary launches.
  if (next.size !== records.length || records.some(record => next.get(record.path) !== record)) persist([...next.values()]);
  for (const record of prepared) if (record.changed) replaceOpened(record.path, record.safe);
}
/** Caller holds .provider-keys.lock. Used by both mutation and actual child launch. */
export function purgeOwnedRuntimeArtifacts(): void { reconcileOwnedRuntimeArtifacts(); }
function knownOwnedPath(file: string): boolean {
  const roots = [getDataDir(), join(homedir(), '.openclaw-o8')];
  for (const [name, value] of Object.entries(process.env)) if (/^(O8|CORTEX_IDE)_OWNED_[A-Z0-9_]+_ROOT$/.test(name) && value) roots.push(value, `${value.replace(/\/+$/, '')}-archive`);
  return roots.some(root => {
    const inside = relative(resolve(root), resolve(file));
    return inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside);
  });
}
/** Synchronous launch seam. The central child-process wrapper already owns the lock. */
export function assertOwnedArtifactsForLaunch(env: Record<string, string | undefined>, args: readonly string[] = []): void {
  const candidates: { path: string; runtime: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || !isAbsolute(value) || !knownOwnedPath(value)) continue;
    if (name === 'CLAUDE_CONFIG_DIR') for (const file of ['settings.json', 'settings.local.json', '.claude.json', 'auth.json']) candidates.push({ path: join(value, file), runtime: 'claude-code' });
    if (name === 'HERMES_HOME' || name === 'HOME') {
      const home = name === 'HOME' ? join(value, '.hermes') : value;
      for (const file of ['config.yaml', '.env', 'auth.json', 'models_dev_cache.json']) candidates.push({ path: join(home, file), runtime: 'hermes' });
    }
    if (name === 'OPENCLAW_CONFIG_PATH') candidates.push({ path: value, runtime: 'openclaw' });
  }
  for (const arg of args) if (isAbsolute(arg) && knownOwnedPath(arg) && /^orchestrator-.*\.json$/.test(basename(arg))) candidates.push({ path: arg, runtime: 'claude-code' });
  // Owned files never carry saved keys, including for API billing. Only the
  // concrete runtime's freshly resolved API environment may carry credentials.
  reconcileOwnedRuntimeArtifacts(candidates.filter(candidate => existsSync(candidate.path)));
}
