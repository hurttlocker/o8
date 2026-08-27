import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, relative, resolve, sep } from 'node:path';

export const RELEASE_BUILD_CACHE_SCHEMA = 'o8/release-build-cache-entry/v1';
export const RELEASE_BUILD_CACHE_RECEIPT_SCHEMA = 'o8/release-build-cache-receipt/v1';
export const RELEASE_BUILD_CACHE_PHASES = Object.freeze(['web', 'speech', 'native']);

const CACHE_VERSION_DIR = 'release-v1';
const ENTRY_LIMIT = 1;
const COMPATIBILITY_LIMIT = 2;
const WEB_ENVIRONMENT_PATTERNS = [
  /^NEXT_PUBLIC_/,
  /^CLERK_PUBLISHABLE_KEY$/,
  /^O8_APP_VERSION$/,
  /^O8_BYOK_REQUIRED$/,
  /^O8_EXPERIMENTAL_/,
  /^O8_FEEDBACK_WEBHOOK_URL$/,
  /^O8_LICENSE_PUBKEY$/,
  /^O8_SENTRY_DSN$/,
  /^SENTRY_DSN$/,
];

const PHASE_CONFIG = Object.freeze({
  web: Object.freeze({
    targets: ['.next/cache'],
    excludes: [],
    recipeInputs: [
      'package.json',
      'package-lock.json',
      'next.config.ts',
      'tsconfig.json',
      'scripts/build.mjs',
      'scripts/bust-stale-patch-cache.mjs',
      'scripts/tauri-export.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/release-build-cache.mjs',
      'patches',
    ],
    toolchains: [['node', process.execPath, ['--version']], ['npm', 'npm', ['--version']]],
  }),
  speech: Object.freeze({
    targets: ['src-tauri/sidecars/speech-local/.build'],
    excludes: [],
    recipeInputs: [
      'src-tauri/sidecars/speech-local/Package.swift',
      'src-tauri/sidecars/speech-local/Package.resolved',
      'scripts/build-speech-local.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/release-build-cache.mjs',
    ],
    toolchains: [['swift', 'swift', ['--version']]],
  }),
  native: Object.freeze({
    targets: ['src-tauri/target/release'],
    excludes: [
      'src-tauri/target/release/bundle',
      'src-tauri/target/release/server',
      'src-tauri/target/release/build-cache-receipt.json',
    ],
    recipeInputs: [
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/build.rs',
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.macos.conf.json',
      'package.json',
      'scripts/tauri-build.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/release-build-cache.mjs',
    ],
    toolchains: [
      ['cargo', 'cargo', ['--version']],
      ['rustc', 'rustc', ['--version']],
      ['rustcHost', 'rustc', ['-vV']],
    ],
  }),
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function commandVersion(root, command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim().split('\n')[0];
  } catch {
    return 'unavailable';
  }
}

function collectInputFiles(root, relativePath, results) {
  const absolute = join(root, relativePath);
  if (!existsSync(absolute)) {
    results.push({ path: relativePath, sha256: 'missing' });
    return;
  }
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`cache recipe input is a symbolic link: ${relativePath}`);
  if (metadata.isFile()) {
    results.push({ path: relativePath.split(sep).join('/'), sha256: sha256Text(readFileSync(absolute)) });
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const name of readdirSync(absolute).sort()) {
    collectInputFiles(root, join(relativePath, name), results);
  }
}

function gitOutput(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function dirtyEntries(root) {
  return gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^(?:[ MADRCU?!]{1,2} )?o8\.md$/.test(line));
}

export function resolveReleaseBuildCacheRoot(env = process.env) {
  return resolve(env.O8_RELEASE_BUILD_CACHE_DIR?.trim() || join(homedir(), '.o8-build-cache', CACHE_VERSION_DIR));
}

