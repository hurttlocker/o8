import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export type WorkspaceVerificationState = 'verified_clean' | 'dirty' | 'unknown';

export type WorkspaceVerificationReason =
  | 'staged_change'
  | 'unstaged_change'
  | 'untracked_path'
  | 'ignored_path'
  | 'hidden_index_flag'
  | 'submodule_requires_recursive_verification'
  | 'nested_repository'
  | 'absolute_symlink'
  | 'escaping_symlink'
  | 'special_filesystem_node'
  | 'copy_binding_mismatch'
  | 'unreadable_path'
  | 'scan_bound_exceeded'
  | 'git_error'
  | 'unsafe_workspace_path'
  | 'scan_changed';

export interface WorkspaceVerificationFinding {
  reason: WorkspaceVerificationReason;
  path?: string;
  detail: string;
}

export interface WorkspaceSymlinkReceipt {
  path: string;
  target: string;
  disposition: 'internal' | 'declared_external' | 'absolute' | 'escaping';
}

export interface WorkspaceScanReceipt {
  state: WorkspaceVerificationState;
  workspacePath: string;
  canonicalWorkspacePath: string | null;
  fingerprint: string;
  scannedEntries: number;
  scannedRebuildableEntries: number;
  findings: WorkspaceVerificationFinding[];
  symlinks: WorkspaceSymlinkReceipt[];
  scannedAt: string;
}

export interface WorkspaceScanComparisonReceipt {
  state: WorkspaceVerificationState;
  identical: boolean;
  firstFingerprint: string;
  secondFingerprint: string;
  findings: WorkspaceVerificationFinding[];
  comparedAt: string;
}

export interface WorkspaceRegularFileIdentity {
  canonicalPath: string;
  identityFingerprint: string;
  nodeFingerprint: string;
  contentFingerprint: string;
}

export interface WorkspaceCopyBindingRequirement {
  sourcePath: string;
  canonicalSourcePath: string | null;
  sourceIdentityFingerprint: string | null;
  sourceContentFingerprint: string | null;
}

interface GitCommandResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export interface WorkspaceStorageVerifierOptions {
  maxEntries?: number;
  maxRebuildableEntries?: number;
  maxDurationMs?: number;
  allowedIgnoredPaths?: string[];
  allowedExternalSymlinks?: Record<string, {
    target: string;
    canonicalTarget: string;
  }>;
  requiredCopyBindings?: Record<string, WorkspaceCopyBindingRequirement>;
  runGit?: (args: string[], cwd: string) => Promise<GitCommandResult>;
  fs?: {
    lstat: typeof lstat;
    readdir: typeof readdir;
    readlink: typeof readlink;
    realpath: typeof realpath;
  };
  now?: () => Date;
}

interface FingerprintEntry {
  path: string;
  kind: string;
  mode?: number;
  size?: number;
  modifiedAt?: number;
  changedAt?: number;
  device?: number;
  inode?: number;
  target?: string;
}

const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_MAX_REBUILDABLE_ENTRIES = 2_000_000;
const DEFAULT_MAX_DURATION_MS = 10_000;
const MAX_COPY_BINDING_BYTES = 16 * 1024 * 1024;

function text(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function compact(value: unknown): string {
  if (value instanceof Error) return value.message.replace(/\s+/g, ' ').slice(0, 500);
  return String(value).replace(/\s+/g, ' ').slice(0, 500);
}

function defaultRunGit(args: string[], cwd: string): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'buffer',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 10_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        Object.assign(error, { stdout, stderr });
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalizeRelativePath(value: string): string | null {
  const normalized = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '..')) return null;
  return normalized;
}

