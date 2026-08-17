import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  auditPrivateDependencyView,
  deriveDependencyInstallRecipe,
  type DependencyInstallOptions,
  type DependencyInstallReceipt,
  type DependencyInstallRecipe,
} from './dependency-install';

const PROHIBITED_SEGMENTS = new Set([
  '.next', 'Pods', 'DerivedData', '.venv', 'target', '.git', '.o8-install-runtime',
]);
const CREDENTIAL_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|credentials|auth\.json)$/i;
const CREDENTIAL_SUFFIXES = /\.(?:pem|key|p12|pfx)$/i;

export interface DependencyImageSourceReceipt {
  version: 1;
  receiptId: string;
  recipeKey: string;
  workspacePath: string;
  workspaceDevice: number;
  workspaceInode: number;
  sourcePath: string;
  sourceDevice: number;
  sourceInode: number;
  treeDigest: string;
}

export interface DependencyImageManifest {
  version: 1;
  recipeKey: string;
  generation: string;
  treeDigest: string;
  imageDigest: string;
}

interface DependencyImageSourceOptions {
  registryRoot?: string;
  resolveVersion?: DependencyInstallOptions['resolveVersion'];
}

export class DependencyImageRefusalError extends Error {
  readonly code = 'dependency_image_refused';

  constructor(message: string) {
    super(message);
    this.name = 'DependencyImageRefusalError';
  }
}

