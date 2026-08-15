import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { RepoRegistryEntry } from '@/lib/repos/types';
import { guardedWorkspaceInvocation } from '@/lib/worktree/materialization-execution';
import {
  assertWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity,
} from '@/lib/worktree/materialization-identity';
import {
  captureWorkspaceRegularFileIdentity,
  type WorkspaceCopyBindingRequirement,
} from './storage-verifier';
import { createExactChildDirectory } from './exact-parent-operation';

export interface RepoSetupCommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
}

export interface RepoSetupReceipt {
  recipeKey: string;
  install: {
    requested: boolean;
    commandId: string | null;
    packageManager: string | null;
    completed: boolean;
  };
  envBindings: Array<{
    relativePath: string;
    bindingId: string;
    mode: 'copy' | 'symlink';
  }>;
  completedAt: string;
}

export interface RepoSetupOptions {
  run?: (invocation: RepoSetupCommandInvocation) => Promise<void>;
  now?: () => Date;
  requiredCopyBindings?: Record<string, WorkspaceCopyBindingRequirement>;
  /** Deterministic race seam after destination capture and before pinned creation. */
  beforeBindingCreate?: (relativePath: string, parentPath: string) => Promise<void>;
  /** Deterministic race seam before missing destination ancestors are created. */
  beforeBindingParentPrepare?: (relativePath: string, workspacePath: string) => Promise<void>;
  /** Exact manager receipt held from restore publication through setup completion. */
  materializationIdentity?: WorktreeMaterializationIdentity;
}

interface PreparedBindingTarget {
  targetPath: string;
  targetName: string;
  parentPath: string;
  canonicalParentPath: string;
  parentDevice: number;
  parentInode: number;
}

interface CreatedBindingTarget {
  device: number;
  inode: number;
  kind: 'file' | 'symlink';
}

