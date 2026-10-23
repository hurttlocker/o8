import { execFileSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { createPinnedWorkspaceBinding } from '@/lib/worktree/materialization-leaf-io';
import { validateDependencyCloneGraph } from '@/lib/workspace/dependency-clone-validation';
import { materializeDependencyInstall as materialize, type DependencyMaterializerOptions } from '@/lib/workspace/dependency-materializer';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

function materializeDependencyInstall(workspace: string, command: string, options: DependencyMaterializerOptions) {
  return materialize(workspace, command, {
    run: async () => { throw new Error('Unexpected installer fallback'); }, ...options,
  });
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-directory-clone-')));
  roots.push(root);
  const source = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  mkdirSync(source);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(source, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  const packages = { 'node_modules/fixture': { version: '1.0.0' } };
  writeFileSync(path.join(source, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  mkdirSync(path.join(source, 'tools'));
  writeFileSync(path.join(source, 'tools/package.json'), '{"name":"unrelated-tool"}');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'fixture');
  git('clone', '--shared', '-q', source, workspace);
  mkdirSync(path.join(source, 'node_modules', '.bin'), { recursive: true });
  mkdirSync(path.join(source, 'node_modules', 'fixture'));
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"1.0.0","bin":"../tool.js"}');
  writeFileSync(path.join(source, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  writeFileSync(path.join(source, 'node_modules', 'tool.js'), 'private\n');
  symlinkSync('../tool.js', path.join(source, 'node_modules', '.bin', 'tool'));
  return { root, source, workspace };
}

it('materializes the matching recipe privately without an install on APFS, with the native fallback elsewhere', async () => {
  const { source, workspace } = fixture();
  const persisted = vi.fn();
  const run = vi.fn(async () => {
    mkdirSync(path.join(workspace, 'node_modules'));
    writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'fallback\n');
  });
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, materializationIdentity: identity,
    resolveVersion: async () => '11.8.0', env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
    persistReceipt: persisted, run,
  });
  expect(result.receipt).toMatchObject({ mode: 'native', status: 'mounted', workspaceInode: identity.inode });
  expect(persisted).toHaveBeenCalledWith(result.receipt);
  if (process.platform === 'darwin') {
    expect(run).not.toHaveBeenCalled();
    expect(result.installReceipt).toBeNull();
    expect(readFileSync(path.join(workspace, 'node_modules', '.bin', 'tool'), 'utf8')).toBe('private\n');
  } else {
    expect(run).toHaveBeenCalledOnce();
  }
  expect(lstatSync(path.join(workspace, 'node_modules', 'tool.js')).ino)
    .not.toBe(lstatSync(path.join(source, 'node_modules', 'tool.js')).ino);
  writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'worker\n');
  expect(readFileSync(path.join(source, 'node_modules', 'tool.js'), 'utf8')).toBe('private\n');
});

it('falls back for a changed source recipe instead of cloning stale dependencies', async () => {
  const { source, workspace } = fixture();
  writeFileSync(path.join(source, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
});

it('falls back for stale installed versions even when the source recipe is unchanged', async () => {
  const { source, workspace } = fixture();
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'package.json'), '{"name":"fixture","version":"0.9.0"}');
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
});

it('falls back for an unlisted nested package that would shadow the locked resolution', async () => {
  const { source, workspace } = fixture();
  const nested = path.join(source, 'node_modules', 'fixture', 'node_modules', 'stale');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'package.json'), '{"name":"stale","version":"0.9.0"}');
  const run = vi.fn(async () => { mkdirSync(path.join(workspace, 'node_modules')); });
  await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(run).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== 'darwin')('refuses incompatible native bindings before recording a clone receipt', async () => {
  const { source, workspace } = fixture();
  writeFileSync(path.join(source, 'node_modules', 'fixture', 'binding.node'), 'incompatible native artifact');
  const persisted = vi.fn();
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, persistReceipt: persisted,
  })).rejects.toThrow(/dlopen/);
  expect(persisted).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'darwin')('preserves a competing destination instead of overwriting it during publication', async () => {
  const { source, workspace } = fixture();
  const identity = await captureWorktreeMaterializationIdentity(workspace);
  await expect(createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
    mode: 'clone-tree', source: path.join(source, 'node_modules'),
  }, async (segment) => {
    if (segment !== 'clone-source') return;
    mkdirSync(path.join(workspace, 'node_modules'));
    writeFileSync(path.join(workspace, 'node_modules', 'sentinel'), 'preserve');
  })).rejects.toThrow();
  expect(readFileSync(path.join(workspace, 'node_modules', 'sentinel'), 'utf8')).toBe('preserve');
});

