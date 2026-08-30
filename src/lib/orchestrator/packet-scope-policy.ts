import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const REPO_WIDE_SCOPE = '**/*';
const TINY_PREDICTION_MAX = 1;
const PATH_TOKEN = /(?:^|[\s`'"(])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+(?:\/\*\*)?)/g;
const NEW_FILE_PATH = /^[\w./-]+\.\w+$/;
const KNOWN_ROOT_FILE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'css', 'csv', 'env', 'go', 'gql', 'graphql', 'h', 'hpp',
  'htm', 'html', 'java', 'js', 'json', 'jsx', 'kt', 'kts', 'less', 'lock',
  'md', 'mjs', 'php', 'proto', 'py', 'rb', 'rs', 'sass', 'scss', 'sh', 'sql',
  'swift', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml', 'zsh',
]);
const FORBIDDEN_LINE = /\b(?:do not|don't|never|must not)\s+(?:touch|edit|modify|write|change)|\bforbid(?:s|den|ding)?\s+(?:touching|editing|modifying|writing|changing)/i;

export interface PacketScopeResolution {
  allowedPaths: string[];
  predictedPaths: string[];
  forbiddenPaths: string[];
  source: 'explicit' | 'inline' | 'prediction' | 'fallback';
  reason: string | null;
  unsatisfiableReason: string | null;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter(Boolean))];
}

function pathIsInside(repoRoot: string, candidate: string): boolean {
  const rel = relative(repoRoot, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function existingAncestor(path: string): string | null {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function isRepoPathCandidate(repoPath: string | null, value: string): boolean {
  if (!repoPath) return false;
  const path = normalizePath(value);
  if (!path || path.includes('..') || path.endsWith('/**')) return false;

  try {
    const repoRoot = realpathSync(repoPath);
    const target = resolve(repoRoot, path);
    if (!pathIsInside(repoRoot, target)) return false;
    if (existsSync(target)) return pathIsInside(repoRoot, realpathSync(target));
    if (!NEW_FILE_PATH.test(path)) return false;

    const extension = extname(path).slice(1).toLowerCase();
    if (!path.includes('/') && !KNOWN_ROOT_FILE_EXTENSIONS.has(extension)) return false;
    const ancestor = existingAncestor(dirname(target));
    return Boolean(ancestor && pathIsInside(repoRoot, realpathSync(ancestor)));
  } catch {
    return false;
  }
}

function repoPaths(paths: string[], repoPath: string | null): string[] {
  return uniquePaths(paths).filter((path) => isRepoPathCandidate(repoPath, path));
}

function extractPaths(text: string, repoPath: string | null): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(PATH_TOKEN)) {
    const path = normalizePath(match[1] ?? '');
    if (path) paths.push(path);
  }
  return repoPaths(paths, repoPath);
}

function taskText(packet: Pick<OrchestratorPacket, 'title' | 'summary' | 'issue'>): string {
  return [packet.title, packet.summary, packet.issue?.body]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n');
}

function forbiddenTaskPaths(
  packet: Pick<OrchestratorPacket, 'title' | 'summary' | 'issue' | 'workspaceTargetPath'>,
): string[] {
  return uniquePaths(taskText(packet)
    .split(/\r?\n/)
    .filter((line) => FORBIDDEN_LINE.test(line))
    .flatMap((line) => extractPaths(line, packet.workspaceTargetPath)));
}

function pathOverlaps(left: string, right: string): boolean {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (a === REPO_WIDE_SCOPE || b === REPO_WIDE_SCOPE || a === b) return true;
  const aPrefix = a.endsWith('/**') ? a.slice(0, -2) : null;
  const bPrefix = b.endsWith('/**') ? b.slice(0, -2) : null;
  return Boolean((aPrefix && b.startsWith(aPrefix)) || (bPrefix && a.startsWith(bPrefix)));
}

function isForbidden(path: string, forbiddenPaths: string[]): boolean {
  if (normalizePath(path) === REPO_WIDE_SCOPE) return false;
  return forbiddenPaths.some((forbidden) => pathOverlaps(path, forbidden));
}

export function resolvePacketScope(
  packet: Pick<OrchestratorPacket,
    'title' | 'summary' | 'issue' | 'allowedFiles' | 'predictedFiles' | 'workspaceTargetPath'>,
  predictedFiles: string[] = packet.predictedFiles ?? [],
): PacketScopeResolution {
  const predictedPaths = repoPaths(predictedFiles, packet.workspaceTargetPath);
  const forbiddenPaths = forbiddenTaskPaths(packet);
  const explicitPaths = uniquePaths(packet.allowedFiles ?? []);

  if (explicitPaths.length > 0) {
    const allowedPaths = explicitPaths.filter((path) => !isForbidden(path, forbiddenPaths));
    const unsatisfiableReason = allowedPaths.length === 0
      ? `Unsatisfiable packet scope: the task brief forbids the only allowed path${explicitPaths.length === 1 ? '' : 's'} (${explicitPaths.join(', ')}).`
      : null;
    return {
      allowedPaths,
      predictedPaths,
      forbiddenPaths,
      source: 'explicit',
      reason: forbiddenPaths.length > 0 ? 'Explicit allowlist reconciled against task prohibitions.' : null,
      unsatisfiableReason,
    };
  }

  const inlineIssue = (packet.issue?.number ?? 0) >= 90001 && !packet.issue?.url;
  if (inlineIssue) {
    return {
      allowedPaths: [REPO_WIDE_SCOPE],
      predictedPaths,
      forbiddenPaths,
      source: 'inline',
      reason: 'Inline packet scope is repository-wide.',
      unsatisfiableReason: null,
    };
  }

  const statedTargets = extractPaths(taskText(packet), packet.workspaceTargetPath)
    .filter((path) => !isForbidden(path, forbiddenPaths));
  const predictionTouchesForbidden = predictedPaths.some((path) => isForbidden(path, forbiddenPaths));
  const predictionMatchesTarget = statedTargets.length > 0
    && statedTargets.some((target) => predictedPaths.some((path) => pathOverlaps(path, target)));
  const fallbackReason = predictedPaths.length === 0 && statedTargets.length === 0
    ? 'File prediction was empty.'
    : predictedPaths.length <= TINY_PREDICTION_MAX && statedTargets.length === 0
      ? 'File prediction was too small to seal safely.'
      : predictionTouchesForbidden
        ? 'File prediction included a path forbidden by the task brief.'
        : predictedPaths.length > 0 && statedTargets.length > 0 && !predictionMatchesTarget
          ? 'File prediction was not supported by the task brief targets.'
          : null;

  if (fallbackReason) {
    return {
      allowedPaths: [REPO_WIDE_SCOPE],
      predictedPaths,
      forbiddenPaths,
      source: 'fallback',
      reason: `${fallbackReason} Using a permissive fallback scope.`,
      unsatisfiableReason: null,
    };
  }

  return {
    allowedPaths: uniquePaths([...predictedPaths, ...statedTargets]),
    predictedPaths,
    forbiddenPaths,
    source: 'prediction',
    reason: 'Prediction reconciled with paths stated in the task brief.',
    unsatisfiableReason: null,
  };
}

export function applyPacketScopePolicy(
  packet: OrchestratorPacket,
  predictedFiles: string[],
): OrchestratorPacket {
  const resolution = resolvePacketScope(packet, predictedFiles);
  const now = new Date().toISOString();
  if (resolution.unsatisfiableReason) {
    return {
      ...packet,
      predictedFiles: resolution.predictedPaths,
      allowedFiles: uniquePaths(packet.allowedFiles ?? []),
      queueState: 'held',
      status: 'blocked',
      blockedReason: resolution.unsatisfiableReason,
      lastEventAt: now,
      lastEventLabel: 'scope_unsatisfiable',
    };
  }
  return {
    ...packet,
    predictedFiles: resolution.predictedPaths,
    allowedFiles: resolution.allowedPaths,
  };
}

export function packetScopeDispatchBlocker(packet: OrchestratorPacket): string | null {
  return resolvePacketScope(packet).unsatisfiableReason;
}
