import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { retainTestRunAfterTimeout } from '../../../tests/test-fixture-lifecycle';

import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import * as processIdentity from '@/lib/worktree/metadata-lock-process-identity';
import * as exactParent from './exact-parent-operation';
import { acquireDependencyCache, DEPENDENCY_CACHE_POLICY, pruneDependencyCaches } from './dependency-cache-retention';
import { deriveDependencyInstallRecipe, runDependencyInstall } from './dependency-install';

const keep = { ...DEPENDENCY_CACHE_POLICY };
const empty = { ...keep, maxBytes: 0, maxEntries: 0 };
const resolveVersion = async () => '11.8.0';

function makeWorkspace(root: string, name: string) {
  const workspace = path.join(root, name);
  mkdirSync(workspace);
  writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', packageManager: 'npm@11.8.0' }));
  writeFileSync(path.join(workspace, 'package-lock.json'), 'lock-v1');
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', ['add', '.'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: workspace });
  return workspace;
}

function fixture() {
  const runRoot = process.env.O8_TEST_RUN_DATA_ROOT;
  if (!runRoot) throw new Error('Cache acquisition fixtures need an owned test run root.');
  retainTestRunAfterTimeout(runRoot);
  const root = mkdtempSync(path.join(runRoot, 'o8-cache-creation-'));
  const cacheRoot = path.join(root, 'caches');
  mkdirSync(cacheRoot, { mode: 0o700 });
  return { root, cacheRoot, workspace: makeWorkspace(root, 'repo') };
}

function reservations(root: string) {
  return readdirSync(root).filter(name => name.startsWith('.o8-active-')).map(name => ({
    name, path: path.join(root, name), record: JSON.parse(readFileSync(path.join(root, name), 'utf8')),
  }));
}

// These small evidence fixtures remain owned by this suite for post-run inspection.
afterEach(() => vi.restoreAllMocks());