export function collectReleaseBuildCacheIdentity(root, phase, options = {}) {
  const config = PHASE_CONFIG[phase];
  if (!config) throw new Error(`unsupported release cache phase: ${phase}`);
  const inputs = [];
  for (const path of config.recipeInputs) collectInputFiles(root, path, inputs);
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const environment = phase === 'web'
    ? Object.fromEntries(Object.keys(options.env ?? process.env)
      .filter((key) => WEB_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(key)))
      .sort()
      .map((key) => [key, sha256Text(String((options.env ?? process.env)[key] ?? ''))]))
    : {};
  const compatibility = {
    schema: 'o8/release-build-cache-compatibility/v1',
    phase,
    platform: process.platform,
    arch: process.arch,
    buildMode: 'release',
    buildOptions: options.buildOptions ?? {},
    targets: config.targets,
    excludes: config.excludes,
    toolchains: Object.fromEntries(config.toolchains.map(([name, command, args]) => [
      name,
      commandVersion(root, command, args),
    ])),
    inputs,
    environment,
  };
  const source = {
    head: gitOutput(root, ['rev-parse', 'HEAD']),
    tree: gitOutput(root, ['rev-parse', 'HEAD^{tree}']),
    worktreeClean: dirtyEntries(root).length === 0,
  };
  const compatibilitySha256 = sha256Text(stableJson(compatibility));
  const sourceSha256 = sha256Text(stableJson(source));
  return {
    phase,
    compatibility,
    compatibilitySha256,
    source,
    sourceSha256,
    entrySha256: sha256Text(stableJson({ compatibilitySha256, sourceSha256 })),
  };
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
}

function entriesDirectory(cacheRoot, identity) {
  return join(cacheRoot, 'entries', identity.phase, identity.compatibilitySha256);
}

function manifestPathFor(directory, entrySha256) {
  return join(directory, `${entrySha256}.json`);
}

function archivePathFor(directory, entrySha256) {
  return join(directory, `${entrySha256}.tar`);
}

function normalizeArchivePath(value) {
  const slashPath = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!slashPath || slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) return null;
  const normalized = normalize(slashPath).split(sep).join('/');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function pathInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function pathAllowed(candidate, targets, excludes) {
  return targets.some((target) => pathInside(candidate, target))
    && !excludes.some((excluded) => pathInside(candidate, excluded));
}

function assertTreeHasNoLinks(path, root = path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`cache tree contains symbolic link: ${relative(root, path) || '.'}`);
  if (!metadata.isDirectory()) return;
  for (const name of readdirSync(path)) assertTreeHasNoLinks(join(path, name), root);
}

function listArchive(root, archivePath) {
  const output = execFileSync('tar', ['-tf', archivePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\n').filter(Boolean);
}

async function verifyCacheEntry(root, identity, manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { valid: false, reason: 'manifest_invalid' };
  }
  if (manifest?.schema !== RELEASE_BUILD_CACHE_SCHEMA
    || manifest.phase !== identity.phase
    || manifest.compatibilitySha256 !== identity.compatibilitySha256
    || !manifest.archive?.name
    || !Array.isArray(manifest.targets)
    || !Array.isArray(manifest.excludes)) {
    return { valid: false, reason: 'manifest_mismatch' };
  }
  const expected = PHASE_CONFIG[identity.phase];
  if (stableJson(manifest.targets) !== stableJson(expected.targets)
    || stableJson(manifest.excludes) !== stableJson(expected.excludes)) {
    return { valid: false, reason: 'target_contract_mismatch' };
  }
  const archivePath = join(dirname(manifestPath), basename(manifest.archive.name));
  if (!existsSync(archivePath)) return { valid: false, reason: 'archive_missing' };
  const size = statSync(archivePath).size;
  if (size !== manifest.archive.size) return { valid: false, reason: 'archive_size_mismatch' };
  if (await sha256File(archivePath) !== manifest.archive.sha256) {
    return { valid: false, reason: 'archive_checksum_mismatch' };
  }
  let archivedPaths;
  try {
    archivedPaths = listArchive(root, archivePath);
  } catch {
    return { valid: false, reason: 'archive_unreadable' };
  }
  if (archivedPaths.length === 0) return { valid: false, reason: 'archive_empty' };
  for (const rawPath of archivedPaths) {
    const candidate = normalizeArchivePath(rawPath);
    if (!candidate || !pathAllowed(candidate, manifest.targets, manifest.excludes)) {
      return { valid: false, reason: 'archive_path_outside_contract' };
    }
  }
  return { valid: true, manifest, archivePath };
}

function cacheManifests(directory, preferredEntry) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(directory, name))
    .sort((left, right) => {
      const leftPreferred = basename(left, '.json') === preferredEntry ? 1 : 0;
      const rightPreferred = basename(right, '.json') === preferredEntry ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    });
}

