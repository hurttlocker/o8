import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  finalizeReleaseBuildCacheReceipt,
  releaseBuildCacheInternals,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
  type ReleaseBuildCacheIdentity,
} from '../scripts/lib/release-build-cache.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-cache-repo-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'o8-release-cache-store-'));
  roots.push(root, cacheRoot);
  mkdirSync(join(root, '.next', 'cache', 'webpack'), { recursive: true });
  writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'compiled-source-a');
  return { root, cacheRoot };
}

function identity(source: string): ReleaseBuildCacheIdentity {
  return {
    phase: 'web',
    compatibility: { phase: 'web', lock: 'lock-a', toolchain: 'node-a' },
    compatibilitySha256: 'compatibility-a',
    source: { head: source, tree: `tree-${source}`, worktreeClean: true },
    sourceSha256: `source-${source}`,
    entrySha256: `entry-${source}`,
  };
}

function nativeIdentity(source: string): ReleaseBuildCacheIdentity {
  return {
    ...identity(source),
    phase: 'native',
    compatibility: { phase: 'native', lock: 'cargo-lock-a', toolchain: 'rust-a' },
  };
}

describe('shared release build cache', () => {
  it('hashes local production environment files without recording their values', () => {
    const { root } = fixture();
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_CACHE_CANARY=secret-one\n');
    const first = releaseBuildCacheInternals.collectWebEnvironmentFiles(root);
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_CACHE_CANARY=secret-two\n');
    const second = releaseBuildCacheInternals.collectWebEnvironmentFiles(root);

    expect(first.find((entry) => entry.path === '.env.local')?.sha256)
      .not.toBe(second.find((entry) => entry.path === '.env.local')?.sha256);
    expect(JSON.stringify(first)).not.toContain('secret-one');
  });

  it('changes compatibility when release options or hashed web environment change', () => {
    const root = process.cwd();
    const nativeA = collectReleaseBuildCacheIdentity(root, 'native', {
      buildOptions: { cargoTauriArgs: ['--no-bundle'] },
    });
    const nativeB = collectReleaseBuildCacheIdentity(root, 'native', {
      buildOptions: { cargoTauriArgs: ['--no-bundle', '--', '--features', 'dev-mcp-plugin'] },
    });
    expect(nativeA.compatibilitySha256).not.toBe(nativeB.compatibilitySha256);

    const webA = collectReleaseBuildCacheIdentity(root, 'web', {
      env: { ...process.env, NEXT_PUBLIC_CACHE_CANARY: 'one' },
    });
    const webB = collectReleaseBuildCacheIdentity(root, 'web', {
      env: { ...process.env, NEXT_PUBLIC_CACHE_CANARY: 'two' },
    });
    expect(webA.compatibilitySha256).not.toBe(webB.compatibilitySha256);
  });

  it('restores a verified compatible entry across changed source state', async () => {
    const { root, cacheRoot } = fixture();
    const captured = await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
      buildDurationMs: 42_000,
    });
    expect(captured).toMatchObject({ status: 'captured', reason: 'verified' });

    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'stale-local-output');
    const restored = await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    });
    expect(restored).toMatchObject({
      status: 'hit_compatible',
      reason: 'verified',
      producerSourceSha256: 'source-a',
      estimatedSavedMs: 42_000,
    });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('compiled-source-a');
  });

  it('restores and prunes normal compiler output without touching project node_modules', async () => {
    const { root, cacheRoot } = fixture();
    const nativeModuleRoot = join(root, 'node_modules', 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');

    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
    })).toMatchObject({ status: 'captured' });
    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'compiled-source-b');
    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    })).toMatchObject({ status: 'captured' });

    const entryDirectory = join(cacheRoot, 'entries', 'web', 'compatibility-a');
    expect(readdirSync(entryDirectory).sort()).toEqual(['entry-b.json', 'entry-b.tar']);
    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'stale-local-output');
    expect(await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('c'),
    })).toMatchObject({ status: 'hit_compatible', producerSourceSha256: 'source-b' });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('compiled-source-b');
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
  });

  it('refuses cache mutations inside project node_modules without removing anything', async () => {
    const { root } = fixture();
    const nativeModuleRoot = join(root, 'node_modules', 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    const unsafeCacheRoot = join(nativeModuleRoot, 'release-cache');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');

    await expect(captureReleaseBuildCache(root, 'web', {
      cacheRoot: unsafeCacheRoot,
      identity: identity('a'),
    })).rejects.toThrow(join(root, 'node_modules', 'better-sqlite3'));
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
    expect(existsSync(unsafeCacheRoot)).toBe(false);
  });

  it('refuses a restore destination redirected into project node_modules', async () => {
    const { root, cacheRoot } = fixture();
    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
    })).toMatchObject({ status: 'captured' });

    rmSync(join(root, '.next'), { recursive: true, force: true });
    const redirectedDestination = join(root, 'node_modules', 'cache');
    mkdirSync(redirectedDestination, { recursive: true });
    const destinationMarker = join(redirectedDestination, 'must-survive.txt');
    writeFileSync(destinationMarker, 'must-survive');
    symlinkSync(join(root, 'node_modules'), join(root, '.next'), 'dir');

    await expect(restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    })).rejects.toThrow(join(root, '.next', 'cache'));
    expect(readFileSync(destinationMarker, 'utf8')).toBe('must-survive');
  });

  it('refuses project node_modules symlinked outside the checkout', async () => {
    const { root } = fixture();
    const externalNodeModules = mkdtempSync(join(tmpdir(), 'o8-release-cache-node-modules-'));
    roots.push(externalNodeModules);
    const nativeModuleRoot = join(externalNodeModules, 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');
    symlinkSync(externalNodeModules, join(root, 'node_modules'), 'dir');

    await expect(captureReleaseBuildCache(root, 'web', {
      cacheRoot: join(root, 'node_modules', 'better-sqlite3', 'release-cache'),
      identity: identity('a'),
    })).rejects.toThrow(join(root, 'node_modules', 'better-sqlite3'));
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
  });

  it('rejects a corrupt cache without touching the cold-build destination', async () => {
    const { root, cacheRoot } = fixture();
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a') });
    const entryDir = join(cacheRoot, 'entries', 'web', 'compatibility-a');
    const archive = readdirSync(entryDir).find((name) => name.endsWith('.tar'));
    if (!archive) throw new Error('expected captured archive');
    writeFileSync(join(entryDir, archive), 'corrupt');
    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'cold-destination-preserved');

    const restored = await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    });
    expect(restored).toMatchObject({ status: 'miss', reason: 'archive_size_mismatch' });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('cold-destination-preserved');
  });

  it('never restores native bundles or exported server output as compiler cache', async () => {
    const { root, cacheRoot } = fixture();
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'deps'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'server'), { recursive: true });
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'deps', 'compiled.rlib'), 'compiler-intermediate');
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'signed-app'), 'final-bundle');
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'server', 'server.js'), 'exported-server');

    expect(await captureReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('a'),
    })).toMatchObject({ status: 'captured' });
    rmSync(join(root, 'src-tauri', 'target', 'release'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('b'),
    })).toMatchObject({ status: 'hit_compatible' });

    expect(readFileSync(join(root, 'src-tauri', 'target', 'release', 'deps', 'compiled.rlib'), 'utf8'))
      .toBe('compiler-intermediate');
    expect(() => readFileSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'signed-app')))
      .toThrow();
    expect(() => readFileSync(join(root, 'src-tauri', 'target', 'release', 'server', 'server.js')))
      .toThrow();
  });

  it('bypasses dirty source and records phase totals without local paths', async () => {
    const { root, cacheRoot } = fixture();
    const dirty = identity('dirty');
    dirty.source.worktreeClean = false;
    expect(await restoreReleaseBuildCache(root, 'web', { cacheRoot, identity: dirty }))
      .toMatchObject({ status: 'bypass', reason: 'dirty_worktree' });
    expect(await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: dirty }))
      .toMatchObject({ status: 'bypass', reason: 'dirty_worktree' });

    writeReleaseBuildCachePhaseReceipt(cacheRoot, 'run-a', {
      phase: 'web',
      restore: {
        phase: 'web',
        status: 'hit_compatible',
        reason: 'verified',
        archiveBytes: 4096,
        estimatedSavedMs: 42_000,
        durationMs: 20,
      },
      buildDurationMs: 100,
    });
    const finalized = finalizeReleaseBuildCacheReceipt(cacheRoot, 'run-a', {
      outcome: 'PASS',
      source: { head: 'head-b' },
      buildDurationMs: 200,
    });
    expect(finalized.receipt).toMatchObject({
      schema: 'o8/release-build-cache-receipt/v1',
      totals: { archiveBytesRestored: 4096, estimatedSavedMs: 42_000, hits: 1, misses: 0 },
    });
    expect(JSON.stringify(finalized.receipt)).not.toContain(root);
    expect(JSON.stringify(finalized.receipt)).not.toContain(cacheRoot);
  });
});
