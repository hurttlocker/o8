import { execFile, spawn } from 'node:child_process';
import {
  chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  DependencyImageRefusalError,
  captureDependencyImageSourceReceipt,
  detachDependencyImageLease,
  mountDependencyImage,
  publishDependencyImage,
  reconcileDependencyImageLeases,
  retireDependencyImage,
  type DependencyImageSourceReceipt,
} from '@/lib/workspace/apfs-dependency-image';
import { deriveDependencyInstallRecipe, type DependencyInstallReceipt } from '@/lib/workspace/dependency-install';
import {
  findDependencySeedLeaseForWorkspace, listDependencySeedLeases,
  readDependencySeedImage, readDependencySeedLease,
} from '@/lib/workspace/dependency-seed-registry';
import {
  mountedDependencyImages,
  runHdiCommand,
  unmountDependencyImageDevice,
} from '@/lib/workspace/dependency-image-device-authority';
import {
  listDependencySeedLeaseCleanupTargets,
  readDependencySeedLeaseCleanupAction,
} from '@/lib/workspace/dependency-image-lease-cleanup';
import {
  detachAttachedApfsFixtureImages,
  removeFixtureDirectoryIfUnmountedSync,
} from './test-fixture-lifecycle';

const execFileAsync = promisify(execFile);
const command = 'npm ci --ignore-scripts --no-audit --no-fund';
let root = '';
let registryRoot = '';
let npmVersion = '';
const spawnedChildren = new Set<ReturnType<typeof spawn>>();
const childOutput = new WeakMap<ReturnType<typeof spawn>, {
  stdout: string;
  stderr: string;
  error: string | null;
}>();

function appendTail(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-8_000);
}

function trackChild(child: ReturnType<typeof spawn>): ReturnType<typeof spawn> {
  spawnedChildren.add(child);
  const output = { stdout: '', stderr: '', error: null as string | null };
  childOutput.set(child, output);
  child.stdout?.on('data', (chunk) => { output.stdout = appendTail(output.stdout, chunk); });
  child.stderr?.on('data', (chunk) => { output.stderr = appendTail(output.stderr, chunk); });
  child.once('error', (error) => { output.error = error.message; });
  const forget = () => spawnedChildren.delete(child);
  child.once('error', forget);
  child.once('exit', forget);
  return child;
}

function describeChild(child: ReturnType<typeof spawn>): string {
  const output = childOutput.get(child) ?? { stdout: '', stderr: '', error: null };
  return [
    `exitCode=${child.exitCode ?? 'null'} signal=${child.signalCode ?? 'null'} error=${output.error ?? 'null'}`,
    `stdout-tail:\n${output.stdout || '<empty>'}`,
    `stderr-tail:\n${output.stderr || '<empty>'}`,
  ].join('\n');
}

