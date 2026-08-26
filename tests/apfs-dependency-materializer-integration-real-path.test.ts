import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTsxProcess } from '@/lib/testing/tsx-process';

const execFileAsync = promisify(execFile);
const childPath = path.join(
  process.cwd(),
  'tests/fixtures/apfs-dependency-materializer-child.ts',
);
let root = '';
let dataDir = '';
let worktreeRoot = '';
const cleanupTargets: Array<{ worktreeId: string; workspacePath: string; leaseId?: string }> = [];
let packageServer: ChildProcess | null = null;
let repoPath = '';

interface MaterializationReceipt {
  mode: 'native' | 'image';
  recipeKey: string;
  leaseId: string | null;
  generation: string | null;
  workspaceDevice: number;
  workspaceInode: number;
}

interface CreateResult {
  status: number;
  body?: unknown;
  repoId?: string;
  laneId?: string;
  image?: { state: string; imagePath: string; generation: string } | null;
  worktree?: { id: string; path: string; branch: string } | null;
  receipt?: MaterializationReceipt | null;
  lease?: {
    leaseId: string;
    state: string;
    recipeKey: string;
    generation: string;
    workspacePath: string;
    mountPath: string;
    deviceEntry: string;
  } | null;
  liveDevice?: {
    deviceEntry: string;
    mountPath: string | null;
    shadowPath: string | null;
    helperPid: number | null;
    writable: boolean;
  } | null;
}

interface LifecycleResult {
  status: number;
  body: Record<string, unknown>;
  pathExists: boolean;
  priorLease: unknown;
  relatedLiveDevices: unknown[];
  evidence?: CreateResult | null;
}

interface RemovalResult {
  status: number;
  body: Record<string, unknown>;
  pathExists: boolean;
  lease: unknown;
}

interface RollbackResult extends CreateResult {
  result?: { status: string; code?: string; note?: string };
  removed?: boolean;
  quarantine?: { state: string; originalExists: boolean; quarantineExists: boolean } | null;
  pathExists: boolean;
  nodeModulesUsable: boolean;
  oldLease: unknown;
  oldShadowExists: boolean | null;
  workspaceLeases: Array<{
    leaseId: string;
    state: string;
    recipeKey: string;
    generation: string;
    workspacePath: string;
  }>;
  workspaceDevices: Array<{ deviceEntry: string; mountPath: string | null }>;
  oldShadowLiveDevices: unknown[];
  exactClaims?: unknown[];
}

interface RestartRootSwapResult {
  reconciliation: {
    adopted: number;
    detachedUnowned: number;
    unavailable: number;
    blocked: number;
    complete: boolean;
  };
  workspaceReconciliationRan: boolean;
  workspaceReconciliation: unknown[] | null;
  events: string[];
  receipt: MaterializationReceipt | null;
  replacementBefore: { device: number; inode: number };
  replacementAfter: { device: number; inode: number };
  replacementContents: string;
  replacementDependencyContents: string;
  originalPath: string;
  originalExists: boolean;
  oldLease: unknown;
  oldShadowExists: boolean;
  relatedLiveDevices: unknown[];
}

interface StartupCreateResult {
  startup: {
    publications: {
      inspected: number;
      ready: number;
      retired: number;
      blocked: number;
      complete: boolean;
    };
    materializations: { complete: boolean };
    complete: boolean;
  };
  create: CreateResult;
}

