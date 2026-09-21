import 'server-only';

import { execFile } from 'node:child_process';
import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import ts from 'typescript';

import { parseNameStatus, type LaneFileChange } from '@/lib/lane/lane-diff-facts';
import type {
  ArchitectureDeltaEdge,
  ArchitectureDeltaNode,
  ArchitectureDeltaResult,
  ArchitectureModuleState,
} from '@/lib/review/architecture-delta-types';

const execFileAsync = promisify(execFile);
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;
const MAX_SOURCE_FILES = 2_500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_RESULT_NODES = 80;
const MAX_RESULT_EDGES = 160;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

interface AliasRule {
  pattern: string;
  targets: string[];
}

interface SnapshotGraph {
  edges: Set<string>;
}

export interface BuildArchitectureDeltaOptions {
  repoPath: string;
  baseRef?: string;
}

export class ArchitectureDeltaInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchitectureDeltaInputError';
  }
}

function emptySummary() {
  return { changedModules: 0, addedEdges: 0, removedEdges: 0, contextEdges: 0 };
}

export function unavailableArchitectureDelta(reason: string): ArchitectureDeltaResult {
  return {
    ok: true,
    status: 'unavailable',
    reason,
    nodes: [],
    edges: [],
    summary: emptySummary(),
    unsupportedPaths: [],
    truncated: false,
    generatedAt: new Date().toISOString(),
  };
}

async function gitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return String(stdout);
}

async function gitValue(cwd: string, args: string[]) {
  return (await gitOutput(cwd, args)).trim();
}

function splitNulls(value: string) {
  return value.split('\0').filter(Boolean);
}