describe('dependency-cache identity at acquisition through real entry points', { timeout: 60_000 }, () => {
  it('publishes exact resource identity, owner birth evidence and retention before installer entry', async () => {
    const { cacheRoot, workspace } = fixture();
    const before = Date.now();
    let cache = '';
    await runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, resolveVersion,
      run: async invocation => {
        cache = invocation.env.npm_config_cache!;
        const root = path.dirname(cache);
        const leases = reservations(root);
        expect(leases).toHaveLength(1);
        const lease = leases[0]!;
        const rootStat = lstatSync(root);
        const cacheStat = lstatSync(cache);
        const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci', { resolveVersion });
        expect(lease.name).toBe(`.o8-active-${lease.record.leaseId}`);
        expect(lease.record).toMatchObject({
          schema: 'o8/dependency-cache-reservation/v1', key: recipe.key, manager: 'npm',
          cacheAuthorityId: recipe.cacheAuthorityId, pid: process.pid,
          identity: { device: rootStat.dev, inode: rootStat.ino },
          cacheIdentity: { device: cacheStat.dev, inode: cacheStat.ino },
          retentionState: 'active-or-unresolved-installer',
        });
        expect(lease.record.ownerProcess).toEqual(await probeMetadataLockProcessIdentity(process.pid));
        expect(['live', 'unknown']).toContain(lease.record.ownerProcess.state);
        expect(lease.record.acquiredAt).toBeGreaterThanOrEqual(before);
        expect(lease.record.acquiredAt).toBeLessThanOrEqual(Date.now());
        expect(lstatSync(lease.path).nlink).toBe(1);
        if (process.platform !== 'win32') expect(lstatSync(lease.path).mode & 0o777).toBe(0o600);
        expect(existsSync(path.join(root, '.o8-cache.json'))).toBe(false);
        writeFileSync(path.join(root, 'acquisition-observation.json'), JSON.stringify(lease.record));
        mkdirSync(path.join(workspace, 'node_modules'));
        writeFileSync(path.join(workspace, 'node_modules', 'fixture.js'), 'private dependency');
      },
    });
    expect(reservations(path.dirname(cache))).toEqual([]);
    const completed = JSON.parse(readFileSync(path.join(path.dirname(cache), '.o8-cache.json'), 'utf8'));
    expect(completed.schema).toBe('o8/managed-dependency-cache/v1');
    expect(completed.lastUsedAt).toBeGreaterThanOrEqual(before);
    expect(completed.allocatedBytes).toBeTypeOf('number');
  });

  it('gives concurrent acquisitions distinct durable leases and holds until the last safe release', async () => {
    const { cacheRoot, workspace } = fixture();
    const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci', { resolveVersion });
    const [first, second] = await Promise.all([
      acquireDependencyCache(cacheRoot, recipe, empty), acquireDependencyCache(cacheRoot, recipe, empty),
    ]);
    expect(first.root).toBe(second.root);
    const leases = reservations(first.root);
    expect(leases).toHaveLength(2);
    expect(new Set(leases.map(lease => lease.record.leaseId)).size).toBe(2);
    expect(leases[0]!.record.identity).toEqual(leases[1]!.record.identity);
    expect(leases[0]!.record.cacheIdentity).toEqual(leases[1]!.record.cacheIdentity);
    const partial = await first.release();
    expect(partial.status).toBe('held');
    expect(partial.held[0]?.reason).toBe('active-or-unresolved-installer');
    expect(reservations(first.root)).toHaveLength(1);
    expect(existsSync(path.join(first.root, '.o8-cache.json'))).toBe(false);
    const completed = await second.release();
    expect(completed.status).toBe('within-budget');
    expect(completed.removed).toEqual([`npm/${recipe.key}`]);
    expect(existsSync(first.root)).toBe(false);
  });

  it('keeps an interrupted reservation and ignores recorded owner death or age as cleanup authority', async () => {
    const { cacheRoot, workspace } = fixture();
    let cache = '';
    await expect(runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => { cache = invocation.env.npm_config_cache!; throw new Error('installer interrupted'); },
    })).rejects.toThrow('installer interrupted');
    const root = path.dirname(cache);
    const lease = reservations(root)[0]!;
    expect(lease.record.retentionState).toBe('active-or-unresolved-installer');
    expect(lease.record.cacheIdentity.inode).toBe(lstatSync(cache).ino);
    // Deliberately stale fixture evidence must never turn an unresolved lease into deletion authority.
    lease.record.pid = 2_000_000_000;
    lease.record.ownerProcess = { state: 'absent' };
    lease.record.acquiredAt = 0;
    writeFileSync(lease.path, JSON.stringify(lease.record));
    const bytes = readFileSync(lease.path);
    const receipt = await pruneDependencyCaches(cacheRoot, empty);
    expect(receipt).toMatchObject({ status: 'held', retainedBytes: null, removed: [] });
    expect(receipt.held).toEqual([{ entry: `npm/${lease.record.key}`, reason: 'active-or-unresolved-installer' }]);
    expect(readFileSync(lease.path)).toEqual(bytes);
    expect(existsSync(cache)).toBe(true);
  });

  it('records unknown owner evidence before installer entry without granting cleanup authority', async () => {
    const { cacheRoot, workspace } = fixture();
    const probe = processIdentity.probeMetadataLockProcessIdentity;
    const unknown = { state: 'unknown', detail: 'fixture identity probe unavailable' } as const;
    vi.spyOn(processIdentity, 'probeMetadataLockProcessIdentity').mockImplementation(pid => (
      pid === process.pid ? Promise.resolve(unknown) : probe(pid)
    ));
    let cache = '';
    await expect(runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => {
        cache = invocation.env.npm_config_cache!;
        expect(reservations(path.dirname(cache))[0]!.record.ownerProcess).toEqual(unknown);
        throw new Error('installer interrupted with unknown owner');
      },
    })).rejects.toThrow('installer interrupted with unknown owner');
    const lease = reservations(path.dirname(cache))[0]!;
    const bytes = readFileSync(lease.path);
    const receipt = await pruneDependencyCaches(cacheRoot, empty);
    expect(receipt).toMatchObject({ status: 'held', removed: [], retainedBytes: null });
    expect(readFileSync(lease.path)).toEqual(bytes);
    expect(existsSync(cache)).toBe(true);
  });

  it('refuses a replaced cache leaf before invoking the installer and retains its published lease', async () => {
    const { cacheRoot, workspace } = fixture();
    const write = exactParent.writeExactChildFile;
    let root = '';
    let saved = '';
    vi.spyOn(exactParent, 'writeExactChildFile').mockImplementation(async (...args) => {
      await write(...args);
      if (!path.basename(args[2]).startsWith('.o8-active-')) return;
      root = args[0];
      const cache = path.join(root, 'cache');
      saved = path.join(root, 'cache-saved');
      renameSync(cache, saved);
      mkdirSync(cache, { mode: 0o700 });
      writeFileSync(path.join(cache, 'foreign'), 'replacement bytes');
    });
    const installer = vi.fn();
    await expect(runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, resolveVersion, run: installer,
    })).rejects.toThrow('ownership changed');
    expect(installer).not.toHaveBeenCalled();
    const lease = reservations(root)[0]!;
    expect(lease.record.cacheIdentity.inode).toBe(lstatSync(saved).ino);
    const bytes = readFileSync(lease.path);
    const receipt = await pruneDependencyCaches(cacheRoot, empty);
    expect(receipt).toMatchObject({ status: 'held', removed: [] });
    expect(readFileSync(lease.path)).toEqual(bytes);
    expect(readFileSync(path.join(root, 'cache', 'foreign'), 'utf8')).toBe('replacement bytes');
  });

  it('exposes two reservations to simultaneous installer callbacks until both have returned', async () => {
    const { root, cacheRoot, workspace } = fixture();
    const secondWorkspace = makeWorkspace(root, 'second');
    const events: Array<{ event: string; at: number }> = [];
    const record = (event: string) => {
      events.push({ event, at: Date.now() });
      writeFileSync(path.join(root, 'installer-events.json'), JSON.stringify(events));
    };
    let startFirst!: () => void;
    let startSecond!: () => void;
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstStarted = new Promise<void>(resolve => { startFirst = resolve; });
    const secondStarted = new Promise<void>(resolve => { startSecond = resolve; });
    const firstFinish = new Promise<void>(resolve => { finishFirst = resolve; });
    const secondFinish = new Promise<void>(resolve => { finishSecond = resolve; });
    let cache = '';
    const first = runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => {
        cache = invocation.env.npm_config_cache!;
        mkdirSync(path.join(workspace, 'node_modules'));
        record('first-installer-entered');
        startFirst();
        await firstFinish;
        record('first-installer-returned');
      },
    });
    await Promise.race([firstStarted, first]);
    const second = runDependencyInstall(secondWorkspace, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => {
        expect(invocation.env.npm_config_cache).toBe(cache);
        expect(reservations(path.dirname(cache))).toHaveLength(2);
        mkdirSync(path.join(secondWorkspace, 'node_modules'));
        record('second-installer-entered');
        startSecond();
        await secondFinish;
        record('second-installer-returned');
      },
    });
    try {
      await Promise.race([secondStarted, second]);
      finishFirst();
      const partial = await first;
      record('first-install-completed-with-second-lease-held');
      expect(partial.cacheRetention?.status).toBe('held');
      expect(reservations(path.dirname(cache))).toHaveLength(1);
      expect(existsSync(cache)).toBe(true);
    } finally {
      finishFirst();
      finishSecond();
      await Promise.allSettled([first, second]);
    }
    const completed = await second;
    record('second-install-completed-and-cache-retired');
    expect(completed.cacheRetention?.status).toBe('within-budget');
    expect(existsSync(cache)).toBe(false);
  }, 150_000);

  it('refuses a cache leaf replaced by a successful installer and preserves the reservation and foreign bytes', async () => {
    const { cacheRoot, workspace } = fixture();
    let root = '';
    let saved = '';
    let leaseName = '';
    let leaseBytes: Buffer = Buffer.alloc(0);
    await expect(runDependencyInstall(workspace, 'npm ci', {
      cacheRoot, cachePolicy: empty, resolveVersion,
      run: async invocation => {
        const cache = invocation.env.npm_config_cache!;
        root = path.dirname(cache);
        const lease = reservations(root)[0]!;
        leaseName = lease.name;
        leaseBytes = readFileSync(lease.path);
        saved = path.join(root, 'cache-saved');
        renameSync(cache, saved);
        mkdirSync(cache, { mode: 0o700 });
        writeFileSync(path.join(cache, 'foreign'), 'replacement bytes after installer entry');
        mkdirSync(path.join(workspace, 'node_modules'));
      },
    })).rejects.toThrow('ownership changed');
    expect(readFileSync(path.join(root, leaseName))).toEqual(leaseBytes);
    expect(reservations(root)[0]!.record.cacheIdentity.inode).toBe(lstatSync(saved).ino);
    expect(existsSync(path.join(root, '.o8-cache.json'))).toBe(false);
    const receipt = await pruneDependencyCaches(cacheRoot, empty);
    expect(receipt).toMatchObject({ status: 'held', removed: [] });
    expect(readFileSync(path.join(root, leaseName))).toEqual(leaseBytes);
    expect(readFileSync(path.join(root, 'cache', 'foreign'), 'utf8')).toBe('replacement bytes after installer entry');
    expect(existsSync(saved)).toBe(true);
  });

  it('refuses release after recipe-root replacement and preserves both original lease and foreign bytes', async () => {
    const { cacheRoot, workspace } = fixture();
    const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci', { resolveVersion });
    const acquired = await acquireDependencyCache(cacheRoot, recipe, empty);
    const lease = reservations(acquired.root)[0]!;
    const bytes = readFileSync(lease.path);
    const original = `${acquired.root}-saved`;
    renameSync(acquired.root, original);
    mkdirSync(acquired.root, { mode: 0o700 });
    writeFileSync(path.join(acquired.root, 'foreign'), 'foreign bytes');
    await expect(acquired.release()).rejects.toThrow('ownership changed');
    expect(readFileSync(path.join(original, lease.name))).toEqual(bytes);
    expect(readFileSync(path.join(acquired.root, 'foreign'), 'utf8')).toBe('foreign bytes');
  });

  it('keeps lifecycle-store binding refusal before adding another profile reservation', async () => {
    const { root, cacheRoot, workspace } = fixture();
    const recipe = await deriveDependencyInstallRecipe(workspace, 'npm ci', { resolveVersion });
    const acquired = await acquireDependencyCache(cacheRoot, recipe);
    await acquired.release();
    const recordPath = path.join(acquired.root, '.o8-cache.json');
    const bytes = readFileSync(recordPath);
    const previous = process.env.CORTEX_IDE_DB_PATH;
    const otherDatabase = path.join(root, 'other-profile.db');
    writeFileSync(otherDatabase, '');
    process.env.CORTEX_IDE_DB_PATH = otherDatabase;
    try {
      await expect(acquireDependencyCache(cacheRoot, recipe)).rejects.toThrow('different or unproved lifecycle store');
      expect(reservations(acquired.root)).toEqual([]);
      expect(readFileSync(recordPath)).toEqual(bytes);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_IDE_DB_PATH;
      else process.env.CORTEX_IDE_DB_PATH = previous;
    }
  });
});