interface StartupAttachReconcileResult {
  startup: StartupCreateResult['startup'];
  lease: unknown;
  action: unknown;
  targets: unknown[];
  relatedDevices: unknown[];
  relatedMounts: unknown[];
  shadowExists: boolean;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function startPackageServer(tarballPath: string): Promise<number> {
  const script = `
    const http = require('node:http');
    const fs = require('node:fs');
    const bytes = fs.readFileSync(${JSON.stringify(tarballPath)});
    const server = http.createServer((request, response) => {
      if (request.url !== '/fixture-package-1.0.0.tgz') {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
      });
      response.end(bytes);
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port) + '\\n');
    });
  `;
  packageServer = spawn(process.execPath, ['--eval', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise<number>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    packageServer!.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split('\n')[0]?.trim();
      if (line && /^\d+$/.test(line)) resolve(Number(line));
    });
    packageServer!.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    packageServer!.once('error', reject);
    packageServer!.once('exit', (code) => {
      if (!stdout.trim()) reject(new Error(`Package server exited ${code}: ${stderr}`));
    });
  });
}

function materializerChildEnv(input: Record<string, unknown>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), '--conditions=react-server']
      .filter(Boolean)
      .join(' '),
    O8_DATA_DIR: dataDir,
    CORTEX_IDE_DATA_DIR: dataDir,
    O8_WORKTREE_ROOT: worktreeRoot,
    O8_SKIP_PRELAUNCH_TYPECHECK: '1',
    O8_STORAGE_RESERVE_RATIO: '0.000001',
    O8_STORAGE_RESERVE_FLOOR_GB: '0.001',
    O8_APFS_DEPENDENCY_IMAGES: '1',
    O8_APFS_MATERIALIZER_INPUT: JSON.stringify({ repoPath, dataDir, ...input }),
  };
}

async function runChild<T>(input: Record<string, unknown>): Promise<T> {
  const command = resolveTsxProcess([childPath]);
  const { stdout, stderr } = await execFileAsync(
    command.file,
    command.args,
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      env: materializerChildEnv(input),
    },
  );
  const line = stdout.split('\n')
    .find((entry) => entry.startsWith('O8_APFS_MATERIALIZER_RESULT '));
  if (!line) throw new Error(`Materializer child returned no receipt: ${stderr}\n${stdout}`);
  return JSON.parse(line.slice('O8_APFS_MATERIALIZER_RESULT '.length)) as T;
}

function track(result: CreateResult): void {
  if (!result.worktree) return;
  cleanupTargets.push({
    worktreeId: result.worktree.id,
    workspacePath: result.worktree.path,
    leaseId: result.receipt?.leaseId ?? undefined,
  });
}

