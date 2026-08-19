import { execFile } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DependencyImageRefusalError,
  captureDependencyImageSourceReceipt,
  detachDependencyImageLease,
  mountDependencyImage,
  publishDependencyImage,
  reconcileDependencyImageLeases,
  type DependencyImageSourceReceipt,
} from '@/lib/workspace/apfs-dependency-image';
import {
  deriveDependencyInstallRecipe,
  runDependencyInstall,
  type DependencyInstallReceipt,
} from '@/lib/workspace/dependency-install';
import {
  listDependencySeedLeases, readDependencySeedImage,
} from '@/lib/workspace/dependency-seed-registry';
import {
  mountedDependencyImages, runHdiCommand,
} from '@/lib/workspace/dependency-image-device-authority';

const execFileAsync = promisify(execFile);
const command = 'npm ci --ignore-scripts --no-audit --no-fund';
let root = '';
let registryRoot = '';
let npmVersion = '';
const attachedSandboxes: string[] = [];

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, timeout: 15_000 });
}

/**
 * A dedicated, bounded APFS volume. ENOSPC is simulated by exhausting THIS
 * volume — never the root volume the machine boots from.
 */
async function attachSandboxVolume(name: string, megabytes: number): Promise<{
  mountPoint: string;
  baseDevice: string;
}> {
  const imagePath = path.join(root, `${name}.dmg`);
  const mountPoint = path.join(root, `${name}-mnt`);
  await mkdir(mountPoint, { mode: 0o700 });
  await runHdiCommand([
    'create', '-size', `${megabytes}m`, '-fs', 'APFS',
    '-volname', `o8Sandbox${name}`, '-quiet', imagePath,
  ]);
  const attached = await runHdiCommand([
    'attach', '-nobrowse', '-owners', 'on', '-mountpoint', mountPoint, '-plist', imagePath,
  ]);
  const devices = [...attached.stdout.toString('utf8').matchAll(
    /<key>dev-entry<\/key>\s*<string>(\/dev\/disk\d+)<\/string>/g,
  )].map((match) => match[1]!);
  const baseDevice = devices[0]!;
  attachedSandboxes.push(baseDevice);
  return { mountPoint, baseDevice };
}

async function detachSandboxVolume(baseDevice: string): Promise<void> {
  await runHdiCommand(['detach', baseDevice, '-quiet']).catch(() => undefined);
  const index = attachedSandboxes.indexOf(baseDevice);
  if (index >= 0) attachedSandboxes.splice(index, 1);
}