export async function restoreReleaseBuildCache(root, phase, options = {}) {
  const started = Date.now();
  if ((options.env ?? process.env).O8_RELEASE_BUILD_CACHE === 'off') {
    return { phase, status: 'bypass', reason: 'disabled', durationMs: Date.now() - started };
  }
  const identity = options.identity ?? collectReleaseBuildCacheIdentity(root, phase, options);
  const cacheRoot = options.cacheRoot ?? resolveReleaseBuildCacheRoot(options.env);
  if (identity.source.worktreeClean === false) {
    return { phase, status: 'bypass', reason: 'dirty_worktree', durationMs: Date.now() - started };
  }
  const directory = entriesDirectory(cacheRoot, identity);
  const candidates = cacheManifests(directory, identity.entrySha256);
  if (candidates.length === 0) {
    return { phase, status: 'miss', reason: 'entry_missing', durationMs: Date.now() - started };
  }
  let lastReason = 'entry_invalid';
  for (const manifestPath of candidates) {
    const verified = await verifyCacheEntry(root, identity, manifestPath);
    if (!verified.valid) {
      lastReason = verified.reason;
      continue;
    }
    const restoreRoot = mkdtempSync(join(cacheRoot, '.restore-'));
    try {
      execFileSync('tar', ['-xf', verified.archivePath, '-C', restoreRoot], {
        cwd: root,
        stdio: 'pipe',
        timeout: 10 * 60_000,
      });
      for (const target of verified.manifest.targets) {
        const extracted = join(restoreRoot, target);
        if (!existsSync(extracted)) throw new Error(`cache target missing after extraction: ${target}`);
        assertTreeHasNoLinks(extracted);
      }
      for (const target of verified.manifest.targets) {
        const extracted = join(restoreRoot, target);
        const destination = join(root, target);
        rmSync(destination, { recursive: true, force: true });
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(extracted, destination);
      }
      return {
        phase,
        status: verified.manifest.entrySha256 === identity.entrySha256 ? 'hit_exact' : 'hit_compatible',
        reason: 'verified',
        entrySha256: verified.manifest.entrySha256,
        producerSourceSha256: verified.manifest.sourceSha256,
        archiveBytes: verified.manifest.archive.size,
        estimatedSavedMs: verified.manifest.buildDurationMs ?? null,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      lastReason = `restore_failed:${error instanceof Error ? error.message : String(error)}`;
    } finally {
      rmSync(restoreRoot, { recursive: true, force: true });
    }
  }
  return { phase, status: 'miss', reason: lastReason, durationMs: Date.now() - started };
}

function tarArguments(root, config, archivePath) {
  const args = ['-cf', archivePath, '-C', root];
  for (const excluded of config.excludes) args.push('--exclude', excluded);
  args.push(...config.targets);
  return args;
}

function pruneEntries(directory, keepEntry) {
  const manifests = readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const ordered = [
    keepEntry,
    ...manifests
      .map(({ name }) => basename(name, '.json'))
      .filter((entry) => entry !== keepEntry),
  ];
  const keep = new Set(ordered.slice(0, ENTRY_LIMIT));
  for (const { name } of manifests) {
    const entry = basename(name, '.json');
    if (keep.has(entry)) continue;
    rmSync(join(directory, name), { force: true });
    rmSync(archivePathFor(directory, entry), { force: true });
  }
}

function pruneCompatibilityDirectories(cacheRoot, phase, keepCompatibility) {
  const phaseRoot = join(cacheRoot, 'entries', phase);
  if (!existsSync(phaseRoot)) return;
  const directories = readdirSync(phaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      mtimeMs: statSync(join(phaseRoot, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const ordered = [
    keepCompatibility,
    ...directories.map(({ name }) => name).filter((name) => name !== keepCompatibility),
  ];
  const keep = new Set(ordered.slice(0, COMPATIBILITY_LIMIT));
  for (const { name } of directories) {
    if (!keep.has(name)) rmSync(join(phaseRoot, name), { recursive: true, force: true });
  }
}

export async function captureReleaseBuildCache(root, phase, options = {}) {
  const started = Date.now();
  if ((options.env ?? process.env).O8_RELEASE_BUILD_CACHE === 'off') {
    return { phase, status: 'bypass', reason: 'disabled', durationMs: Date.now() - started };
  }
  const identity = options.identity ?? collectReleaseBuildCacheIdentity(root, phase, options);
  const cacheRoot = options.cacheRoot ?? resolveReleaseBuildCacheRoot(options.env);
  if (identity.source.worktreeClean === false) {
    return { phase, status: 'bypass', reason: 'dirty_worktree', durationMs: Date.now() - started };
  }
  const config = PHASE_CONFIG[phase];
  const missing = config.targets.filter((target) => !existsSync(join(root, target)));
  if (missing.length > 0) {
    return { phase, status: 'miss', reason: `target_missing:${missing[0]}`, durationMs: Date.now() - started };
  }
  for (const target of config.targets) assertTreeHasNoLinks(join(root, target));
  const directory = entriesDirectory(cacheRoot, identity);
  ensurePrivateDirectory(directory);
  const finalManifestPath = manifestPathFor(directory, identity.entrySha256);
  const finalArchivePath = archivePathFor(directory, identity.entrySha256);
  if (existsSync(finalManifestPath) && existsSync(finalArchivePath)) {
    const verified = await verifyCacheEntry(root, identity, finalManifestPath);
    if (verified.valid) {
      return {
        phase,
        status: 'already_captured',
        reason: 'verified',
        entrySha256: identity.entrySha256,
        archiveBytes: verified.manifest.archive.size,
        durationMs: Date.now() - started,
      };
    }
  }
  const temporaryArchive = `${finalArchivePath}.${process.pid}.tmp`;
  const temporaryManifest = `${finalManifestPath}.${process.pid}.tmp`;
  try {
    execFileSync('tar', tarArguments(root, config, temporaryArchive), {
      cwd: root,
      stdio: 'pipe',
      timeout: 20 * 60_000,
    });
    chmodSync(temporaryArchive, 0o600);
    const archive = {
      name: basename(finalArchivePath),
      size: statSync(temporaryArchive).size,
      sha256: await sha256File(temporaryArchive),
    };
    const manifest = {
      schema: RELEASE_BUILD_CACHE_SCHEMA,
      phase,
      createdAt: new Date().toISOString(),
      entrySha256: identity.entrySha256,
      compatibilitySha256: identity.compatibilitySha256,
      sourceSha256: identity.sourceSha256,
      source: identity.source,
      compatibility: identity.compatibility,
      targets: config.targets,
      excludes: config.excludes,
      buildDurationMs: options.buildDurationMs ?? null,
      archive,
    };
    writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryArchive, finalArchivePath);
    renameSync(temporaryManifest, finalManifestPath);
    pruneEntries(directory, identity.entrySha256);
    pruneCompatibilityDirectories(cacheRoot, phase, identity.compatibilitySha256);
    return {
      phase,
      status: 'captured',
      reason: 'verified',
      entrySha256: identity.entrySha256,
      archiveBytes: archive.size,
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(temporaryArchive, { force: true });
    rmSync(temporaryManifest, { force: true });
  }
}

export function createReleaseBuildCacheRunId() {
  return `${Date.now()}-${process.pid}`;
}

function runDirectory(cacheRoot, runId) {
  return join(cacheRoot, 'runs', runId);
}

export function writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, receipt) {
  const directory = runDirectory(cacheRoot, runId);
  ensurePrivateDirectory(directory);
  writeFileSync(join(directory, `${receipt.phase}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export function finalizeReleaseBuildCacheReceipt(cacheRoot, runId, summary) {
  const directory = runDirectory(cacheRoot, runId);
  const phases = {};
  if (existsSync(directory)) {
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
      const receipt = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      phases[receipt.phase] = receipt;
    }
  }
  const restores = Object.values(phases).map((phase) => phase.restore).filter(Boolean);
  const receipt = {
    schema: RELEASE_BUILD_CACHE_RECEIPT_SCHEMA,
    runId,
    createdAt: new Date().toISOString(),
    outcome: summary.outcome,
    source: summary.source,
    platform: process.platform,
    arch: process.arch,
    buildDurationMs: summary.buildDurationMs,
    phases,
    totals: {
      archiveBytesRestored: restores.reduce((sum, restore) => sum + (restore.archiveBytes ?? 0), 0),
      estimatedSavedMs: restores.reduce((sum, restore) => sum + (restore.estimatedSavedMs ?? 0), 0),
      hits: restores.filter((restore) => restore.status === 'hit_exact' || restore.status === 'hit_compatible').length,
      misses: restores.filter((restore) => restore.status === 'miss').length,
    },
  };
  const receiptsDirectory = join(cacheRoot, 'receipts');
  ensurePrivateDirectory(receiptsDirectory);
  const receiptPath = join(receiptsDirectory, `${runId}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  rmSync(directory, { recursive: true, force: true });
  return { receipt, receiptPath };
}

export const releaseBuildCacheInternals = {
  PHASE_CONFIG,
  normalizeArchivePath,
  pathAllowed,
  sha256File,
  stableJson,
};