function normalizeAllowedPaths(paths: string[] | undefined): string[] {
  return (paths ?? [])
    .map(normalizeRelativePath)
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeAllowedExternalSymlinks(
  entries: WorkspaceStorageVerifierOptions['allowedExternalSymlinks'],
): Map<string, { target: string; canonicalTarget: string }> {
  const normalized = new Map<string, { target: string; canonicalTarget: string }>();
  for (const [relativePath, binding] of Object.entries(entries ?? {})) {
    const key = normalizeRelativePath(relativePath);
    if (!key || path.isAbsolute(binding.target) || !path.isAbsolute(binding.canonicalTarget)) continue;
    normalized.set(key, {
      target: binding.target,
      canonicalTarget: path.resolve(binding.canonicalTarget),
    });
  }
  return normalized;
}

function pathAllowed(relativePath: string, allowed: string[]): boolean {
  return allowed.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseStatus(
  raw: string,
  allowedIgnored: string[],
): { findings: WorkspaceVerificationFinding[]; fingerprint: string[]; allowedIgnoredObserved: string[] } {
  const findings: WorkspaceVerificationFinding[] = [];
  const fingerprint: string[] = [];
  const allowedIgnoredObserved: string[] = [];
  const records = raw.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 3 || record[2] !== ' ') {
      findings.push({ reason: 'git_error', detail: 'Git returned malformed porcelain status.' });
      fingerprint.push(`malformed:${record}`);
      continue;
    }
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const rawPath = record.slice(3);
    const relativePath = normalizeRelativePath(rawPath);
    if (!relativePath) {
      findings.push({ reason: 'git_error', detail: 'Git returned an unsafe status path.' });
      fingerprint.push(`unsafe:${record}`);
      continue;
    }
    fingerprint.push(`${indexStatus}${worktreeStatus}:${relativePath}`);

    if (indexStatus === '?' && worktreeStatus === '?') {
      findings.push({ reason: 'untracked_path', path: relativePath, detail: 'Untracked path is not protected by Git.' });
      continue;
    }
    if (indexStatus === '!' && worktreeStatus === '!') {
      if (!pathAllowed(relativePath, allowedIgnored)) {
        findings.push({ reason: 'ignored_path', path: relativePath, detail: 'Ignored path was not declared rebuildable.' });
      } else {
        allowedIgnoredObserved.push(relativePath);
      }
      continue;
    }
    if (indexStatus !== ' ') {
      findings.push({ reason: 'staged_change', path: relativePath, detail: `Git index status is ${indexStatus}.` });
    }
    if (worktreeStatus !== ' ') {
      findings.push({ reason: 'unstaged_change', path: relativePath, detail: `Git worktree status is ${worktreeStatus}.` });
    }
    if (indexStatus === 'R' || indexStatus === 'C') {
      const originalPath = records[index + 1];
      if (originalPath) {
        fingerprint.push(`source:${originalPath}`);
        index += 1;
      }
    }
  }
  return { findings, fingerprint, allowedIgnoredObserved };
}

function parseIndexFlags(raw: string): {
  findings: WorkspaceVerificationFinding[];
  fingerprint: string[];
} {
  const findings: WorkspaceVerificationFinding[] = [];
  const fingerprint: string[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const marker = record[0] ?? '';
    const relativePath = normalizeRelativePath(record.slice(2));
    if (!marker || record[1] !== ' ' || !relativePath) {
      findings.push({ reason: 'git_error', detail: 'Git returned malformed index-flag output.' });
      fingerprint.push(`malformed:${record}`);
      continue;
    }
    fingerprint.push(`${marker}:${relativePath}`);
    const assumeUnchanged = /^[a-z]$/.test(marker);
    const skipWorktree = marker.toUpperCase() === 'S';
    if (assumeUnchanged || skipWorktree) {
      const flags = [assumeUnchanged ? 'assume-unchanged' : '', skipWorktree ? 'skip-worktree' : '']
        .filter(Boolean)
        .join(' and ');
      findings.push({
        reason: 'hidden_index_flag',
        path: relativePath,
        detail: `Git index marks this path ${flags}.`,
      });
    }
  }
  return { findings, fingerprint };
}

function parseSubmodules(raw: string): {
  paths: Set<string>;
  findings: WorkspaceVerificationFinding[];
  fingerprint: string[];
} {
  const paths = new Set<string>();
  const findings: WorkspaceVerificationFinding[] = [];
  const fingerprint: string[] = [];
  for (const record of raw.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) {
      findings.push({ reason: 'git_error', detail: 'Git returned malformed staged-file output.' });
      fingerprint.push(`malformed:${record}`);
      continue;
    }
    const metadata = record.slice(0, tab).split(' ');
    const relativePath = normalizeRelativePath(record.slice(tab + 1));
    if (!relativePath || metadata.length < 3) {
      findings.push({ reason: 'git_error', detail: 'Git returned an unsafe staged-file path.' });
      fingerprint.push(`unsafe:${record}`);
      continue;
    }
    if (metadata[0] !== '160000') continue;
    paths.add(relativePath);
    fingerprint.push(`submodule:${relativePath}:${metadata[1] ?? ''}`);
    findings.push({
      reason: 'submodule_requires_recursive_verification',
      path: relativePath,
      detail: 'Tracked submodule state requires a separate recursive proof before parking.',
    });
  }
  return { paths, findings, fingerprint };
}