it.skipIf(process.platform !== 'darwin')('runs root lifecycle output after cloning instead of silently skipping setup', async () => {
  const { source, workspace } = fixture();
  const lifecycle = { scripts: { postinstall: 'fixture-generate' } };
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', ...lifecycle }));
  execFileSync('git', ['add', 'package.json'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'lifecycle'], { cwd: source });
  execFileSync('git', ['pull', '-q', '--ff-only'], { cwd: workspace });
  const run = vi.fn(async (invocation: { args: string[] }) => {
    expect(invocation.args).toEqual(['rebuild', '.']);
    writeFileSync(path.join(workspace, 'generated.txt'), 'workspace output\n');
  });
  const result = await materializeDependencyInstall(workspace, 'npm ci', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, run,
  });
  expect(result.receipt.source).toBe('directory-clone');
  expect(run).toHaveBeenCalledOnce();
  expect(readFileSync(path.join(workspace, 'generated.txt'), 'utf8')).toBe('workspace output\n');
});

it.skipIf(process.platform !== 'darwin')('privatizes source files even when the donor has external hardlinks', async () => {
  const { root, source, workspace } = fixture();
  linkSync(path.join(source, 'node_modules', 'tool.js'), path.join(root, 'shared'));
  const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
  });
  expect(result.receipt.source).toBe('directory-clone');
  writeFileSync(path.join(workspace, 'node_modules', 'tool.js'), 'worker');
  expect(readFileSync(path.join(root, 'shared'), 'utf8')).toBe('private\n');
});

it.skipIf(process.platform !== 'darwin').each(['clone-source', 'clone-receipted', 'clone-created'])(
  'refuses a replaced %s directory without writing into the replacement', async (step) => {
    const { source, workspace } = fixture();
    const identity = await captureWorktreeMaterializationIdentity(workspace);
    await expect(createPinnedWorkspaceBinding(workspace, identity, 'node_modules', {
      mode: 'clone-tree', source: path.join(source, 'node_modules'),
    }, async (segment) => {
      if (segment !== step) return;
      const target = path.join(step === 'clone-source' ? source : workspace, 'node_modules');
      renameSync(target, `${target}-admitted`);
      mkdirSync(target);
      writeFileSync(path.join(target, 'sentinel'), 'preserve\n');
    })).rejects.toThrow(/Pinned clone (source|target) changed/);
    const target = path.join(step === 'clone-source' ? source : workspace, 'node_modules');
    expect(readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('preserve\n');
  },
);

it('validates manifests without reading or walking package payloads', async () => {
  const { source, workspace } = fixture();
  const payload = path.join(source, 'node_modules/fixture/assets/deep');
  mkdirSync(payload, { recursive: true });
  writeFileSync(path.join(payload, 'payload.js'), 'payload must not be read');
  const io = await import('node:fs/promises');
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readdir;
  const visited: string[] = [];
  const spy = vi.mocked(io.readdir).mockImplementation(async (...args) => {
    visited.push(String(args[0]));
    if (String(args[0]).includes('/assets')) throw new Error('Dependency payload walk');
    return original(...args);
  });
  try {
    expect(await validateDependencyCloneGraph(source)).not.toBeNull();
    if (process.platform === 'darwin') {
      const result = await materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
        cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0', env: { O8_APFS_DEPENDENCY_IMAGES: '0' },
      });
      expect(result.receipt.source).toBe('directory-clone');
    }
    expect(visited.some((name) => name.includes('/assets'))).toBe(false);
  } finally { spy.mockImplementation(original); }
});

it.skipIf(process.platform !== 'darwin')('checks a manifest-declared native binding outside conventional build paths', async () => {
  const { source, workspace } = fixture();
  mkdirSync(path.join(source, 'node_modules/fixture/custom'));
  writeFileSync(path.join(source, 'node_modules/fixture/custom/fixture.node'), 'incompatible');
  writeFileSync(path.join(source, 'node_modules/fixture/package.json'), JSON.stringify({version:'1.0.0', main:'custom/fixture.node', bin:'../tool.js'}));
  const persistReceipt = vi.fn();
  const run = vi.fn(async () => { throw new Error('Unexpected installer fallback'); });
  await expect(materializeDependencyInstall(workspace, 'npm ci --ignore-scripts', {
    cloneSourceWorkspace: source, resolveVersion: async () => '11.8.0',
    env: { O8_APFS_DEPENDENCY_IMAGES: '0' }, persistReceipt, run,
  })).rejects.toThrow(/dlopen/);
  expect(persistReceipt).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