function isSupportedSource(filePath: string) {
  const lower = filePath.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function toPosix(filePath: string) {
  return filePath.split(path.sep).join('/');
}

async function resolveRepoRoot(repoPath: string) {
  if (!path.isAbsolute(repoPath)) {
    throw new ArchitectureDeltaInputError('Architecture analysis requires an absolute repository path.');
  }
  let canonical: string;
  try {
    canonical = await realpath(repoPath);
  } catch {
    throw new ArchitectureDeltaInputError('The selected review workspace is unavailable.');
  }
  let gitRoot: string;
  try {
    gitRoot = await realpath(await gitValue(canonical, ['rev-parse', '--show-toplevel']));
  } catch {
    throw new ArchitectureDeltaInputError('The selected review workspace is not a Git repository.');
  }
  if (gitRoot !== canonical) {
    throw new ArchitectureDeltaInputError('Architecture analysis requires the repository root.');
  }
  return canonical;
}

async function resolveBaseCommit(repoRoot: string, baseRef: string) {
  try {
    return await gitValue(repoRoot, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  } catch {
    throw new ArchitectureDeltaInputError('The review baseline is unavailable.');
  }
}

async function workspaceFingerprint(repoRoot: string) {
  const [head, status] = await Promise.all([
    gitValue(repoRoot, ['rev-parse', 'HEAD']),
    gitOutput(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  return `${head}\0${status}`;
}

async function readChanges(repoRoot: string, baseCommit: string) {
  const [tracked, untracked] = await Promise.all([
    gitOutput(repoRoot, ['diff', '--name-status', '-z', '--find-renames', baseCommit, '--']),
    gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const changes = parseNameStatus(tracked);
  const knownPaths = new Set(changes.map((change) => change.path));
  for (const filePath of splitNulls(untracked)) {
    if (!knownPaths.has(filePath)) changes.push({ path: filePath, status: 'untracked' });
  }
  return changes;
}

async function listAfterPaths(repoRoot: string) {
  const output = await gitOutput(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return splitNulls(output).map(toPosix);
}

async function listBeforePaths(repoRoot: string, baseCommit: string) {
  const output = await gitOutput(repoRoot, ['ls-tree', '-r', '--name-only', '-z', baseCommit, '--']);
  return splitNulls(output).map(toPosix);
}

async function readCurrentSources(
  repoRoot: string,
  paths: string[],
  priorityPaths: Set<string>,
) {
  const supported = paths.filter(isSupportedSource);
  const ordered = [...supported].sort((left, right) => {
    const priority = Number(priorityPaths.has(right)) - Number(priorityPaths.has(left));
    return priority || left.localeCompare(right);
  });
  const limited = ordered.slice(0, MAX_SOURCE_FILES);
  const stats = await Promise.all(limited.map(async (filePath) => {
    try {
      return { filePath, size: (await stat(path.join(repoRoot, filePath))).size };
    } catch {
      return { filePath, size: -1 };
    }
  }));

  let totalBytes = 0;
  const selected: string[] = [];
  let truncated = ordered.length > limited.length;
  for (const entry of stats) {
    if (entry.size < 0) continue;
    if (entry.size > MAX_FILE_BYTES || totalBytes + entry.size > MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    totalBytes += entry.size;
    selected.push(entry.filePath);
  }

  const contents = new Map<string, string>();
  const batchSize = 32;
  for (let index = 0; index < selected.length; index += batchSize) {
    const batch = selected.slice(index, index + batchSize);
    const values = await Promise.all(batch.map(async (filePath) => {
      try {
        return [filePath, await readFile(path.join(repoRoot, filePath), 'utf8')] as const;
      } catch {
        return null;
      }
    }));
    for (const value of values) {
      if (value) contents.set(value[0], value[1]);
    }
  }
  return { contents, truncated };
}

async function readBaseFile(repoRoot: string, baseCommit: string, filePath: string) {
  try {
    const content = await gitOutput(repoRoot, ['show', `${baseCommit}:${filePath}`]);
    return Buffer.byteLength(content, 'utf8') <= MAX_FILE_BYTES ? content : null;
  } catch {
    return null;
  }
}

function changeBeforePath(change: LaneFileChange) {
  if (change.status === 'added' || change.status === 'untracked') return null;
  return change.status === 'renamed' ? change.previousPath ?? null : change.path;
}

function changedPathSet(changes: LaneFileChange[]) {
  const paths = new Set<string>();
  for (const change of changes) {
    paths.add(toPosix(change.path));
    if (change.previousPath) paths.add(toPosix(change.previousPath));
  }
  return paths;
}

async function buildBeforeContents(
  repoRoot: string,
  baseCommit: string,
  beforePaths: Set<string>,
  afterContents: Map<string, string>,
  changes: LaneFileChange[],
) {
  const changed = changedPathSet(changes);
  const contents = new Map<string, string>();
  for (const [filePath, content] of afterContents) {
    if (beforePaths.has(filePath) && !changed.has(filePath)) contents.set(filePath, content);
  }
  for (const change of changes) {
    const beforePath = changeBeforePath(change);
    if (!beforePath || !isSupportedSource(beforePath)) continue;
    const normalized = toPosix(beforePath);
    const content = await readBaseFile(repoRoot, baseCommit, normalized);
    if (content !== null) contents.set(normalized, content);
  }
  return contents;
}

function loadAliasRules(repoRoot: string): AliasRule[] {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return [{ pattern: '@/*', targets: ['src/*'] }];
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return [{ pattern: '@/*', targets: ['src/*'] }];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const baseUrl = parsed.options.baseUrl ?? path.dirname(configPath);
  const rules: AliasRule[] = [];
  for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
    const normalizedTargets = targets.flatMap((target) => {
      const absolute = path.resolve(baseUrl, target);
      const relative = toPosix(path.relative(repoRoot, absolute));
      return relative.startsWith('../') || relative === '..' ? [] : [relative];
    });
    if (normalizedTargets.length) rules.push({ pattern, targets: normalizedTargets });
  }
  if (!rules.some((rule) => rule.pattern === '@/*')) {
    rules.push({ pattern: '@/*', targets: ['src/*'] });
  }
  return rules;
}

function applyPattern(pattern: string, target: string, value: string) {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === value ? target : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const end = suffix.length ? value.length - suffix.length : value.length;
  const match = value.slice(prefix.length, end);
  return target.replace('*', match);
}

function candidateRoots(specifier: string, fromPath: string, aliases: AliasRule[]) {
  if (specifier.startsWith('.')) {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier))];
  }
  const candidates: string[] = [];
  for (const rule of aliases) {
    for (const target of rule.targets) {
      const candidate = applyPattern(rule.pattern, target, specifier);
      if (candidate) candidates.push(path.posix.normalize(candidate));
    }
  }
  return candidates;
}

function resolveCandidate(root: string, sourcePaths: Set<string>) {
  const exactCandidates = [root];
  const knownExtension = SOURCE_EXTENSIONS.find((extension) => root.toLowerCase().endsWith(extension));
  if (knownExtension) exactCandidates.push(root.slice(0, -knownExtension.length));
  for (const candidate of exactCandidates) {
    if (sourcePaths.has(candidate)) return candidate;
    for (const extension of SOURCE_EXTENSIONS) {
      const withExtension = `${candidate}${extension}`;
      if (sourcePaths.has(withExtension)) return withExtension;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      const indexPath = `${candidate}/index${extension}`;
      if (sourcePaths.has(indexPath)) return indexPath;
    }
  }
  return null;
}

function edgeKey(from: string, to: string) {
  return `${from}\0${to}`;
}

function splitEdgeKey(key: string) {
  const separator = key.indexOf('\0');
  return { from: key.slice(0, separator), to: key.slice(separator + 1) };
}

function buildGraph(
  contents: Map<string, string>,
  sourcePaths: Set<string>,
  aliases: AliasRule[],
): SnapshotGraph {
  const edges = new Set<string>();
  for (const [from, content] of contents) {
    const imported = ts.preProcessFile(content, true, true).importedFiles;
    for (const entry of imported) {
      const roots = candidateRoots(entry.fileName, from, aliases);
      const to = roots.map((root) => resolveCandidate(root, sourcePaths)).find(Boolean) ?? null;
      if (to && to !== from) edges.add(edgeKey(from, to));
    }
  }
  return { edges };
}

function moduleStates(changes: LaneFileChange[]) {
  const states = new Map<string, { state: ArchitectureModuleState; focusPath: string | null }>();
  for (const change of changes) {
    const currentPath = toPosix(change.path);
    if (change.status === 'renamed') {
      if (change.previousPath && isSupportedSource(change.previousPath)) {
        states.set(toPosix(change.previousPath), { state: 'removed', focusPath: currentPath });
      }
      if (isSupportedSource(currentPath)) states.set(currentPath, { state: 'added', focusPath: currentPath });
    } else if (isSupportedSource(currentPath)) {
      const state: ArchitectureModuleState = change.status === 'added' || change.status === 'untracked'
        ? 'added'
        : change.status === 'deleted'
          ? 'removed'
          : 'changed';
      states.set(currentPath, { state, focusPath: currentPath });
    }
  }
  return states;
}

function buildResult(
  beforeGraph: SnapshotGraph,
  afterGraph: SnapshotGraph,
  changes: LaneFileChange[],
  unsupportedPaths: string[],
  sourceTruncated: boolean,
): ArchitectureDeltaResult {
  const states = moduleStates(changes);
  if (states.size === 0) {
    return {
      ok: true,
      status: 'unsupported',
      reason: 'No supported source modules changed.',
      nodes: [],
      edges: [],
      summary: emptySummary(),
      unsupportedPaths,
      truncated: sourceTruncated,
      generatedAt: new Date().toISOString(),
    };
  }

  const changedPaths = new Set(states.keys());
  const allEdgeKeys = new Set([...beforeGraph.edges, ...afterGraph.edges]);
  const edgeCandidates: ArchitectureDeltaEdge[] = [];
  for (const key of allEdgeKeys) {
    const { from, to } = splitEdgeKey(key);
    if (!changedPaths.has(from) && !changedPaths.has(to)) continue;
    const before = beforeGraph.edges.has(key);
    const after = afterGraph.edges.has(key);
    const state = before && after ? 'context' : after ? 'added' : 'removed';
    const focusPath = states.get(from)?.focusPath ?? states.get(to)?.focusPath ?? null;
    edgeCandidates.push({ from, to, state, focusPath });
  }
  edgeCandidates.sort((left, right) => {
    const rank = { added: 0, removed: 1, context: 2 } as const;
    return rank[left.state] - rank[right.state]
      || left.from.localeCompare(right.from)
      || left.to.localeCompare(right.to);
  });

  let truncated = sourceTruncated || edgeCandidates.length > MAX_RESULT_EDGES;
  let edges = edgeCandidates.slice(0, MAX_RESULT_EDGES);
  const nodePaths = new Set(changedPaths);
  for (const edge of edges) {
    nodePaths.add(edge.from);
    nodePaths.add(edge.to);
  }
  const orderedNodes = [...nodePaths].sort((left, right) => {
    const leftChanged = states.has(left) ? 0 : 1;
    const rightChanged = states.has(right) ? 0 : 1;
    return leftChanged - rightChanged || left.localeCompare(right);
  });
  if (orderedNodes.length > MAX_RESULT_NODES) truncated = true;
  const selectedPaths = new Set(orderedNodes.slice(0, MAX_RESULT_NODES));
  edges = edges.filter((edge) => selectedPaths.has(edge.from) && selectedPaths.has(edge.to));
  const nodes: ArchitectureDeltaNode[] = [...selectedPaths].map((filePath) => {
    const change = states.get(filePath);
    return {
      path: filePath,
      state: change?.state ?? 'context',
      focusPath: change?.focusPath ?? null,
    };
  });

  return {
    ok: true,
    status: 'ready',
    reason: null,
    nodes,
    edges,
    summary: {
      changedModules: nodes.filter((node) => node.state !== 'context').length,
      addedEdges: edges.filter((edge) => edge.state === 'added').length,
      removedEdges: edges.filter((edge) => edge.state === 'removed').length,
      contextEdges: edges.filter((edge) => edge.state === 'context').length,
    },
    unsupportedPaths,
    truncated,
    generatedAt: new Date().toISOString(),
  };
}

export async function buildArchitectureDelta({
  repoPath,
  baseRef = 'HEAD',
}: BuildArchitectureDeltaOptions): Promise<ArchitectureDeltaResult> {
  const repoRoot = await resolveRepoRoot(repoPath);
  const baseCommit = await resolveBaseCommit(repoRoot, baseRef);
  const firstFingerprint = await workspaceFingerprint(repoRoot);
  const changes = await readChanges(repoRoot, baseCommit);
  const unsupportedPaths = changes
    .map((change) => toPosix(change.path))
    .filter((filePath) => !isSupportedSource(filePath))
    .sort();
  const changedPaths = changedPathSet(changes);
  const [afterPaths, beforePathList] = await Promise.all([
    listAfterPaths(repoRoot),
    listBeforePaths(repoRoot, baseCommit),
  ]);
  const afterSourcePaths = new Set(afterPaths.filter(isSupportedSource));
  const beforeSourcePaths = new Set(beforePathList.filter(isSupportedSource));
  const { contents: afterContents, truncated: sourceTruncated } = await readCurrentSources(
    repoRoot,
    afterPaths,
    changedPaths,
  );
  const beforeContents = await buildBeforeContents(
    repoRoot,
    baseCommit,
    beforeSourcePaths,
    afterContents,
    changes,
  );
  const aliases = loadAliasRules(repoRoot);
  const result = buildResult(
    buildGraph(beforeContents, beforeSourcePaths, aliases),
    buildGraph(afterContents, afterSourcePaths, aliases),
    changes,
    unsupportedPaths,
    sourceTruncated,
  );
  const lastFingerprint = await workspaceFingerprint(repoRoot);
  if (lastFingerprint !== firstFingerprint) {
    return unavailableArchitectureDelta('The workspace changed during architecture analysis. Refresh Review to retry.');
  }
  return result;
}