async function makeSource(name: string, version: string, payloadBytes = 0): Promise<{
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
  if (payloadBytes > 0) {
    // Incompressible payload so the sealed UDRO image cannot fit the sandbox.
    await writeFile(
      path.join(workspace, 'node_modules', 'fixture-package', 'payload.bin'),
      randomBytes(payloadBytes),
    );
  }
  await git(workspace, ['init', '-q']);
  await git(workspace, ['config', 'user.email', 'test@example.invalid']);
  await git(workspace, ['config', 'user.name', 'o8 test']);
  await git(workspace, ['add', 'package.json', 'package-lock.json']);
  await git(workspace, ['commit', '-qm', 'fixture']);
  const recipe = await deriveDependencyInstallRecipe(workspace, command, {
    resolveVersion: async () => npmVersion,
  });
  const receipt = { recipe, privateViewVerified: true, completedAt: 'ignored-by-image-authority' };
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

describe.skipIf(process.platform !== 'darwin')('APFS dependency mount failure modes real path', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'o8-apfs-dependency-failure-'));
    registryRoot = path.join(root, 'registry');
    npmVersion = (await execFileAsync('npm', ['--version'])).stdout.trim();
  });

  afterAll(async () => {
    for (const lease of listDependencySeedLeases()) {
      await detachDependencyImageLease(lease.leaseId).catch(() => undefined);
    }
    for (const baseDevice of [...attachedSandboxes]) await detachSandboxVolume(baseDevice);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('fails closed with no partial publication when the image volume runs out of space', async () => {
    const sandbox = await attachSandboxVolume('enospc', 32);
    const constrainedRegistry = path.join(sandbox.mountPoint, 'registry');
    const source = await makeSource('source-enospc', '1.0.0', 48 * 1024 * 1024);
    try {
      // hdiutil reports an exhausted volume as either "No space left on
      // device" or "Cannot allocate memory", so the durable claim is that the
      // refusal names a cause at all — `-quiet` used to blank it entirely.
      await expect(publishDependencyImage(source.sourceReceipt, {
        registryRoot: constrainedRegistry,
        resolveVersion: async () => npmVersion,
      })).rejects.toThrow(/hdiutil failed \(1\): hdiutil: create failed - \S/);

      // Fail-closed: no durable record, no staging residue, no partial attach.
      expect(readDependencySeedImage(source.receipt.recipe.key)).toBeNull();
      expect(await readdir(path.join(constrainedRegistry, 'staging'))).toEqual([]);
      expect(await readdir(path.join(constrainedRegistry, 'images'))).toEqual([]);
      // No staging or validation attach survives (the sandbox volume itself is
      // an hdiutil mount, so this is scoped to the registry it hosts).
      const live = await mountedDependencyImages();
      expect(live.some((device) => (
        device.imagePath?.startsWith(constrainedRegistry)
        || device.mountPath?.startsWith(constrainedRegistry)
      ))).toBe(false);

      // Startup reconciliation converges clean after the space failure.
      await expect(reconcileDependencyImageLeases()).resolves.toEqual([]);
      expect(listDependencySeedLeases(source.receipt.recipe.key)).toEqual([]);
    } finally {
      await detachSandboxVolume(sandbox.baseDevice);
    }

    // The recipe is not poisoned: publication succeeds once space exists.
    const recovered = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    expect(recovered.state).toBe('ready');
  }, 300_000);

  it('fails closed when the mounted dependency volume is removed out of band', async () => {
    const decoy = await attachSandboxVolume('decoy', 16);
    const source = await makeSource('source-volume-removal', '2.0.0');
    await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const workspace = await cloneWorkspace(source.workspace, 'workspace-volume-removal');
    const mount = await mountDependencyImage(workspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    expect(await readFile(
      path.join(workspace, 'node_modules', 'fixture-package', 'index.js'), 'utf8',
    )).toContain('2.0.0');

    // Out-of-band removal: the volume vanishes under a live lease.
    await runHdiCommand(['detach', mount.deviceEntry, '-force', '-quiet']);
    expect((await mountedDependencyImages()).some((device) => (
      device.deviceEntry === mount.deviceEntry
    ))).toBe(false);

    // The lease resolves through the documented absent-device recovery path.
    await detachDependencyImageLease(mount.leaseId);
    expect(listDependencySeedLeases(source.receipt.recipe.key)).toEqual([]);
    await expect(lstat(mount.shadowPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(reconcileDependencyImageLeases()).resolves.toEqual([]);

    // No wrong-device action: the unrelated sandbox volume is untouched.
    const inventory = await mountedDependencyImages();
    expect(inventory.some((device) => device.deviceEntry === decoy.baseDevice)).toBe(true);
    await detachSandboxVolume(decoy.baseDevice);
  }, 300_000);

  it('refuses a corrupted publication manifest instead of restoring garbage', async () => {
    const source = await makeSource('source-corrupt-manifest', '3.0.0');
    const image = await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const workspace = await cloneWorkspace(source.workspace, 'workspace-corrupt-manifest');
    await chmod(image.manifestPath, 0o600);
    await writeFile(image.manifestPath, '{"version":1,"recipeKey":"tru');
    await chmod(image.manifestPath, 0o444);

    await expect(mountDependencyImage(workspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toBeInstanceOf(DependencyImageRefusalError);
    await expect(mountDependencyImage(workspace, command, source.receipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/manifest digest does not match durable authority/);

    // No lease, no mount, no partially restored tree.
    expect(listDependencySeedLeases(source.receipt.recipe.key)).toEqual([]);
    expect((await mountedDependencyImages()).some((device) => (
      device.mountPath === path.join(workspace, 'node_modules')
    ))).toBe(false);
    // The refusal lands before the mountpoint is even created.
    await expect(lstat(path.join(workspace, 'node_modules')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  }, 300_000);

  it('refuses a dependency receipt recorded under another architecture', async () => {
    const source = await makeSource('source-arch-drift', '4.0.0');
    await publishDependencyImage(source.sourceReceipt, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    });
    const workspace = await cloneWorkspace(source.workspace, 'workspace-arch-drift');
    const foreignArchitecture = process.arch === 'arm64' ? 'x64' : 'arm64';
    const drifted = await deriveDependencyInstallRecipe(source.workspace, command, {
      resolveVersion: async () => npmVersion,
      runtimeFacts: {
        abi: process.versions.modules,
        platform: process.platform,
        architecture: foreignArchitecture,
      },
    });

    // Architecture is digested into the recipe key, so drift is detectable.
    expect(drifted.architecture).toBe(foreignArchitecture);
    expect(drifted.key).not.toBe(source.receipt.recipe.key);

    await expect(mountDependencyImage(workspace, command, drifted, {
      registryRoot,
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/recipe drifted from its install receipt/);
    await expect(captureDependencyImageSourceReceipt(
      source.workspace, command,
      { recipe: drifted, privateViewVerified: true, completedAt: 'ignored' },
      { registryRoot, resolveVersion: async () => npmVersion },
    )).rejects.toBeInstanceOf(DependencyImageRefusalError);

    expect(listDependencySeedLeases(drifted.key)).toEqual([]);
    expect(readDependencySeedImage(drifted.key)).toBeNull();
    expect((await mountedDependencyImages()).some((device) => (
      device.mountPath === path.join(workspace, 'node_modules')
    ))).toBe(false);
  }, 300_000);

  it('fails closed without partial state when the dependency registry is unreachable', async () => {
    const workspace = path.join(root, 'workspace-offline');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), `${JSON.stringify({
      name: 'workspace-offline',
      version: '1.0.0',
      dependencies: { 'left-pad': '1.3.0' },
    })}\n`);
    await writeFile(path.join(workspace, 'package-lock.json'), `${JSON.stringify({
      name: 'workspace-offline',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'workspace-offline',
          version: '1.0.0',
          dependencies: { 'left-pad': '1.3.0' },
        },
        'node_modules/left-pad': {
          version: '1.3.0',
          resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
          integrity: 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==',
        },
      },
    })}\n`);
    await git(workspace, ['init', '-q']);
    await git(workspace, ['config', 'user.email', 'test@example.invalid']);
    await git(workspace, ['config', 'user.name', 'o8 test']);
    await git(workspace, ['add', 'package.json', 'package-lock.json']);
    await git(workspace, ['commit', '-qm', 'offline fixture']);

    // `--offline` against an empty private cache is an unreachable registry:
    // npm refuses without a network round trip, so there is no hang to wait out.
    const offlineCommand = 'npm ci --ignore-scripts --no-audit --no-fund --offline';
    const started = Date.now();
    await expect(runDependencyInstall(workspace, offlineCommand, {
      cacheRoot: path.join(root, 'offline-cache'),
      resolveVersion: async () => npmVersion,
    })).rejects.toThrow(/ENOTCACHED|only-if-cached/);
    expect(Date.now() - started).toBeLessThan(120_000);

    // No partial dependency view survives the refusal.
    await expect(lstat(path.join(workspace, 'node_modules')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    // The per-run install runtime is purged; only its empty pinned parent stays.
    expect(await readdir(path.join(workspace, '.o8-install-runtime'))).toEqual([]);

    // The image authority refuses to publish from an install that never landed.
    await expect(captureDependencyImageSourceReceipt(
      workspace, offlineCommand,
      {
        recipe: await deriveDependencyInstallRecipe(workspace, offlineCommand, {
          resolveVersion: async () => npmVersion,
        }),
        privateViewVerified: true,
        completedAt: 'ignored',
      },
      { registryRoot, resolveVersion: async () => npmVersion },
    )).rejects.toThrow(/without a private node_modules view/);
  }, 300_000);
});