const PINNED_BINDING_CREATE_SCRIPT = String.raw`
const fs = require('node:fs');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Pinned repo setup input is missing: ' + name);
  return value;
}

function main() {
  const targetName = required('O8_BINDING_TARGET_NAME');
  if (targetName !== require('node:path').basename(targetName)) {
    throw new Error('Pinned repo setup target is not a leaf name.');
  }
  const parent = fs.lstatSync('.');
  const canonicalParent = fs.realpathSync('.');
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || parent.dev !== Number(required('O8_BINDING_PARENT_DEVICE'))
    || parent.ino !== Number(required('O8_BINDING_PARENT_INODE'))
    || canonicalParent !== required('O8_BINDING_PARENT_CANONICAL')) {
    throw new Error('Pinned repo setup destination parent identity changed.');
  }
  try {
    fs.lstatSync(targetName);
    throw new Error('Pinned repo setup destination already exists.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const mode = required('O8_BINDING_MODE');
  if (mode === 'symlink') {
    fs.symlinkSync(required('O8_BINDING_LINK_TARGET'), targetName);
  } else if (mode === 'copy') {
    const source = fs.openSync(
      required('O8_BINDING_SOURCE'),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    let target;
    try {
      const sourceStat = fs.fstatSync(source);
      if (!sourceStat.isFile()) throw new Error('Pinned repo setup source is not a regular file.');
      target = fs.openSync(
        targetName,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const bytes = fs.readFileSync(source);
      fs.writeFileSync(target, bytes);
      fs.fsyncSync(target);
    } finally {
      if (target !== undefined) fs.closeSync(target);
      fs.closeSync(source);
    }
  } else {
    throw new Error('Pinned repo setup mode is invalid.');
  }
  const created = fs.lstatSync(targetName);
  const kind = created.isSymbolicLink() ? 'symlink' : created.isFile() ? 'file' : 'other';
  if (kind === 'other') throw new Error('Pinned repo setup created an unsupported target.');
  process.stdout.write(JSON.stringify({ device: created.dev, inode: created.ino, kind }));
}

try {
  main();
} catch (error) {
  console.error('[repo-setup]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeRelativePath(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Unsafe repo setup path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function prepareBindingTarget(
  workspaceRoot: string,
  canonicalWorkspaceRoot: string,
  workspaceIdentity: WorktreeMaterializationIdentity,
  relativePath: string,
): Promise<PreparedBindingTarget> {
  const segments = relativePath.split('/');
  const targetName = segments.pop()!;
  let parent = workspaceRoot;
  let parentIdentity = workspaceIdentity;
  for (const segment of segments) {
    const nextParent = path.join(parent, segment);
    let entry;
    try {
      entry = await lstat(nextParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await createExactChildDirectory(parent, parentIdentity, nextParent);
      entry = await lstat(nextParent);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Repo setup destination has an unsafe ancestor: ${relativePath}`);
    }
    const canonicalParent = await realpath(nextParent);
    if (!pathInside(canonicalParent, canonicalWorkspaceRoot)) {
      throw new Error(`Repo setup destination escapes its workspace: ${relativePath}`);
    }
    parent = nextParent;
    parentIdentity = {
      device: entry.dev,
      inode: entry.ino,
      canonicalPath: canonicalParent,
    };
  }
  const target = path.join(parent, targetName);
  try {
    await lstat(target);
    throw new Error(`Repo setup destination already exists: ${relativePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const parentStat = await lstat(parent);
  const canonicalParentPath = await realpath(parent);
  if (!parentStat.isDirectory()
    || parentStat.isSymbolicLink()
    || !pathInside(canonicalParentPath, canonicalWorkspaceRoot)) {
    throw new Error(`Repo setup destination parent identity is unsafe: ${relativePath}`);
  }
  return {
    targetPath: target,
    targetName,
    parentPath: parent,
    canonicalParentPath,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
  };
}

function createPinnedBinding(
  prepared: PreparedBindingTarget,
  input: { mode: 'copy'; source: string } | { mode: 'symlink'; linkTarget: string },
): Promise<CreatedBindingTarget> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', PINNED_BINDING_CREATE_SCRIPT], {
      cwd: prepared.parentPath,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        O8_BINDING_TARGET_NAME: prepared.targetName,
        O8_BINDING_PARENT_DEVICE: String(prepared.parentDevice),
        O8_BINDING_PARENT_INODE: String(prepared.parentInode),
        O8_BINDING_PARENT_CANONICAL: prepared.canonicalParentPath,
        O8_BINDING_MODE: input.mode,
        ...(input.mode === 'copy'
          ? { O8_BINDING_SOURCE: input.source }
          : { O8_BINDING_LINK_TARGET: input.linkTarget }),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || 'Pinned repo setup destination creation failed.'));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as Partial<CreatedBindingTarget>;
        if (!Number.isSafeInteger(parsed.device)
          || !Number.isSafeInteger(parsed.inode)
          || (parsed.kind !== 'file' && parsed.kind !== 'symlink')) {
          throw new Error('Pinned repo setup returned an invalid target identity.');
        }
        resolve(parsed as CreatedBindingTarget);
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function verifyPinnedBindingTarget(
  prepared: PreparedBindingTarget,
  created: CreatedBindingTarget,
): Promise<void> {
  const [parent, canonicalParent, target] = await Promise.all([
    lstat(prepared.parentPath),
    realpath(prepared.parentPath),
    lstat(prepared.targetPath),
  ]);
  const targetKind = target.isSymbolicLink() ? 'symlink' : target.isFile() ? 'file' : 'other';
  if (!parent.isDirectory()
    || parent.isSymbolicLink()
    || parent.dev !== prepared.parentDevice
    || parent.ino !== prepared.parentInode
    || canonicalParent !== prepared.canonicalParentPath
    || target.dev !== created.device
    || target.ino !== created.inode
    || targetKind !== created.kind) {
    throw new Error('Repo setup destination ownership changed during pinned creation.');
  }
}

async function copyBindingFile(
  source: string,
  prepared: PreparedBindingTarget,
  requirement: WorkspaceCopyBindingRequirement,
): Promise<void> {
  if (!requirement.canonicalSourcePath
    || !requirement.sourceIdentityFingerprint
    || !requirement.sourceContentFingerprint) {
    throw new Error('Repo setup copied environment binding has no captured source identity.');
  }
  const before = await captureWorkspaceRegularFileIdentity(
    source,
    requirement.canonicalSourcePath,
  );
  if (before.identityFingerprint !== requirement.sourceIdentityFingerprint
    || before.contentFingerprint !== requirement.sourceContentFingerprint) {
    throw new Error('Repo setup copied environment source changed before copy.');
  }
  const created = await createPinnedBinding(prepared, {
    mode: 'copy',
    source: requirement.canonicalSourcePath,
  });
  await verifyPinnedBindingTarget(prepared, created);
  const [after, destination] = await Promise.all([
    captureWorkspaceRegularFileIdentity(source, requirement.canonicalSourcePath),
    captureWorkspaceRegularFileIdentity(prepared.targetPath),
  ]);
  if (after.identityFingerprint !== requirement.sourceIdentityFingerprint
    || after.contentFingerprint !== requirement.sourceContentFingerprint
    || destination.contentFingerprint !== requirement.sourceContentFingerprint) {
    throw new Error('Repo setup copied environment binding changed during copy.');
  }
}

function defaultRun(
  invocation: RepoSetupCommandInvocation,
  identity?: WorktreeMaterializationIdentity,
): Promise<void> {
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', invocation.command]
    : ['-lc', invocation.command];
  const guarded = guardedWorkspaceInvocation(shell, args, identity ?? null);
  return new Promise((resolve, reject) => {
    execFile(guarded.command, guarded.args, {
      cwd: invocation.cwd,
      timeout: invocation.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'development' },
    }, (error) => error ? reject(error) : resolve());
  });
}

export function repoSetupRecipeKey(repo: RepoRegistryEntry): string {
  return hashJson({
    repositoryUuid: repo.id,
    envMode: repo.setup.envMode,
    envFiles: repo.setup.envFiles.map((entry) => safeRelativePath(entry)).sort(),
    installOnCreateWorkspace: repo.setup.installOnCreateWorkspace,
    installCommandId: repo.setup.installCommand ? hashJson(repo.setup.installCommand) : null,
  });
}

export function repoSetupBoundRecipeKey(
  repo: RepoRegistryEntry,
  requiredCopyBindings: Record<string, WorkspaceCopyBindingRequirement>,
): string {
  if (repo.setup.envMode !== 'copy') return repoSetupRecipeKey(repo);
  const bindings = Object.entries(requiredCopyBindings)
    .map(([relativePath, requirement]) => ({
      relativePath,
      canonicalSourcePath: requirement.canonicalSourcePath,
      sourceIdentityFingerprint: requirement.sourceIdentityFingerprint,
      sourceContentFingerprint: requirement.sourceContentFingerprint,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return hashJson({ recipeKey: repoSetupRecipeKey(repo), copyBindings: bindings });
}

/** Capture the exact registered source identity copied environment files must retain. */
export async function repoSetupCopyBindingRequirements(
  repo: RepoRegistryEntry,
): Promise<Record<string, WorkspaceCopyBindingRequirement>> {
  if (repo.setup.envMode !== 'copy') return {};
  const resolvedRepo = path.resolve(repo.localPath);
  const canonicalRepo = await realpath(resolvedRepo);
  const requirements: Record<string, WorkspaceCopyBindingRequirement> = {};
  for (const configuredPath of repo.setup.envFiles) {
    const relativePath = safeRelativePath(configuredPath);
    const source = path.resolve(resolvedRepo, relativePath);
    let sourceStat;
    try {
      sourceStat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        requirements[relativePath] = {
          sourcePath: source,
          canonicalSourcePath: null,
          sourceIdentityFingerprint: null,
          sourceContentFingerprint: null,
        };
        continue;
      }
      throw error;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Repo setup copied environment source is not a regular file: ${relativePath}`);
    }
    const identity = await captureWorkspaceRegularFileIdentity(source);
    if (!pathInside(identity.canonicalPath, canonicalRepo)) {
      throw new Error(`Repo setup env binding escapes its registered repository: ${relativePath}`);
    }
    requirements[relativePath] = {
      sourcePath: source,
      canonicalSourcePath: identity.canonicalPath,
      sourceIdentityFingerprint: identity.identityFingerprint,
      sourceContentFingerprint: identity.contentFingerprint,
    };
  }
  return requirements;
}