async function cleanup(result: CreateResult): Promise<RemovalResult> {
  if (!result.worktree) throw new Error('Cleanup target was not created.');
  const removed = await runChild<RemovalResult>({
    action: 'cleanup',
    worktreeId: result.worktree.id,
    workspacePath: result.worktree.path,
    leaseId: result.receipt?.leaseId,
  });
  const tracked = cleanupTargets.find((entry) => entry.worktreeId === result.worktree!.id);
  if (tracked) cleanupTargets.splice(cleanupTargets.indexOf(tracked), 1);
  return removed;
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'o8-apfs-materializer-integration-'));
  dataDir = path.join(root, 'data');
  worktreeRoot = path.join(root, 'worktrees');
  mkdirSync(dataDir);
  mkdirSync(worktreeRoot);
  const packageRoot = path.join(root, 'package');
  mkdirSync(packageRoot);
  writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify({
    name: 'fixture-package',
    version: '1.0.0',
    main: 'index.js',
  })}\n`);
  writeFileSync(path.join(packageRoot, 'index.js'), 'module.exports = "sealed fixture";\n');
  const tarballName = execFileSync(
    'npm',
    ['pack', '--silent', '--pack-destination', root],
    { cwd: packageRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1)!;
  const packagePort = await startPackageServer(path.join(root, tarballName));

  repoPath = path.join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.name', 'o8 test');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  writeFileSync(path.join(repoPath, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repoPath, 'package.json'), `${JSON.stringify({
    name: 'apfs-materializer-fixture',
    version: '1.0.0',
    private: true,
    dependencies: {
      'fixture-package': `http://127.0.0.1:${packagePort}/fixture-package-1.0.0.tgz`,
    },
  })}\n`);
  execFileSync(
    'npm',
    ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: repoPath, stdio: 'ignore' },
  );
  git(repoPath, 'add', '.gitignore', 'package.json', 'package-lock.json');
  git(repoPath, 'commit', '-qm', 'fixture');
}, 30_000);

function attributableDevices(roots: string[]): { bases: string[]; leaves: string[] } {
  const bases: string[] = [];
  const leaves: string[] = [];
  const info = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
  for (const block of info.split('================================================')) {
    if (!roots.some((entry) => block.includes(entry))) continue;
    const devices = block.split('\n')
      .map((line) => line.split('\t'))
      .filter((columns) => /^\/dev\/disk\d+(s\d+)?$/.test(columns[0]?.trim() ?? ''))
      .map((columns) => ({
        deviceEntry: columns[0]!.trim(),
        mountPath: (columns[2] ?? '').trim(),
      }));
    // The first device in an hdiutil block is the attached image itself. Never detach
    // the synthesized APFS container that follows it.
    if (devices[0]) bases.push(devices[0].deviceEntry);
    for (const device of devices) {
      if (device.mountPath) leaves.push(device.deviceEntry);
    }
  }
  return { bases: [...new Set(bases)], leaves: [...new Set(leaves)] };
}

function releaseAttributableDevices(roots: string[]): string[] {
  const released: string[] = [];
  const { bases, leaves } = attributableDevices(roots);
  for (const leaf of leaves) {
    try {
      execFileSync('/sbin/umount', [leaf], { stdio: 'ignore' });
      released.push(leaf);
    } catch { /* Detaching the base below is the second chance. */ }
  }
  for (const base of bases) {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', base], { stdio: 'ignore' });
      released.push(base);
    } catch {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', base, '-force'], { stdio: 'ignore' });
        released.push(base);
      } catch { /* Reported as retained residue below. */ }
    }
  }
  return released;
}

afterEach(async () => {
  for (const target of cleanupTargets.splice(0)) {
    await runChild({ action: 'cleanup', ...target }).catch(() => undefined);
  }
  packageServer?.kill('SIGTERM');
  packageServer = null;
  const canonicalRoot = root.startsWith('/var/') ? `/private${root}` : root;
  const roots = [root, canonicalRoot];
  const retained = () => {
    const diskImages = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
    const mounts = execFileSync('/sbin/mount', [], { encoding: 'utf8' });
    return roots.some((entry) => diskImages.includes(entry) || mounts.includes(entry));
  };
  // A failing test must never leave a live APFS mount or attached image behind, so
  // release anything attributable to this fixture root before reporting the leak.
  const retainedBefore = retained();
  const released = retainedBefore ? releaseAttributableDevices(roots) : [];
  const stillRetained = retainedBefore && retained();
  if (existsSync(root) && !stillRetained) rmSync(root, { recursive: true, force: true });
  if (retainedBefore) {
    throw new Error(stillRetained
      ? `APFS materializer fixture retained an attributable device after releasing ${released.join(', ') || 'nothing'}; preserved ${root}`
      : `APFS materializer fixture retained an attributable device; released ${released.join(', ')}`);
  }
});

describe.skipIf(process.platform !== 'darwin')(
  'APFS dependency materializer through production workspace entries',
  () => {
    it('cleans an attach crash before its receipt during startup reconciliation', async () => {
      const seed = await runChild<CreateResult>({
        action: 'create',
        taskName: 'startup attach crash seed',
      });
      track(seed);
      expect(seed.receipt?.mode).toBe('native');
      expect(seed.image).toMatchObject({ state: 'ready' });
      expect((await cleanup(seed)).status).toBe(200);

      const workspacePath = path.join(root, 'attach-crash-workspace');
      const markerPath = path.join(root, 'attach-crash-marker.json');
      const crashChild = spawn(
        process.execPath,
        ['--import=tsx', childPath],
        {
          cwd: process.cwd(),
          env: materializerChildEnv({
            action: 'attach-crash-before-receipt',
            workspacePath,
            recipeKey: seed.receipt!.recipeKey,
            markerPath,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let crashStdout = '';
      let crashStderr = '';
      crashChild.stdout!.on('data', (chunk: Buffer) => {
        crashStdout += chunk.toString('utf8');
      });
      crashChild.stderr!.on('data', (chunk: Buffer) => {
        crashStderr += chunk.toString('utf8');
      });
      for (let attempt = 0; attempt < 1_200 && !existsSync(markerPath); attempt += 1) {
        if (crashChild.exitCode !== null) {
          throw new Error(
            `Attach child exited before its crash boundary: ${crashStderr}\n${crashStdout}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(markerPath), crashStderr).toBe(true);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { leaseId: string };
      const crashExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          crashChild.once('error', reject);
          crashChild.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      expect(crashChild.kill('SIGKILL')).toBe(true);
      await expect(crashExit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

      const restarted = await runChild<StartupAttachReconcileResult>({
        action: 'startup-attach-reconcile',
        leaseId: marker.leaseId,
        workspacePath,
        markerPath,
      });
      expect(restarted.startup.complete, JSON.stringify(restarted.startup)).toBe(true);
      expect(restarted.lease).toBeNull();
      expect(restarted.action).toBeNull();
      expect(restarted.targets).toEqual([]);
      expect(restarted.relatedDevices).toEqual([]);
      expect(restarted.relatedMounts).toEqual([]);
      expect(restarted.shadowExists).toBe(false);
    }, 240_000);

    it('recovers a killed background publisher at startup before the next manager create', async () => {
      const markerPath = path.join(root, 'publication-staged-before-record');
      const crashChild = spawn(
        process.execPath,
        ['--import=tsx', childPath],
        {
          cwd: process.cwd(),
          env: {
            ...materializerChildEnv({
              action: 'create',
              taskName: 'startup publication crash seed',
            }),
            O8_TEST_DEPENDENCY_IMAGE_BEFORE_RECORD_MARKER: markerPath,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let crashStdout = '';
      let crashStderr = '';
      crashChild.stdout!.on('data', (chunk: Buffer) => { crashStdout += chunk.toString('utf8'); });
      crashChild.stderr!.on('data', (chunk: Buffer) => { crashStderr += chunk.toString('utf8'); });
      for (let attempt = 0; attempt < 1_200 && !existsSync(markerPath); attempt += 1) {
        if (crashChild.exitCode !== null) {
          throw new Error(`Publisher exited before its crash boundary: ${crashStderr}\n${crashStdout}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(existsSync(markerPath), crashStderr).toBe(true);
      const stagingRoot = path.join(dataDir, 'dependency-images', 'staging');
      const stagingDirectories = readdirSync(stagingRoot);
      expect(stagingDirectories).toHaveLength(1);
      expect(readdirSync(path.join(stagingRoot, stagingDirectories[0]!)).sort()).toEqual([
        'image.dmg',
        'image.dmg.manifest.json',
      ]);
      const crashExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          crashChild.once('error', reject);
          crashChild.once('exit', (code, signal) => resolve({ code, signal }));
        },
      );
      expect(crashChild.kill('SIGKILL')).toBe(true);
      await expect(crashExit).resolves.toEqual({ code: null, signal: 'SIGKILL' });

      const restarted = await runChild<StartupCreateResult>({
        action: 'startup-create',
        taskName: 'startup publication recovered consumer',
      });
      track(restarted.create);
      expect(
        restarted.startup.publications,
        JSON.stringify(restarted.startup.publications),
      ).toMatchObject({
        inspected: 1,
        ready: 1,
        retired: 0,
        blocked: 0,
        complete: true,
      });
      expect(restarted.startup.complete).toBe(true);
      expect(restarted.create.status).toBe(201);
      expect(restarted.create.receipt).toMatchObject({ mode: 'image', status: 'mounted' });
      expect(restarted.create.image).toBeNull();
      expect((await cleanup(restarted.create)).status).toBe(200);
    }, 240_000);

    it('clears and exact-detaches a root-swapped lease before workspace restart reconciliation', async () => {
      const first = await runChild<CreateResult>({ action: 'create', taskName: 'root swap seed' });
      track(first);
      expect(first.receipt?.mode).toBe('native');
      expect(first.image).toMatchObject({ state: 'ready' });

      const mounted = await runChild<CreateResult>({
        action: 'create',
        taskName: 'root swap mounted',
      });
      track(mounted);
      expect(mounted.receipt?.mode).toBe('image');
      expect(mounted.lease).toMatchObject({ state: 'mounted' });
      const restarted = await runChild<RestartRootSwapResult>({
        action: 'restart-root-swap',
        worktreeId: mounted.worktree!.id,
        workspacePath: mounted.worktree!.path,
        leaseId: mounted.receipt!.leaseId,
      });
      cleanupTargets.splice(
        cleanupTargets.findIndex((entry) => entry.worktreeId === mounted.worktree!.id),
        1,
      );

      expect(restarted.reconciliation).toMatchObject({
        adopted: 0,
        detachedUnowned: 1,
        unavailable: 1,
        blocked: 0,
        complete: true,
      });
      expect(restarted.events).toEqual(['metadata-cleared']);
      expect(restarted.workspaceReconciliationRan).toBe(true);
      expect(restarted.workspaceReconciliation).toEqual([]);
      expect(restarted.receipt).toBeNull();
      expect(restarted.replacementAfter).toEqual(restarted.replacementBefore);
      expect(restarted.replacementContents).toBe('preserve replacement root\n');
      expect(restarted.replacementDependencyContents)
        .toBe('preserve replacement dependencies\n');
      expect(restarted.originalExists).toBe(true);
      expect(restarted.oldLease).toBeNull();
      expect(restarted.oldShadowExists).toBe(false);
      expect(restarted.relatedLiveDevices).toEqual([]);
      expect((await cleanup(first)).status).toBe(200);
    }, 180_000);

    it('creates natively, publishes, mounts, parks, restores, replaces, prunes, and refuses poison', async () => {
      const first = await runChild<CreateResult>({ action: 'create', taskName: 'image first' });
      track(first);
      expect(first.status).toBe(201);
      expect(first.receipt).toMatchObject({
        mode: 'native',
        leaseId: null,
        generation: null,
      });
      expect(first.receipt?.recipeKey).toMatch(/^[0-9a-f]{64}$/);
      expect(first.image).toMatchObject({ state: 'ready' });
      expect(first.image?.generation).toMatch(/^[0-9a-f-]{36}$/);
      const firstRoot = lstatSync(first.worktree!.path);
      expect(first.receipt).toMatchObject({
        workspaceDevice: firstRoot.dev,
        workspaceInode: firstRoot.ino,
      });

      const packetId = 'apfs-materializer-packet';
      const surfaceId = 'apfs-materializer-owned:session';
      const second = await runChild<CreateResult>({
        action: 'create',
        taskName: 'image second',
        packetId,
        surfaceId,
      });
      track(second);
      expect(second.status).toBe(201);
      expect(second.receipt).toMatchObject({
        mode: 'image',
        recipeKey: first.receipt?.recipeKey,
        generation: first.image?.generation,
      });
      expect(second.receipt?.leaseId).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.lease).toMatchObject({
        leaseId: second.receipt?.leaseId,
        state: 'mounted',
        workspacePath: second.worktree?.path,
        mountPath: path.join(second.worktree!.path, 'node_modules'),
      });
      expect(second.liveDevice).toMatchObject({
        deviceEntry: second.lease?.deviceEntry,
        mountPath: path.join(second.worktree!.path, 'node_modules'),
        writable: true,
      });
      expect(second.liveDevice?.helperPid).toBeGreaterThan(0);

      const lifecycleBase = {
        packetId,
        surfaceId,
        repoId: second.repoId,
        laneId: second.laneId,
        worktreeId: second.worktree!.id,
        workspacePath: second.worktree!.path,
      };
      const parkRefusal = await runChild<RollbackResult>({
        action: 'park-refusal',
        ...lifecycleBase,
        leaseId: second.receipt!.leaseId,
      });
      expect(parkRefusal.result).toMatchObject({ status: 'refused', code: 'park_refused' });
      expect(parkRefusal.pathExists).toBe(true);
      expect(parkRefusal.nodeModulesUsable).toBe(true);
      expect(parkRefusal.oldLease).toBeNull();
      expect(parkRefusal.oldShadowExists).toBe(false);
      expect(parkRefusal.receipt).toMatchObject({
        mode: 'image',
        status: 'mounted',
        recipeKey: second.receipt!.recipeKey,
        generation: second.receipt!.generation,
        workspaceDevice: second.receipt!.workspaceDevice,
        workspaceInode: second.receipt!.workspaceInode,
      });
      expect(parkRefusal.receipt?.leaseId).not.toBe(second.receipt!.leaseId);
      expect(parkRefusal.lease).toMatchObject({
        leaseId: parkRefusal.receipt?.leaseId,
        state: 'mounted',
      });
      expect(parkRefusal.workspaceLeases).toHaveLength(1);
      expect(parkRefusal.workspaceLeases[0]?.leaseId).toBe(parkRefusal.receipt?.leaseId);
      expect(parkRefusal.workspaceDevices).toHaveLength(1);
      expect(parkRefusal.workspaceDevices[0]?.deviceEntry).toBe(parkRefusal.lease?.deviceEntry);
      expect(parkRefusal.oldShadowLiveDevices).toEqual([]);
      expect(parkRefusal.quarantine).toMatchObject({
        state: 'clear',
        originalExists: true,
        quarantineExists: false,
      });
      second.receipt = parkRefusal.receipt;

      const lifecycleInput = {
        ...lifecycleBase,
        leaseId: second.receipt!.leaseId,
      };
      const parked = await runChild<LifecycleResult>({ action: 'park', ...lifecycleInput });
      expect(parked.status, JSON.stringify(parked.body)).toBe(200);
      expect(parked.pathExists).toBe(false);
      expect(parked.priorLease).toBeNull();
      expect(parked.relatedLiveDevices).toEqual([]);

      const restored = await runChild<LifecycleResult>({ action: 'restore', ...lifecycleInput });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.pathExists).toBe(true);
      expect(restored.evidence?.receipt).toMatchObject({
        mode: 'image',
        recipeKey: first.receipt?.recipeKey,
        generation: first.image?.generation,
      });
      expect(restored.evidence?.receipt?.leaseId).not.toBe(second.receipt?.leaseId);
      expect(restored.evidence?.lease).toMatchObject({ state: 'mounted' });
      expect(restored.evidence?.liveDevice?.deviceEntry)
        .toBe(restored.evidence?.lease?.deviceEntry);
      second.receipt = restored.evidence!.receipt;

      const cleaned = await cleanup(second);
      expect(cleaned.status, JSON.stringify(cleaned.body)).toBe(200);
      expect(cleaned.pathExists).toBe(false);
      expect(cleaned.lease).toBeNull();

      const replacement = await runChild<CreateResult>({
        action: 'create',
        taskName: 'image branch replacement',
        branchName: second.worktree!.branch,
      });
      track(replacement);
      expect(replacement.status).toBe(201);
      expect(replacement.receipt).toMatchObject({
        mode: 'image',
        recipeKey: first.receipt?.recipeKey,
      });
      expect(replacement.worktree?.branch).toBe(second.worktree?.branch);
      expect((await cleanup(replacement)).lease).toBeNull();

      const cleanupRollback = await runChild<CreateResult>({
        action: 'create',
        taskName: 'image cleanup rollback',
        packetId: 'apfs-materializer-cleanup-rollback-packet',
        surfaceId: 'apfs-materializer-owned:cleanup-rollback',
      });
      track(cleanupRollback);
      expect(cleanupRollback.receipt?.mode).toBe('image');
      const cleanupRefusal = await runChild<RollbackResult>({
        action: 'cleanup-refusal',
        worktreeId: cleanupRollback.worktree!.id,
        workspacePath: cleanupRollback.worktree!.path,
        leaseId: cleanupRollback.receipt!.leaseId,
      });
      expect(cleanupRefusal.removed).toBe(false);
      expect(cleanupRefusal.pathExists).toBe(true);
      expect(cleanupRefusal.nodeModulesUsable).toBe(true);
      expect(cleanupRefusal.oldLease).toBeNull();
      expect(cleanupRefusal.oldShadowExists).toBe(false);
      expect(cleanupRefusal.receipt).toMatchObject({
        mode: 'image',
        status: 'mounted',
        recipeKey: cleanupRollback.receipt!.recipeKey,
        generation: cleanupRollback.receipt!.generation,
        workspaceDevice: cleanupRollback.receipt!.workspaceDevice,
        workspaceInode: cleanupRollback.receipt!.workspaceInode,
      });
      expect(cleanupRefusal.receipt?.leaseId).not.toBe(cleanupRollback.receipt!.leaseId);
      expect(cleanupRefusal.lease).toMatchObject({
        leaseId: cleanupRefusal.receipt?.leaseId,
        state: 'mounted',
      });
      expect(cleanupRefusal.workspaceLeases).toHaveLength(1);
      expect(cleanupRefusal.workspaceLeases[0]?.leaseId).toBe(cleanupRefusal.receipt?.leaseId);
      expect(cleanupRefusal.workspaceDevices).toHaveLength(1);
      expect(cleanupRefusal.workspaceDevices[0]?.deviceEntry)
        .toBe(cleanupRefusal.lease?.deviceEntry);
      expect(cleanupRefusal.oldShadowLiveDevices).toEqual([]);
      expect(cleanupRefusal.exactClaims).toEqual([]);
      cleanupRollback.receipt = cleanupRefusal.receipt;
      expect((await cleanup(cleanupRollback)).lease).toBeNull();

      const pruneTarget = await runChild<CreateResult>({
        action: 'create',
        taskName: 'image prune target',
      });
      track(pruneTarget);
      expect(pruneTarget.receipt?.mode).toBe('image');
      const pruned = await runChild<RemovalResult>({
        action: 'prune',
        worktreeId: pruneTarget.worktree!.id,
        workspacePath: pruneTarget.worktree!.path,
        leaseId: pruneTarget.receipt!.leaseId,
      });
      cleanupTargets.splice(
        cleanupTargets.findIndex((entry) => entry.worktreeId === pruneTarget.worktree!.id),
        1,
      );
      expect(pruned.status, JSON.stringify(pruned.body)).toBe(200);
      expect(pruned.body).toMatchObject({ pruned: [pruneTarget.worktree!.id], count: 1 });
      expect(pruned.pathExists).toBe(false);
      expect(pruned.lease).toBeNull();

      expect((await cleanup(first)).status).toBe(200);
      const poisoned = await runChild<CreateResult>({
        action: 'poison',
        taskName: 'image poison refusal',
        imagePath: first.image!.imagePath,
      });
      expect(poisoned.status).toBe(500);
      expect(JSON.stringify(poisoned.body)).toMatch(/drifted after publication|dependency image/i);
    }, 240_000);
  },
);