export function dependencyPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function digestDependencyTree(root: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const hash = createHash('sha256');
  async function walk(candidate: string, relative: string): Promise<void> {
    const entry = await lstat(candidate);
    const normalized = relative.replaceAll(path.sep, '/');
    const name = path.basename(candidate);
    if (PROHIBITED_SEGMENTS.has(name)
      || CREDENTIAL_NAMES.test(name)
      || CREDENTIAL_SUFFIXES.test(name)) {
      throw new DependencyImageRefusalError(`Dependency image contains prohibited output: ${normalized}`);
    }
    hash.update(normalized);
    hash.update('\0');
    hash.update(String(entry.mode & 0o777));
    hash.update('\0');
    if (entry.isSymbolicLink()) {
      const targetText = await readlink(candidate);
      const target = await realpath(candidate);
      if (path.isAbsolute(targetText) || !dependencyPathInside(target, canonicalRoot)) {
        throw new DependencyImageRefusalError(`Dependency image link escapes its tree: ${normalized}`);
      }
      hash.update('link\0');
      hash.update(targetText);
      const after = await lstat(candidate);
      if (!after.isSymbolicLink() || after.dev !== entry.dev || after.ino !== entry.ino
        || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs) {
        throw new DependencyImageRefusalError(`Dependency image source changed during validation: ${normalized}`);
      }
      return;
    }
    if (entry.isFile()) {
      if (entry.nlink !== 1) {
        throw new DependencyImageRefusalError(`Dependency image contains a shared hardlink: ${normalized}`);
      }
      hash.update('file\0');
      hash.update(await readFile(candidate));
      const after = await lstat(candidate);
      if (after.dev !== entry.dev || after.ino !== entry.ino || after.size !== entry.size
        || after.mode !== entry.mode || after.nlink !== entry.nlink
        || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs) {
        throw new DependencyImageRefusalError(`Dependency image source changed during validation: ${normalized}`);
      }
      return;
    }
    if (!entry.isDirectory()) {
      throw new DependencyImageRefusalError(`Dependency image contains an unsupported entry: ${normalized}`);
    }
    hash.update('dir\0');
    const children = (await readdir(candidate)).sort();
    for (const child of children) {
      await walk(path.join(candidate, child), relative ? path.join(relative, child) : child);
    }
    const [after, afterChildren] = await Promise.all([lstat(candidate), readdir(candidate)]);
    if (!after.isDirectory() || after.isSymbolicLink()
      || after.dev !== entry.dev || after.ino !== entry.ino || after.mode !== entry.mode
      || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs
      || afterChildren.sort().join('\0') !== children.join('\0')) {
      throw new DependencyImageRefusalError(`Dependency image source changed during validation: ${normalized}`);
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}

function assertEligibleRecipe(recipe: DependencyInstallRecipe): void {
  if (recipe.packageManager !== 'npm'
    || recipe.lockfile.path !== 'package-lock.json'
    || recipe.lifecycleScripts !== 'disabled'
    || recipe.localDependencyDigests.length !== 0
    || recipe.installArgs.includes('--workspaces')) {
    throw new DependencyImageRefusalError(
      'The APFS dependency image pilot requires npm, package-lock.json, disabled lifecycle scripts, and no local or workspace dependencies.',
    );
  }
}

export async function rederiveDependencyImageRecipeAuthority(
  workspacePath: string,
  installCommand: string,
  expected: DependencyInstallRecipe,
  options: DependencyImageSourceOptions,
): Promise<void> {
  assertEligibleRecipe(expected);
  const recipe = await deriveDependencyInstallRecipe(workspacePath, installCommand, {
    resolveVersion: options.resolveVersion,
  });
  if (recipe.key !== expected.key) {
    throw new DependencyImageRefusalError('Dependency image recipe drifted from its install receipt.');
  }
}

export async function captureDependencyImageSourceReceipt(
  workspacePath: string,
  installCommand: string,
  receipt: DependencyInstallReceipt,
  options: DependencyImageSourceOptions = {},
): Promise<DependencyImageSourceReceipt> {
  if (process.platform !== 'darwin') {
    throw new DependencyImageRefusalError('APFS dependency images are only available on macOS.');
  }
  if (!receipt.privateViewVerified) {
    throw new DependencyImageRefusalError('Dependency install receipt has no verified private view.');
  }
  const workspacePathResolved = path.resolve(workspacePath);
  await rederiveDependencyImageRecipeAuthority(
    workspacePathResolved, installCommand, receipt.recipe, options,
  );
  await auditPrivateDependencyView(workspacePathResolved);
  const sourcePath = path.join(workspacePathResolved, 'node_modules');
  const [workspace, source, canonicalWorkspace, canonicalSource] = await Promise.all([
    lstat(workspacePathResolved), lstat(sourcePath),
    realpath(workspacePathResolved), realpath(sourcePath),
  ]);
  if (!workspace.isDirectory() || workspace.isSymbolicLink()
    || !source.isDirectory() || source.isSymbolicLink()
    || !dependencyPathInside(canonicalSource, canonicalWorkspace)) {
    throw new DependencyImageRefusalError('Dependency image source is not an exact workspace directory.');
  }
  const treeDigest = await digestDependencyTree(sourcePath);
  const [workspaceAfter, sourceAfter] = await Promise.all([
    lstat(workspacePathResolved), lstat(sourcePath),
  ]);
  if (workspaceAfter.dev !== workspace.dev || workspaceAfter.ino !== workspace.ino
    || sourceAfter.dev !== source.dev || sourceAfter.ino !== source.ino) {
    throw new DependencyImageRefusalError('Dependency image source identity changed during capture.');
  }
  return {
    version: 1,
    receiptId: randomUUID(),
    recipeKey: receipt.recipe.key,
    workspacePath: workspacePathResolved,
    workspaceDevice: workspace.dev,
    workspaceInode: workspace.ino,
    sourcePath,
    sourceDevice: source.dev,
    sourceInode: source.ino,
    treeDigest,
  };
}

export function assertDependencyImageSourceReceipt(receipt: DependencyImageSourceReceipt): void {
  if (Object.keys(receipt).sort().join(',') !== [
    'receiptId', 'recipeKey', 'sourceDevice', 'sourceInode', 'sourcePath',
    'treeDigest', 'version', 'workspaceDevice', 'workspaceInode', 'workspacePath',
  ].sort().join(',')
    || receipt.version !== 1
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.receiptId)
    || !/^[0-9a-f]{64}$/.test(receipt.recipeKey)
    || !/^[0-9a-f]{64}$/.test(receipt.treeDigest)
    || path.resolve(receipt.workspacePath) !== receipt.workspacePath
    || path.resolve(receipt.sourcePath) !== receipt.sourcePath
    || receipt.sourcePath !== path.join(receipt.workspacePath, 'node_modules')
    || !Number.isSafeInteger(receipt.workspaceDevice)
    || !Number.isSafeInteger(receipt.workspaceInode)
    || !Number.isSafeInteger(receipt.sourceDevice)
    || !Number.isSafeInteger(receipt.sourceInode)
    || receipt.workspaceDevice <= 0 || receipt.workspaceInode <= 0
    || receipt.sourceDevice <= 0 || receipt.sourceInode <= 0) {
    throw new DependencyImageRefusalError('Dependency image source receipt is not canonical.');
  }
}

export async function assertCurrentDependencyImageSource(
  receipt: DependencyImageSourceReceipt,
): Promise<void> {
  const [workspace, source] = await Promise.all([
    lstat(receipt.workspacePath), lstat(receipt.sourcePath),
  ]);
  if (!workspace.isDirectory() || workspace.isSymbolicLink()
    || workspace.dev !== receipt.workspaceDevice || workspace.ino !== receipt.workspaceInode
    || !source.isDirectory() || source.isSymbolicLink()
    || source.dev !== receipt.sourceDevice || source.ino !== receipt.sourceInode
    || await digestDependencyTree(receipt.sourcePath) !== receipt.treeDigest) {
    throw new DependencyImageRefusalError(
      'Dependency image source changed after its trusted install-time receipt.',
    );
  }
}