export async function repoSetupExternalSymlinkAllowlist(
  repo: RepoRegistryEntry,
  workspacePath: string,
): Promise<Record<string, { target: string; canonicalTarget: string }>> {
  if (repo.setup.envMode !== 'symlink') return {};
  const resolvedRepo = path.resolve(repo.localPath);
  const canonicalRepo = await realpath(resolvedRepo);
  const resolvedWorkspace = path.resolve(workspacePath);
  const allowlist: Record<string, { target: string; canonicalTarget: string }> = {};
  for (const configuredPath of repo.setup.envFiles) {
    const relativePath = safeRelativePath(configuredPath);
    const source = path.resolve(resolvedRepo, relativePath);
    let sourceStat;
    try {
      sourceStat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
      throw new Error(`Repo setup env binding is not a file: ${relativePath}`);
    }
    const canonicalSource = await realpath(source);
    if (!pathInside(canonicalSource, canonicalRepo)) {
      throw new Error(`Repo setup env binding escapes its registered repository: ${relativePath}`);
    }
    allowlist[relativePath] = {
      target: path.relative(path.dirname(path.join(resolvedWorkspace, relativePath)), source),
      canonicalTarget: canonicalSource,
    };
  }
  return allowlist;
}

/** Run the saved repo setup contract without persisting command output or env contents. */
export async function runRegisteredRepoSetup(
  repo: RepoRegistryEntry,
  workspacePath: string,
  options: RepoSetupOptions = {},
): Promise<RepoSetupReceipt> {
  const resolvedRepo = path.resolve(repo.localPath);
  const resolvedWorkspace = path.resolve(workspacePath);
  const [canonicalRepo, canonicalWorkspace] = await Promise.all([
    realpath(resolvedRepo),
    realpath(resolvedWorkspace),
  ]);
  if (options.materializationIdentity) {
    await assertWorktreeMaterializationIdentity(
      resolvedWorkspace,
      options.materializationIdentity,
    );
  }
  const workspaceStat = await lstat(resolvedWorkspace);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error('Repo setup workspace is not an exact directory.');
  }
  const workspaceIdentity = options.materializationIdentity ?? {
    device: workspaceStat.dev,
    inode: workspaceStat.ino,
    canonicalPath: canonicalWorkspace,
  };
  const envBindings: RepoSetupReceipt['envBindings'] = [];
  const requiredCopyBindings = repo.setup.envMode === 'copy'
    ? options.requiredCopyBindings ?? await repoSetupCopyBindingRequirements(repo)
    : {};
  const recipeKey = repoSetupBoundRecipeKey(repo, requiredCopyBindings);

  if (repo.setup.envMode !== 'skip') {
    for (const configuredPath of repo.setup.envFiles) {
      const relativePath = safeRelativePath(configuredPath);
      const source = path.resolve(resolvedRepo, relativePath);
      const target = path.resolve(resolvedWorkspace, relativePath);
      if (!pathInside(source, resolvedRepo) || !pathInside(target, resolvedWorkspace)) {
        throw new Error(`Repo setup path escapes its workspace: ${relativePath}`);
      }
      let sourceStat;
      try {
        sourceStat = await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          const requirement = requiredCopyBindings[relativePath];
          if (repo.setup.envMode === 'copy' && requirement
            && requirement.canonicalSourcePath === null
            && requirement.sourceIdentityFingerprint === null
            && requirement.sourceContentFingerprint === null) continue;
        }
        throw error;
      }
      if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
        throw new Error(`Repo setup env binding is not a file: ${relativePath}`);
      }
      const sourceTarget = sourceStat.isSymbolicLink() ? await readlink(source) : null;
      const canonicalSource = await realpath(source);
      if (!pathInside(canonicalSource, canonicalRepo)) {
        throw new Error(`Repo setup env binding escapes its registered repository: ${relativePath}`);
      }
      const copyRequirement = requiredCopyBindings[relativePath];
      const bindingId = repo.setup.envMode === 'copy'
        ? copyRequirement?.sourceIdentityFingerprint ?? ''
        : hashJson({
            repositoryUuid: repo.id,
            relativePath,
            device: sourceStat.dev,
            inode: sourceStat.ino,
            size: sourceStat.size,
            modifiedAt: sourceStat.mtimeMs,
            sourceTarget,
          });
      if (!bindingId) throw new Error(`Repo setup copied environment binding was not captured: ${relativePath}`);
      await options.beforeBindingParentPrepare?.(relativePath, resolvedWorkspace);
      const prepared = await prepareBindingTarget(
        resolvedWorkspace,
        canonicalWorkspace,
        workspaceIdentity,
        relativePath,
      );
      await options.beforeBindingCreate?.(relativePath, prepared.parentPath);
      if (repo.setup.envMode === 'symlink') {
        const created = await createPinnedBinding(prepared, {
          mode: 'symlink',
          linkTarget: path.relative(prepared.parentPath, source),
        });
        await verifyPinnedBindingTarget(prepared, created);
      } else {
        await copyBindingFile(source, prepared, copyRequirement!);
      }
      envBindings.push({ relativePath, bindingId, mode: repo.setup.envMode });
    }
  }

  const installCommand = repo.setup.installOnCreateWorkspace
    ? repo.setup.installCommand?.trim() || null
    : null;
  if (repo.setup.installOnCreateWorkspace && !installCommand) {
    throw new Error('The registered repo requires install-on-create but has no install command.');
  }
  if (installCommand) {
    const invocation = {
      command: installCommand,
      args: [],
      cwd: resolvedWorkspace,
      timeoutMs: 45 * 60_000,
    };
    if (options.run) await options.run(invocation);
    else await defaultRun(invocation, options.materializationIdentity);
  }
  if (options.materializationIdentity) {
    await assertWorktreeMaterializationIdentity(
      resolvedWorkspace,
      options.materializationIdentity,
    );
  }
  return {
    recipeKey,
    install: {
      requested: Boolean(installCommand),
      commandId: installCommand ? hashJson(installCommand) : null,
      packageManager: installCommand?.split(/\s+/, 1)[0] ?? null,
      completed: Boolean(installCommand),
    },
    envBindings,
    completedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}