async function waitForChildBoundary(
  child: ReturnType<typeof spawn>,
  boundaryPath: string,
  label: string,
  timeoutMs = 30_000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await lstat(boundaryPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const stopped = child.exitCode !== null || child.signalCode !== null || childOutput.get(child)?.error;
      if (stopped || Date.now() >= deadline) {
        throw new Error(`${label} child did not reach its live staging boundary.\n${describeChild(child)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

function waitForChildToStop(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (stopped: boolean) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(stopped);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref();
    child.once('exit', onExit);
  });
}

async function stopSpawnedChildren(): Promise<void> {
  for (const child of [...spawnedChildren]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    if (await waitForChildToStop(child, 2_000)) continue;
    child.kill('SIGKILL');
    if (!await waitForChildToStop(child, 2_000)) {
      throw new Error(`APFS test child ${child.pid ?? 'unknown'} survived teardown.`);
    }
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, timeout: 15_000 });
}

async function makeSource(name: string, version: string): Promise<{
  workspace: string;
  receipt: DependencyInstallReceipt;
  sourceReceipt: DependencyImageSourceReceipt;
}> {
  const workspace = path.join(root, name);
  await mkdir(path.join(workspace, 'node_modules', 'fixture-package'), { recursive: true });
  await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({ name, version })}\n`);
  await writeFile(path.join(workspace, 'package-lock.json'), `${JSON.stringify({
    name,
    version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name, version } },
  })}\n`);
  await writeFile(
    path.join(workspace, 'node_modules', 'fixture-package', 'index.js'),
    `module.exports = ${JSON.stringify(version)};\n`,
  );
  await git(workspace, ['init', '-q']);
  await git(workspace, ['config', 'user.email', 'test@example.invalid']);
  await git(workspace, ['config', 'user.name', 'o8 test']);
  await git(workspace, ['add', 'package.json', 'package-lock.json']);
  await git(workspace, ['commit', '-qm', 'fixture']);
  const recipe = await deriveDependencyInstallRecipe(workspace, command, {
    resolveVersion: async () => npmVersion,
  });
  const receipt = {
    recipe,
    packageManagerExecutable: 'npm',
    privateViewVerified: true,
    completedAt: 'ignored-by-image-authority',
  };
  const sourceReceipt = await captureDependencyImageSourceReceipt(workspace, command, receipt, {
    resolveVersion: async () => npmVersion,
  });
  return { workspace, receipt, sourceReceipt };
}

async function cloneWorkspace(source: string, name: string): Promise<string> {
  const target = path.join(root, name);
  await execFileAsync('git', ['clone', '-q', source, target], { timeout: 15_000 });
  return target;
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const priorError = childOutput.get(child)?.error;
    if (priorError) {
      reject(new Error(`${priorError}\n${describeChild(child)}`));
      return;
    }
    const finish = () => {
      const output = childOutput.get(child) ?? { stdout: '', stderr: '', error: null };
      resolve({ code: child.exitCode, signal: child.signalCode, stdout: output.stdout, stderr: output.stderr });
    };
    const fail = (error: Error) => reject(new Error(`${error.message}\n${describeChild(child)}`));
    child.once('error', fail);
    child.once('exit', finish);
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

describe.skipIf(process.platform !== 'darwin')('APFS dependency image real path', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'o8-apfs-dependency-image-'));
    registryRoot = path.join(root, 'registry');
    npmVersion = (await execFileAsync('npm', ['--version'])).stdout.trim();
  });

  afterEach(async () => {
    await stopSpawnedChildren();
  });

  afterAll(async () => {
    try {
      await stopSpawnedChildren();
      for (const lease of listDependencySeedLeases()) {
        await detachDependencyImageLease(lease.leaseId).catch(() => undefined);
      }
    } finally {
      if (root) {
        const imageCleanup = await detachAttachedApfsFixtureImages(root);
        if (imageCleanup.retained.length > 0) {
          throw new Error(
            `APFS dependency image fixture retained attached images: ${imageCleanup.retained.join(', ')}`,
          );
        }
        const rootIdentity = await lstat(root).catch(() => null);
        if (rootIdentity && !removeFixtureDirectoryIfUnmountedSync(root)) {
          throw new Error(`APFS dependency image fixture remained mounted: ${root}`);
        }
      }
    }
  });

  it('seals, mounts, crash-adopts, isolates, and retires exact generations', async () => {
    const source = await makeSource('source-main', '1.0.0');
    const image = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    expect(image.state).toBe('ready');
    expect(image.imageDigest).toMatch(/^[0-9a-f]{64}$/);
    const manifest = JSON.parse(await readFile(image.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('completedAt');
    expect((await lstat(image.imagePath)).mode & 0o222).toBe(0);
    expect((await lstat(image.manifestPath)).mode & 0o222).toBe(0);

    const [workspaceA, workspaceB] = await Promise.all([
      cloneWorkspace(source.workspace, 'workspace-a'),
      cloneWorkspace(source.workspace, 'workspace-b'),
    ]);
    const [mountA, mountB] = await Promise.all([
      mountDependencyImage(workspaceA, command, source.receipt, {
        registryRoot,
        resolveVersion: async () => npmVersion,
      }),
      mountDependencyImage(workspaceB, command, source.receipt, {
        registryRoot,
        resolveVersion: async () => npmVersion,
      }),
    ]);
    expect(mountA.shadowPath).not.toBe(mountB.shadowPath);
    const relativePackage = path.join('node_modules', 'fixture-package', 'index.js');
    await writeFile(path.join(workspaceA, relativePackage), 'module.exports = "workspace-a";\n');
    expect(await readFile(path.join(workspaceB, relativePackage), 'utf8')).toContain('1.0.0');
    await expect(retireDependencyImage(source.receipt.recipe.key)).rejects.toThrow(/live lease or mount/);
    await Promise.all([
      detachDependencyImageLease(mountA.leaseId),
      detachDependencyImageLease(mountB.leaseId),
    ]);

    const crashWorkspace = await cloneWorkspace(source.workspace, 'workspace-crash');
    const modulePath = path.join(process.cwd(), 'src/lib/workspace/apfs-dependency-image.ts');
    const childScript = `
      import Module from 'node:module';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      const { mountDependencyImage } = dependencyImage;
      const receipt = ${JSON.stringify(source.receipt)};
      await mountDependencyImage(
        ${JSON.stringify(crashWorkspace)},
        ${JSON.stringify(command)},
        receipt,
        {
          registryRoot: ${JSON.stringify(registryRoot)},
          resolveVersion: async () => ${JSON.stringify(npmVersion)},
          afterAttachCommand: async () => process.exit(86),
        },
      );
    `;
    const child = trackChild(spawn(process.execPath, ['--import=tsx', '--input-type=module', '--eval', childScript], {
      cwd: process.cwd(),
      env: { ...process.env },
      stdio: 'pipe',
    }));
    const childExit = await waitForExit(child);
    expect(childExit.code, childExit.stderr).toBe(86);
    await reconcileDependencyImageLeases();
    const crashMount = await mountDependencyImage(crashWorkspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    expect(await readFile(path.join(crashWorkspace, relativePackage), 'utf8')).toContain('1.0.0');
    const detachScript = `
      import Module from 'node:module';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      await dependencyImage.detachDependencyImageLease(
        ${JSON.stringify(crashMount.leaseId)},
        { afterShadowUnlinked: async () => process.exit(87) },
      );
    `;
    const detachChild = trackChild(spawn(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', detachScript,
    ], { cwd: process.cwd(), env: { ...process.env }, stdio: 'pipe' }));
    const detachExit = await waitForExit(detachChild);
    expect(detachExit.code, detachExit.stderr).toBe(87);
    expect(listDependencySeedLeases(source.receipt.recipe.key)[0]?.state).toBe('detaching');
    await reconcileDependencyImageLeases();
    expect(listDependencySeedLeases(source.receipt.recipe.key)).toHaveLength(0);
    await retireDependencyImage(source.receipt.recipe.key);
    expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
    await expect(lstat(image.imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(image.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('fails closed on recipe drift, prohibited bytes, external links, and image mutation', async () => {
    const source = await makeSource('source-refusals', '2.0.0');
    const image = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const drifted = await makeSource('source-drifted', '2.0.1');
    await expect(captureDependencyImageSourceReceipt(
      drifted.workspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
      },
    )).rejects.toBeInstanceOf(DependencyImageRefusalError);

    await writeFile(path.join(source.workspace, 'node_modules', '.env'), 'TOKEN=secret\n');
    await expect(publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/prohibited output/);
    await rm(path.join(source.workspace, 'node_modules', '.env'));
    const external = path.join(root, 'external-secret');
    await writeFile(external, 'do-not-import\n');
    await symlink(external, path.join(source.workspace, 'node_modules', 'escape'));
    await expect(publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/link escapes/);
    await rm(path.join(source.workspace, 'node_modules', 'escape'));

    await chmod(image.imagePath, 0o600);
    await writeFile(image.imagePath, 'poisoned', { flag: 'a' });
    const target = await cloneWorkspace(source.workspace, 'workspace-poison');
    await expect(mountDependencyImage(target, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/drifted after publication/);
    expect(await readFile(external, 'utf8')).toBe('do-not-import\n');

    const displacedImage = `${image.imagePath}.displaced`;
    await rename(image.imagePath, displacedImage);
    await writeFile(image.imagePath, 'replacement', { flag: 'wx', mode: 0o444 });
    const replacement = await lstat(image.imagePath);
    await expect(retireDependencyImage(source.receipt.recipe.key)).rejects.toThrow(/exact inode authority/);
    expect(readDependencySeedImage(source.receipt.recipe.key)?.state).toBe('retiring');
    expect((await lstat(image.imagePath)).ino).toBe(replacement.ino);
    expect((await lstat(image.imagePath)).mode & 0o222).toBe(0);
    expect((await lstat(displacedImage)).ino).toBe(image.imageInode);
  }, 120_000);

  it('refuses post-readiness dependency mutations against the install-time receipt', async () => {
    const source = await makeSource('source-post-ready-mutation', '2.1.0');
    await writeFile(
      path.join(source.workspace, 'node_modules', 'fixture-package', 'index.js'),
      'module.exports = "worker-poison";\n',
    );
    await expect(publishDependencyImage(source.sourceReceipt, {
      registryRoot,
    })).rejects.toThrow(/changed after its trusted install-time receipt/);
    expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
  }, 120_000);

  it('reports child output and exit state when a publisher boundary stalls', async () => {
    const boundaryPath = path.join(root, 'forced-stall-boundary');
    const child = trackChild(spawn(process.execPath, ['--eval', [
      'console.log("forced-publisher-stdout")',
      'console.error("forced-publisher-stderr")',
      'setInterval(() => {}, 1000)',
    ].join(';')], { stdio: 'pipe' }));
    let failure = '';
    try {
      await waitForChildBoundary(child, boundaryPath, 'Forced publisher', 200, 20);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toContain('exitCode=null signal=null error=null');
    expect(failure).toContain('stdout-tail:\nforced-publisher-stdout');
    expect(failure).toContain('stderr-tail:\nforced-publisher-stderr');
  });

  it('waits for a live concurrent publisher without retiring its staging authority', async () => {
    const source = await makeSource('source-concurrent-publish', '2.2.0');
    const modulePath = path.join(process.cwd(), 'src/lib/workspace/apfs-dependency-image.ts');
    const startedPath = path.join(root, 'publisher-started');
    const releasePath = path.join(root, 'publisher-release');
    const resultPath = path.join(root, 'publisher-result.json');
    const childScript = `
      import Module from 'node:module';
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      const image = await dependencyImage.publishDependencyImage(
        ${JSON.stringify(source.sourceReceipt)},
        {
          registryRoot: ${JSON.stringify(registryRoot)},
          afterImageCreated: async () => {
            await writeFile(${JSON.stringify(startedPath)}, 'ready');
            for (;;) {
              try { await access(${JSON.stringify(releasePath)}); break; }
              catch { await delay(20); }
            }
          },
        },
      );
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ generation: image.generation }));
    `;
    const child = trackChild(spawn(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', childScript,
    ], { cwd: process.cwd(), env: { ...process.env }, stdio: 'pipe' }));
    await waitForChildBoundary(child, startedPath, 'Publisher');
    let competingSettled = false;
    const competing = publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      publisherWaitMs: 30_000,
    }).finally(() => { competingSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const live = readDependencySeedImage(source.receipt.recipe.key);
    expect(competingSettled).toBe(false);
    expect(live).toMatchObject({ state: 'building', publisherPid: child.pid });
    await expect(lstat(live!.stagingDirectory)).resolves.toMatchObject({
      dev: live!.stagingDevice,
      ino: live!.stagingInode,
    });
    await writeFile(releasePath, 'release');
    const childExit = await waitForExit(child);
    expect(childExit.code, childExit.stderr).toBe(0);
    const [adopted, childResult] = await Promise.all([
      competing,
      readFile(resultPath, 'utf8').then((bytes) => JSON.parse(bytes) as { generation: string }),
    ]);
    expect(adopted.generation).toBe(childResult.generation);
    expect(adopted.state).toBe('ready');
  }, 180_000);

  it('preserves a live child prepared lease until attach gains durable authority', async () => {
    const source = await makeSource('source-live-prepared-lease', '2.3.0');
    await publishDependencyImage(source.sourceReceipt, { registryRoot });
    const workspace = await cloneWorkspace(source.workspace, 'workspace-live-prepared-lease');
    const modulePath = path.join(process.cwd(), 'src/lib/workspace/apfs-dependency-image.ts');
    const startedPath = path.join(root, 'lease-prepared');
    const releasePath = path.join(root, 'lease-release');
    const resultPath = path.join(root, 'lease-result.json');
    const childScript = `
      import Module from 'node:module';
      import { access, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      const mount = await dependencyImage.mountDependencyImage(
        ${JSON.stringify(workspace)},
        ${JSON.stringify(command)},
        ${JSON.stringify(source.receipt)},
        {
          registryRoot: ${JSON.stringify(registryRoot)},
          resolveVersion: async () => ${JSON.stringify(npmVersion)},
          afterLeasePrepared: async () => {
            await writeFile(${JSON.stringify(startedPath)}, 'ready');
            for (;;) {
              try { await access(${JSON.stringify(releasePath)}); break; }
              catch { await delay(20); }
            }
          },
        },
      );
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ leaseId: mount.leaseId }));
    `;
    const child = trackChild(spawn(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', childScript,
    ], { cwd: process.cwd(), env: { ...process.env }, stdio: 'pipe' }));
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        await lstat(startedPath);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (attempt === 299) throw new Error('Mount child did not persist its prepared lease.');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const prepared = findDependencySeedLeaseForWorkspace(workspace)!;
    expect(prepared.state).toBe('mounting');
    await expect(reconcileDependencyImageLeases()).resolves.toContainEqual({
      leaseId: prepared.leaseId,
      recipeKey: prepared.recipeKey,
      generation: prepared.generation,
      workspacePath: prepared.workspacePath,
      state: 'blocked',
      note: 'A live process still owns this prepared dependency mount.',
    });
    expect(readDependencySeedLease(prepared.leaseId)?.state).toBe('mounting');
    await writeFile(releasePath, 'release');
    const childExit = await waitForExit(child);
    expect(childExit.code, childExit.stderr).toBe(0);
    const childResult = JSON.parse(await readFile(resultPath, 'utf8')) as { leaseId: string };
    expect(readDependencySeedLease(childResult.leaseId)?.state).toBe('mounted');
    await expect(reconcileDependencyImageLeases()).resolves.toContainEqual(expect.objectContaining({
      leaseId: childResult.leaseId,
      state: 'mounted',
    }));
    await detachDependencyImageLease(childResult.leaseId);
    expect(readDependencySeedLease(childResult.leaseId)).toBeNull();
    expect((await mountedDependencyImages()).some((entry) => (
      entry.mountPath === path.join(workspace, 'node_modules')
    ))).toBe(false);
  }, 180_000);

  it('replays the exact staging image after a publisher child crashes', async () => {
    const source = await makeSource('source-publish-crash', '3.0.0');
    let failedStagingDirectory = '';
    await expect(publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
      afterImageCreated: async (imagePath) => {
        failedStagingDirectory = path.dirname(imagePath);
        throw new Error('simulated pre-receipt failure');
      },
    })).rejects.toThrow('simulated pre-receipt failure');
    expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
    await expect(lstat(failedStagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const modulePath = path.join(process.cwd(), 'src/lib/workspace/apfs-dependency-image.ts');
    const childScript = `
      import Module from 'node:module';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      await dependencyImage.publishDependencyImage(
        ${JSON.stringify(source.sourceReceipt)},
        {
          registryRoot: ${JSON.stringify(registryRoot)},
          resolveVersion: async () => ${JSON.stringify(npmVersion)},
          afterImageCreated: async () => process.exit(88),
        },
      );
    `;
    const child = trackChild(spawn(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', childScript,
    ], { cwd: process.cwd(), env: { ...process.env }, stdio: 'pipe' }));
    const childExit = await waitForExit(child);
    expect(childExit.code, childExit.stderr).toBe(88);
    const crashed = readDependencySeedImage(source.receipt.recipe.key);
    expect(crashed?.state).toBe('building');
    const recovered = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    expect(recovered.state).toBe('ready');
    expect(recovered.generation).toBe(crashed?.generation);
    expect((await lstat(recovered.imagePath)).mode & 0o222).toBe(0);
    expect((await lstat(recovered.manifestPath)).mode & 0o222).toBe(0);
    const retireScript = `
      import Module from 'node:module';
      const originalLoad = Module._load;
      Module._load = function(request, parent, isMain) {
        if (request === 'server-only') return {};
        return originalLoad.call(this, request, parent, isMain);
      };
      const imported = await import(${JSON.stringify(modulePath)});
      const dependencyImage = imported.default ?? imported;
      await dependencyImage.retireDependencyImage(
        ${JSON.stringify(source.receipt.recipe.key)},
        {
          afterFileRenamed: async (artifact) => {
            if (artifact === 'image') process.exit(89);
          },
        },
      );
    `;
    const retireChild = trackChild(spawn(process.execPath, [
      '--import=tsx', '--input-type=module', '--eval', retireScript,
    ], { cwd: process.cwd(), env: { ...process.env }, stdio: 'pipe' }));
    const retireExit = await waitForExit(retireChild);
    expect(retireExit.code, retireExit.stderr).toBe(89);
    const retiring = readDependencySeedImage(source.receipt.recipe.key);
    expect(retiring?.state).toBe('retiring');
    expect(retiring?.imageRetirementPhase).toBe(1);
    await expect(lstat(recovered.imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(retiring!.imageRetiredPath!)).ino).toBe(recovered.imageInode);
    expect((await lstat(recovered.manifestPath)).mode & 0o222).toBe(0);
    await retireDependencyImage(source.receipt.recipe.key);
    expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
    await expect(lstat(recovered.imagePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(recovered.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(path.dirname(recovered.imagePath)))
      .filter((name) => name.startsWith('.o8-retired-'))).toEqual([]);
  }, 120_000);

  it('refuses a publication name swap before sealing or durable receipt', async () => {
    const source = await makeSource('source-publish-swap', '4.0.0');
    let stagingDirectory = '';
    await expect(publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
      afterImageValidated: async (imagePath) => {
        stagingDirectory = path.dirname(imagePath);
        const displaced = `${imagePath}.displaced`;
        await rename(imagePath, displaced);
        await copyFile(displaced, imagePath);
        await chmod(imagePath, 0o444);
      },
    })).rejects.toThrow(/exact inode authority/);
    expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
    await expect(lstat(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('refuses a same-tree mount inode swap and durably cleans attach-receipt ambiguity', async () => {
    const source = await makeSource('source-mount-authority', '5.0.0');
    const image = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const target = await cloneWorkspace(source.workspace, 'workspace-mount-swap');
    const displaced = `${image.imagePath}.displaced`;
    const attachedReplacement = `${image.imagePath}.attached-replacement`;
    let swapLeaseId = '';
    await expect(mountDependencyImage(target, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
      afterImageVerifiedBeforeAttach: async () => {
        await rename(image.imagePath, displaced);
        await copyFile(displaced, image.imagePath);
        await chmod(image.imagePath, 0o444);
      },
      afterAttach: async (leaseId) => {
        swapLeaseId = leaseId;
        await rename(image.imagePath, attachedReplacement);
        await rename(displaced, image.imagePath);
      },
    })).rejects.toThrow(/different base vnode|lost its exact namespace/);
    expect(listDependencySeedLeases(source.receipt.recipe.key)).toHaveLength(0);
    expect(readDependencySeedLeaseCleanupAction(swapLeaseId)).toBeNull();
    expect(listDependencySeedLeaseCleanupTargets(swapLeaseId)).toEqual([]);
    expect((await mountedDependencyImages()).some((entry) => (
      entry.mountPath === path.join(target, 'node_modules')
    ))).toBe(false);

    const ambiguousTarget = await cloneWorkspace(
      source.workspace, 'workspace-attach-ambiguity',
    );
    let preReceiptLeaseId = '';
    await expect(mountDependencyImage(
      ambiguousTarget, command, source.receipt,
      {
        registryRoot,
        resolveVersion: async () => npmVersion,
        afterAttachCommand: async (leaseId) => {
          preReceiptLeaseId = leaseId;
          throw new Error('simulated attach receipt loss');
        },
      },
    )).rejects.toThrow('simulated attach receipt loss');
    expect(listDependencySeedLeases(source.receipt.recipe.key)).toHaveLength(0);
    expect(readDependencySeedLeaseCleanupAction(preReceiptLeaseId)).toBeNull();
    expect(listDependencySeedLeaseCleanupTargets(preReceiptLeaseId)).toEqual([]);
    expect((await mountedDependencyImages()).some((entry) => (
      entry.mountPath === path.join(ambiguousTarget, 'node_modules')
    ))).toBe(false);
    expect(await readdir(path.join(registryRoot, 'shadows'))).toEqual([]);
  }, 180_000);

  it('rejects a duplicate same-shadow attach and cleans the exact lease without residue', async () => {
    const source = await makeSource('source-multi-device-cleanup', '6.0.0');
    await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const workspace = await cloneWorkspace(source.workspace, 'workspace-multi-device-cleanup');
    const mount = await mountDependencyImage(workspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const extraMount = path.join(root, 'workspace-multi-device-extra-mount');
    await mkdir(extraMount, { mode: 0o700 });
    try {
      await expect(runHdiCommand([
        'attach', '-noverify', '-nobrowse', '-owners', 'on', '-mountpoint', extraMount,
        '-shadow', mount.shadowPath, '-plist', mount.imagePath,
      ])).rejects.toThrow(/attach failed - Resource busy/);
      const relatedBefore = (await mountedDependencyImages()).filter((device) => (
        device.imagePath === mount.imagePath && device.shadowPath === mount.shadowPath
      ));
      expect(relatedBefore.map((device) => device.deviceEntry)).toEqual([mount.deviceEntry]);
      await detachDependencyImageLease(mount.leaseId);
      expect(readDependencySeedLease(mount.leaseId)).toBeNull();
      expect(readDependencySeedLeaseCleanupAction(mount.leaseId)).toBeNull();
      expect(listDependencySeedLeaseCleanupTargets(mount.leaseId)).toEqual([]);
      expect((await mountedDependencyImages()).some((device) => (
        device.imagePath === mount.imagePath && device.shadowPath === mount.shadowPath
      ))).toBe(false);
      await expect(lstat(mount.shadowPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      const live = (await mountedDependencyImages()).filter((device) => (
        device.imagePath === mount.imagePath && device.shadowPath === mount.shadowPath
      ));
      for (const device of live) {
        if (device.mountDevice) {
          await unmountDependencyImageDevice(device.mountDevice).catch(() => undefined);
        }
        await runHdiCommand(['detach', device.deviceEntry, '-quiet']).catch(() => undefined);
      }
    }
  }, 180_000);

  it('requires fixed readiness, a two-times warm speedup, and physical-growth reduction', async () => {
    const benchmarkUrl = pathToFileURL(
      path.join(process.cwd(), 'scripts/bench/apfs-dependency-image.mjs'),
    ).href;
    const evaluation = await execFileAsync(process.execPath, [
      '--input-type=module',
      '--eval',
      `import { evaluateDependencyImagePromotion as gate } from ${JSON.stringify(benchmarkUrl)};
       const cases = [
         gate({warmReadinessMedianMs:1500,seedReadinessMedianMs:900,warmAllocatedGrowthMedianBytes:100,seedAllocatedGrowthMedianBytes:20}),
         gate({warmReadinessMedianMs:10000,seedReadinessMedianMs:3100,warmAllocatedGrowthMedianBytes:100,seedAllocatedGrowthMedianBytes:20}),
         gate({warmReadinessMedianMs:2000,seedReadinessMedianMs:900,warmAllocatedGrowthMedianBytes:100,seedAllocatedGrowthMedianBytes:30}),
         gate({warmReadinessMedianMs:12620.35,seedReadinessMedianMs:4148.238,warmAllocatedGrowthMedianBytes:34603008,seedAllocatedGrowthMedianBytes:12288}),
         gate({warmReadinessMedianMs:12620.35,seedReadinessMedianMs:3000,warmAllocatedGrowthMedianBytes:34603008,seedAllocatedGrowthMedianBytes:12288})
       ];
       process.stdout.write(JSON.stringify(cases));`,
    ]);
    const [speedFail, fixedFail, pass, measuredHold, ruledPass] = JSON.parse(evaluation.stdout) as Array<{
      promotion: string;
      checks: { fixedReadiness: boolean; warmSpeedup: boolean; physicalGrowth: boolean };
    }>;
    expect(speedFail?.checks.warmSpeedup).toBe(false);
    expect(fixedFail?.checks.fixedReadiness).toBe(false);
    expect(pass?.promotion).toBe('PASS');
    expect(measuredHold?.promotion).toBe('FAIL/HOLD');
    expect(ruledPass?.promotion).toBe('PASS');
  });
});