function findingState(findings: WorkspaceVerificationFinding[]): WorkspaceVerificationState {
  const unknownReasons = new Set<WorkspaceVerificationReason>([
    'submodule_requires_recursive_verification',
    'unreadable_path',
    'scan_bound_exceeded',
    'git_error',
    'unsafe_workspace_path',
    'scan_changed',
  ]);
  if (findings.some((finding) => unknownReasons.has(finding.reason))) return 'unknown';
  return findings.length > 0 ? 'dirty' : 'verified_clean';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sameOpenedFileStat(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

/**
 * Read one regular file without following its final path component, and fail if
 * its path or inode changes while it is being hashed. The returned hashes are
 * in-memory verification material; callers must not log environment contents.
 */
export async function captureWorkspaceRegularFileIdentity(
  filePath: string,
  expectedCanonicalPath?: string,
): Promise<WorkspaceRegularFileIdentity> {
  const resolvedPath = path.resolve(filePath);
  const canonicalBefore = await realpath(resolvedPath);
  if (expectedCanonicalPath && canonicalBefore !== path.resolve(expectedCanonicalPath)) {
    throw new Error('Regular-file verification path changed from its registered canonical path.');
  }
  const handle = await open(canonicalBefore, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Regular-file verification requires a regular file.');
    if (before.size > MAX_COPY_BINDING_BYTES) {
      throw new Error(`Regular-file verification exceeds ${MAX_COPY_BINDING_BYTES} bytes.`);
    }
    const contentHash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) throw new Error('Regular-file verification ended before the recorded file size.');
      contentHash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (!sameOpenedFileStat(before, after)) {
      throw new Error('Regular-file verification observed an in-place file change.');
    }
    const [canonicalAfter, currentPathStat] = await Promise.all([
      realpath(resolvedPath),
      lstat(canonicalBefore),
    ]);
    if (canonicalAfter !== canonicalBefore
      || currentPathStat.isSymbolicLink()
      || currentPathStat.dev !== after.dev
      || currentPathStat.ino !== after.ino) {
      throw new Error('Regular-file verification observed a path identity change.');
    }
    const contentFingerprint = contentHash.digest('hex');
    const nodeFingerprint = fingerprint({
      device: after.dev,
      inode: after.ino,
      mode: after.mode,
      size: after.size,
      modifiedAt: after.mtimeMs,
      changedAt: after.ctimeMs,
      contentFingerprint,
    });
    return {
      canonicalPath: canonicalBefore,
      contentFingerprint,
      nodeFingerprint,
      identityFingerprint: fingerprint({
        canonicalPath: canonicalBefore,
        nodeFingerprint,
      }),
    };
  } finally {
    await handle.close();
  }
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

async function verifyRequiredCopyBindings(
  canonicalWorkspacePath: string,
  requirements: WorkspaceStorageVerifierOptions['requiredCopyBindings'],
): Promise<{
  findings: WorkspaceVerificationFinding[];
  fingerprintEntries: string[];
}> {
  const findings: WorkspaceVerificationFinding[] = [];
  const fingerprintEntries: string[] = [];
  for (const [configuredPath, requirement] of Object.entries(requirements ?? {})) {
    const relativePath = normalizeRelativePath(configuredPath);
    if (!relativePath || !path.isAbsolute(requirement.sourcePath)) {
      findings.push({
        reason: 'unreadable_path',
        path: relativePath ?? configuredPath,
        detail: 'Configured copied environment binding has unsafe verification metadata.',
      });
      continue;
    }
    const expectedAbsent = requirement.canonicalSourcePath === null
      && requirement.sourceIdentityFingerprint === null
      && requirement.sourceContentFingerprint === null;
    const expectedPresent = requirement.canonicalSourcePath !== null
      && requirement.sourceIdentityFingerprint !== null
      && requirement.sourceContentFingerprint !== null;
    if (!expectedAbsent && !expectedPresent) {
      findings.push({
        reason: 'unreadable_path',
        path: relativePath,
        detail: 'Configured copied environment binding has incomplete verification metadata.',
      });
      continue;
    }
    const destinationPath = path.join(canonicalWorkspacePath, ...relativePath.split('/'));
    if (expectedAbsent) {
      let sourceAbsent = false;
      let destinationAbsent = false;
      try {
        await captureWorkspaceRegularFileIdentity(requirement.sourcePath);
      } catch (error) {
        if (isMissingPath(error)) sourceAbsent = true;
        else {
          findings.push({ reason: 'unreadable_path', path: relativePath, detail: 'Configured copied environment source could not be verified absent.' });
        }
      }
      try {
        await captureWorkspaceRegularFileIdentity(destinationPath);
      } catch (error) {
        if (isMissingPath(error)) destinationAbsent = true;
        else {
          findings.push({ reason: 'unreadable_path', path: relativePath, detail: 'Configured copied environment destination could not be verified absent.' });
        }
      }
      if (!sourceAbsent || !destinationAbsent) {
        findings.push({
          reason: 'copy_binding_mismatch',
          path: relativePath,
          detail: 'Configured copied environment binding changed from its registered absent state.',
        });
      }
      fingerprintEntries.push(`${relativePath}:absent:${sourceAbsent}:${destinationAbsent}`);
      continue;
    }

    let source: WorkspaceRegularFileIdentity;
    let destination: WorkspaceRegularFileIdentity;
    try {
      source = await captureWorkspaceRegularFileIdentity(
        requirement.sourcePath,
        requirement.canonicalSourcePath!,
      );
    } catch (error) {
      findings.push({
        reason: 'unreadable_path',
        path: relativePath,
        detail: `Configured copied environment source could not be verified: ${compact(error)}`,
      });
      continue;
    }
    try {
      destination = await captureWorkspaceRegularFileIdentity(destinationPath, destinationPath);
    } catch (error) {
      if (isMissingPath(error)) {
        findings.push({
          reason: 'copy_binding_mismatch',
          path: relativePath,
          detail: 'Configured copied environment destination is missing.',
        });
      } else {
        findings.push({
          reason: 'unreadable_path',
          path: relativePath,
          detail: `Configured copied environment destination could not be verified: ${compact(error)}`,
        });
      }
      continue;
    }
    fingerprintEntries.push(`${relativePath}:${source.identityFingerprint}:${destination.nodeFingerprint}`);
    if (source.identityFingerprint !== requirement.sourceIdentityFingerprint
      || source.contentFingerprint !== requirement.sourceContentFingerprint) {
      findings.push({
        reason: 'copy_binding_mismatch',
        path: relativePath,
        detail: 'Configured copied environment source changed after it was bound to this snapshot attempt.',
      });
    }
    if (destination.contentFingerprint !== source.contentFingerprint) {
      findings.push({
        reason: 'copy_binding_mismatch',
        path: relativePath,
        detail: 'Configured copied environment destination differs from its registered source.',
      });
    }
  }
  return { findings, fingerprintEntries };
}

export async function scanWorkspaceStorageState(
  workspacePath: string,
  options: WorkspaceStorageVerifierOptions = {},
): Promise<WorkspaceScanReceipt> {
  const now = options.now ?? (() => new Date());
  const scannedAt = now().toISOString();
  const resolvedWorkspace = path.resolve(workspacePath);
  const fs = options.fs ?? { lstat, readdir, readlink, realpath };
  const findings: WorkspaceVerificationFinding[] = [];
  const symlinks: WorkspaceSymlinkReceipt[] = [];
  const entries: FingerprintEntry[] = [];
  const gitFingerprint: string[] = [];
  const copyBindingFingerprint: string[] = [];
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxRebuildableEntries = options.maxRebuildableEntries ?? DEFAULT_MAX_REBUILDABLE_ENTRIES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const allowedIgnored = normalizeAllowedPaths(options.allowedIgnoredPaths);
  const allowedExternalSymlinks = normalizeAllowedExternalSymlinks(
    options.allowedExternalSymlinks,
  );
  const startedAt = Date.now();
  let canonicalWorkspacePath: string | null = null;
  let scannedEntries = 0;
  let scannedRebuildableEntries = 0;
  const rebuildableCounts = new Map<string, number>();
  let observedIgnoredPaths: string[] = [];

  if (!workspacePath.trim() || resolvedWorkspace === path.parse(resolvedWorkspace).root) {
    findings.push({ reason: 'unsafe_workspace_path', detail: `Refused workspace path ${JSON.stringify(resolvedWorkspace)}.` });
  } else {
    try {
      const rootStat = await fs.lstat(resolvedWorkspace);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        findings.push({ reason: 'unsafe_workspace_path', detail: 'Workspace root must be a real directory.' });
      } else {
        canonicalWorkspacePath = await fs.realpath(resolvedWorkspace);
      }
    } catch (error) {
      findings.push({ reason: 'unreadable_path', path: '.', detail: compact(error) });
    }
  }

  let submodulePaths = new Set<string>();
  if (canonicalWorkspacePath) {
    const runGit = options.runGit ?? defaultRunGit;
    try {
      const [statusResult, flagsResult, stagedResult] = await Promise.all([
        runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'], canonicalWorkspacePath),
        runGit(['ls-files', '-v', '-z'], canonicalWorkspacePath),
        runGit(['ls-files', '--stage', '-z'], canonicalWorkspacePath),
      ]);
      for (const result of [statusResult, flagsResult, stagedResult]) {
        const stderr = text(result.stderr).trim();
        if (stderr) findings.push({ reason: 'git_error', detail: `Git reported: ${stderr.slice(0, 500)}` });
      }
      const status = parseStatus(text(statusResult.stdout), allowedIgnored);
      const flags = parseIndexFlags(text(flagsResult.stdout));
      const submodules = parseSubmodules(text(stagedResult.stdout));
      findings.push(...status.findings, ...flags.findings, ...submodules.findings);
      gitFingerprint.push(...status.fingerprint, ...flags.fingerprint, ...submodules.fingerprint);
      observedIgnoredPaths = status.allowedIgnoredObserved;
      submodulePaths = submodules.paths;
    } catch (error) {
      const stderr = text((error as { stderr?: string | Buffer })?.stderr).trim();
      findings.push({ reason: 'git_error', detail: stderr || compact(error) });
    }
  }

  if (canonicalWorkspacePath) {
    const copyBindings = await verifyRequiredCopyBindings(
      canonicalWorkspacePath,
      options.requiredCopyBindings,
    );
    findings.push(...copyBindings.findings);
    copyBindingFingerprint.push(...copyBindings.fingerprintEntries);
  }

  if (canonicalWorkspacePath) {
    const pending: Array<{ path: string; rebuildableRoot: string | null }> = [{ path: '.', rebuildableRoot: null }];
    let scanAborted = false;
    while (pending.length > 0) {
      if (scanAborted) break;
      if (scannedEntries >= maxEntries) {
        findings.push({ reason: 'scan_bound_exceeded', detail: `Filesystem scan exceeded ${maxEntries} entries.` });
        break;
      }
      if (Date.now() - startedAt > maxDurationMs) {
        findings.push({ reason: 'scan_bound_exceeded', detail: `Filesystem scan exceeded ${maxDurationMs} ms.` });
        break;
      }
      const pendingDirectory = pending.pop()!;
      const relativeDirectory = pendingDirectory.path;
      const absoluteDirectory = relativeDirectory === '.'
        ? canonicalWorkspacePath
        : path.join(canonicalWorkspacePath, relativeDirectory);
      let children: Awaited<ReturnType<typeof readdir>>;
      try {
        children = await fs.readdir(absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        findings.push({ reason: 'unreadable_path', path: relativeDirectory, detail: compact(error) });
        continue;
      }

      for (const child of children) {
        const relativePath = relativeDirectory === '.'
          ? child.name
          : path.posix.join(relativeDirectory, child.name);
        if (relativePath === '.git') continue;
        const declaredRoot = allowedIgnored.find((allowedPath) => (
          relativePath === allowedPath
          && observedIgnoredPaths.some((observed) => observed === allowedPath || observed.startsWith(`${allowedPath}/`))
        ));
        const rebuildableRoot = pendingDirectory.rebuildableRoot ?? declaredRoot ?? null;
        if (rebuildableRoot) {
          scannedRebuildableEntries += 1;
          rebuildableCounts.set(rebuildableRoot, (rebuildableCounts.get(rebuildableRoot) ?? 0) + 1);
          if (scannedRebuildableEntries > maxRebuildableEntries) {
            findings.push({
              reason: 'scan_bound_exceeded',
              path: rebuildableRoot,
              detail: `Rebuildable-tree structural scan exceeded ${maxRebuildableEntries} entries.`,
            });
            scanAborted = true;
            break;
          }
          // Ordinary files under a declared ignored root are disposable. A
          // Dirent proves their node type, so per-file lstat/fingerprinting is
          // unnecessary and makes real dependency trees hit the source-work
          // budget. Directories, links, unknown node types, and .git markers
          // still take the full structural safety path below.
          if (child.isFile() && child.name !== '.git') {
            if (scannedRebuildableEntries % 2_048 === 0 && Date.now() - startedAt > maxDurationMs) {
              findings.push({ reason: 'scan_bound_exceeded', path: rebuildableRoot, detail: `Filesystem scan exceeded ${maxDurationMs} ms.` });
              scanAborted = true;
              break;
            }
            continue;
          }
        } else {
          if (scannedEntries >= maxEntries) {
            findings.push({ reason: 'scan_bound_exceeded', detail: `Filesystem scan exceeded ${maxEntries} entries.` });
            scanAborted = true;
            break;
          }
          scannedEntries += 1;
        }
        const absolutePath = path.join(canonicalWorkspacePath, ...relativePath.split('/'));
        try {
          const stat = await fs.lstat(absolutePath);
          const base: FingerprintEntry = {
            path: relativePath,
            kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special',
            mode: stat.mode,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
            changedAt: stat.ctimeMs,
            device: stat.dev,
            inode: stat.ino,
          };
          const nestedGitMarker = child.name === '.git';
          if (nestedGitMarker) {
            const nestedRoot = relativePath.slice(0, -'/.git'.length);
            if (!submodulePaths.has(nestedRoot)) {
              findings.push({ reason: 'nested_repository', path: nestedRoot, detail: 'Nested Git metadata is not a tracked submodule.' });
            }
          }
          if (stat.isSymbolicLink()) {
            const target = await fs.readlink(absolutePath);
            base.target = target;
            const absoluteTarget = path.isAbsolute(target);
            const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
            let disposition: WorkspaceSymlinkReceipt['disposition'] = absoluteTarget
              ? 'absolute'
              : pathInside(resolvedTarget, canonicalWorkspacePath) ? 'internal' : 'escaping';
            const expectedExternalTarget = allowedExternalSymlinks.get(relativePath);
            if (!absoluteTarget && expectedExternalTarget?.target === target) {
              const canonicalTarget = await fs.realpath(expectedExternalTarget.canonicalTarget);
              if (canonicalTarget === expectedExternalTarget.canonicalTarget) {
                disposition = 'declared_external';
              }
            }
            symlinks.push({ path: relativePath, target, disposition });
            if (disposition === 'absolute') {
              findings.push({ reason: 'absolute_symlink', path: relativePath, detail: `Symlink target is absolute: ${target}` });
            } else if (disposition === 'escaping') {
              findings.push({ reason: 'escaping_symlink', path: relativePath, detail: `Symlink target escapes the workspace: ${target}` });
            }
          } else if (stat.isDirectory()) {
            if (!nestedGitMarker) pending.push({ path: relativePath, rebuildableRoot });
          } else if (!stat.isFile()) {
            findings.push({ reason: 'special_filesystem_node', path: relativePath, detail: 'Workspace contains a socket, device, or other special node.' });
          }
          entries.push(base);
        } catch (error) {
          findings.push({ reason: 'unreadable_path', path: relativePath, detail: compact(error) });
        }
      }
    }
  }

  findings.sort((left, right) => `${left.reason}:${left.path ?? ''}`.localeCompare(`${right.reason}:${right.path ?? ''}`));
  symlinks.sort((left, right) => left.path.localeCompare(right.path));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  gitFingerprint.sort();
  const rebuildableFingerprint = [...rebuildableCounts.entries()].sort(([left], [right]) => left.localeCompare(right));
  const state = findingState(findings);
  return {
    state,
    workspacePath: resolvedWorkspace,
    canonicalWorkspacePath,
    fingerprint: fingerprint({
      state,
      findings,
      symlinks,
      entries,
      gitFingerprint,
      rebuildableFingerprint,
      copyBindingFingerprint,
    }),
    scannedEntries,
    scannedRebuildableEntries,
    findings,
    symlinks,
    scannedAt,
  };
}

export function compareWorkspaceStorageScans(
  first: WorkspaceScanReceipt,
  second: WorkspaceScanReceipt,
  now: () => Date = () => new Date(),
): WorkspaceScanComparisonReceipt {
  const identical = first.fingerprint === second.fingerprint
    && first.canonicalWorkspacePath === second.canonicalWorkspacePath;
  const findings = [...first.findings, ...second.findings];
  if (!identical) {
    findings.push({ reason: 'scan_changed', detail: 'Workspace state changed between verification scans.' });
  }
  return {
    state: identical ? findingState(findings) : 'unknown',
    identical,
    firstFingerprint: first.fingerprint,
    secondFingerprint: second.fingerprint,
    findings,
    comparedAt: now().toISOString(),
  };
}
