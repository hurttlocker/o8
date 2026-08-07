import 'server-only';

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { canonicalRepoPath, getFeature, saveGrounding } from './store';
import type { GroundedPath, HarnessGroundingArtifact } from './types';

export const GROUNDING_FILE_SCAN_LIMIT = 2_000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 160 * 1024;
const MAX_PATH_RESULTS = 24;

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json',
  '.jsx', '.kt', '.kts', '.md', '.mjs', '.mts', '.py', '.rb', '.rs', '.scss', '.sh',
  '.sql', '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.yaml', '.yml', '.zsh',
]);

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'before', 'being', 'build', 'could',
  'does', 'each', 'finish', 'from', 'have', 'into', 'issue', 'more', 'need', 'o8',
  'only', 'other', 'should', 'that', 'their', 'then', 'there', 'these', 'they', 'this',
  'through', 'using', 'what', 'when', 'where', 'which', 'with', 'would',
]);

function git(repoPath: string, args: string[], fallback: string | null = null): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

function tokenize(value: string): string[] {
  const expanded = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return [...new Set(
    expanded
      .split(/[^a-z0-9_./-]+/)
      .flatMap((part) => part.split(/[./_-]+/))
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !STOP_WORDS.has(part) && !/^\d+$/.test(part)),
  )].slice(0, 40);
}

function isTextPath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return TEXT_EXTENSIONS.has(extname(name))
    || name === 'dockerfile'
    || name === 'makefile'
    || name === 'license'
    || name.startsWith('.env.example');
}

function readBoundedText(repoPath: string, path: string): string | null {
  try {
    const fullPath = join(repoPath, path);
    const stat = lstatSync(fullPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const bytes = readFileSync(fullPath).subarray(0, MAX_READ_BYTES);
    if (bytes.includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

function extractSymbols(text: string, queryTerms: string[]): string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/g,
    /\b(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/g,
    /\b(?:def|class)\s+([A-Za-z_][\w]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const symbol = match[1];
      const normalized = symbol.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
      if (queryTerms.some((term) => normalized.includes(term))) symbols.add(symbol);
      if (symbols.size >= 12) return [...symbols];
    }
  }
  return [...symbols];
}

function scorePath(path: string, text: string, queryTerms: string[]): GroundedPath | null {
  const pathLower = path.toLowerCase();
  const textLower = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const term of queryTerms) {
    if (pathLower.includes(term)) {
      score += 8;
      reasons.push(`path:${term}`);
    }
    const first = textLower.indexOf(term);
    if (first >= 0) {
      const occurrences = Math.min(5, textLower.split(term).length - 1);
      score += 2 + occurrences;
      reasons.push(`content:${term}`);
    }
  }
  const symbols = extractSymbols(text, queryTerms);
  score += symbols.length * 3;
  if (symbols.length) reasons.push('matching-symbols');
  if (score === 0) return null;
  return {
    path,
    score,
    reasons: [...new Set(reasons)].slice(0, 12),
    symbols,
  };
}

function repositoryInstructions(paths: string[]): string[] {
  const instructionNames = new Set(['agents.md', 'claude.md', 'readme.md', 'design.md', 'styleguide.md']);
  return paths
    .filter((path) => instructionNames.has(basename(path).toLowerCase()))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
    .slice(0, 20);
}

export function groundTask(input: {
  repoPath: string;
  task: string;
  featureId?: string | null;
  packetId?: string | null;
  acceptanceCriteria?: string[];
}): HarnessGroundingArtifact {
  const repoPath = canonicalRepoPath(input.repoPath);
  const task = input.task.trim();
  if (!task) throw new Error('task is required');
  if (task.length > 50_000) throw new Error('task exceeds 50000 characters');
  if (git(repoPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
    throw new Error(`repoPath is not a Git worktree: ${repoPath}`);
  }
  if (input.featureId) {
    const feature = getFeature(input.featureId);
    if (!feature || feature.repoPath !== repoPath) throw new Error('feature not found in repository');
  }

  const queryTerms = tokenize(task);
  const tracked = (git(repoPath, ['ls-files'], '') ?? '').split('\n').filter(Boolean);
  const candidates = tracked.filter(isTextPath);
  const warnings: string[] = [];
  if (candidates.length > GROUNDING_FILE_SCAN_LIMIT) {
    warnings.push(`Scanned the first ${GROUNDING_FILE_SCAN_LIMIT} of ${candidates.length} tracked text files.`);
  }
  const scored: GroundedPath[] = [];
  for (const path of candidates.slice(0, GROUNDING_FILE_SCAN_LIMIT)) {
    const text = readBoundedText(repoPath, path);
    if (!text) continue;
    const result = scorePath(path, text, queryTerms);
    if (result) scored.push(result);
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (scored.length === 0) warnings.push('No tracked file matched the task terms; add explicit path hints before dispatch.');

  const feature = input.featureId ? getFeature(input.featureId) : null;
  const acceptanceCriteria = (input.acceptanceCriteria ?? [])
    .map((criterion) => criterion.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (acceptanceCriteria.length === 0 && feature?.description) {
    acceptanceCriteria.push(feature.description);
  }
  if (acceptanceCriteria.length === 0) {
    warnings.push('No acceptance criteria were supplied; the contract stage must add them before execution.');
  }

  const status = git(repoPath, ['status', '--porcelain'], '') ?? '';
  const artifact: HarnessGroundingArtifact = {
    schema: 'o8/grounding/v1',
    id: `grounding-${randomUUID()}`,
    repoPath,
    task,
    featureId: input.featureId ?? null,
    packetId: input.packetId?.trim().slice(0, 200) || null,
    git: {
      head: git(repoPath, ['rev-parse', 'HEAD']),
      branch: git(repoPath, ['branch', '--show-current']),
      dirty: status.length > 0,
    },
    queryTerms,
    paths: scored.slice(0, MAX_PATH_RESULTS),
    repositoryInstructions: repositoryInstructions(tracked),
    acceptanceCriteria,
    warnings,
    createdAt: Date.now(),
  };
  return saveGrounding(artifact);
}
