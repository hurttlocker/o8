/**
 * GET /api/panel/repo-status?path=<localPath>
 *
 * Returns the "what changed since I last checked" signal set for a repo:
 *   - last commit (sha7, subject, timestamp, author)
 *   - working tree diff summary (additions, deletions, file count)
 *   - upstream divergence (ahead / behind origin/<branch>)
 *   - current branch
 *
 * Powers the repo hover card in the left-rail repo registry. Kept deliberately
 * narrow so the hover can resolve in one round-trip and fall back gracefully
 * when any individual git shell-out fails (e.g. detached HEAD, missing
 * upstream, bare repo).
 */

export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { requirePanelAuth } from '@/lib/panel/auth';

const execFileAsync = promisify(execFile);

interface RepoStatusLastCommit {
  sha7: string;
  subject: string;
  timestamp: string | null;
  author: string;
}

interface RepoStatusWorkingTree {
  additions: number;
  deletions: number;
  fileCount: number;
}

interface RepoStatusUpstream {
  ahead: number;
  behind: number;
  upstreamRef: string | null;
}

interface RepoStatusResponse {
  path: string;
  branch: string | null;
  lastCommit: RepoStatusLastCommit | null;
  workingTree: RepoStatusWorkingTree;
  upstream: RepoStatusUpstream;
  error?: string;
}

const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { value: RepoStatusResponse; ts: number }>();

function resolveRepoPath(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('~')) return trimmed.replace('~', homedir());
  return trimmed;
}

async function runGit(cwd: string, args: string[], timeout = 4_000) {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout,
    maxBuffer: 512 * 1024,
  });
  return stdout;
}

async function readCurrentBranch(cwd: string) {
  try {
    const output = await runGit(cwd, ['branch', '--show-current']);
    return output.trim() || null;
  } catch {
    return null;
  }
}

async function readLastCommit(cwd: string): Promise<RepoStatusLastCommit | null> {
  try {
    // Use a record separator between fields so commit subjects with tabs or
    // unusual whitespace survive the parse.
    const SEP = '\u001f';
    const output = await runGit(cwd, [
      'log',
      '-1',
      `--format=%h${SEP}%s${SEP}%aI${SEP}%an`,
    ]);
    const [sha7 = '', subject = '', timestamp = '', author = ''] = output.trim().split(SEP);
    if (!sha7) return null;
    return {
      sha7,
      subject: subject.trim(),
      timestamp: timestamp.trim() || null,
      author: author.trim(),
    };
  } catch {
    return null;
  }
}

async function readWorkingTree(cwd: string): Promise<RepoStatusWorkingTree> {
  try {
    // `git diff HEAD --numstat` captures both staged and unstaged changes
    // against HEAD. Untracked files are counted separately below so brand new
    // files still surface in the "+N in K files" line.
    const diffOutput = await runGit(cwd, ['diff', 'HEAD', '--numstat']);
    let additions = 0;
    let deletions = 0;
    const files = new Set<string>();
    for (const line of diffOutput.split('\n')) {
      if (!line.trim()) continue;
      const [addStr = '0', delStr = '0', ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      if (!filePath) continue;
      files.add(filePath);
      if (addStr !== '-') additions += Number.parseInt(addStr, 10) || 0;
      if (delStr !== '-') deletions += Number.parseInt(delStr, 10) || 0;
    }

    const untrackedOutput = await runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
    for (const line of untrackedOutput.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    return { additions, deletions, fileCount: files.size };
  } catch {
    return { additions: 0, deletions: 0, fileCount: 0 };
  }
}

async function readUpstream(cwd: string, branch: string | null): Promise<RepoStatusUpstream> {
  const empty: RepoStatusUpstream = { ahead: 0, behind: 0, upstreamRef: null };
  if (!branch) return empty;

  let upstreamRef: string | null = null;
  try {
    const output = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    upstreamRef = output.trim() || null;
  } catch {
    return empty;
  }

  if (!upstreamRef) return empty;

  try {
    const output = await runGit(cwd, ['rev-list', '--left-right', '--count', `${upstreamRef}...HEAD`]);
    const [behindStr = '0', aheadStr = '0'] = output.trim().split(/\s+/);
    return {
      ahead: Number.parseInt(aheadStr, 10) || 0,
      behind: Number.parseInt(behindStr, 10) || 0,
      upstreamRef,
    };
  } catch {
    return { ...empty, upstreamRef };
  }
}

async function buildStatus(path: string): Promise<RepoStatusResponse> {
  const resolved = resolveRepoPath(path);
  if (!resolved || !existsSync(resolved)) {
    return {
      path,
      branch: null,
      lastCommit: null,
      workingTree: { additions: 0, deletions: 0, fileCount: 0 },
      upstream: { ahead: 0, behind: 0, upstreamRef: null },
      error: 'path_not_found',
    };
  }

  const branch = await readCurrentBranch(resolved);
  const [lastCommit, workingTree, upstream] = await Promise.all([
    readLastCommit(resolved),
    readWorkingTree(resolved),
    readUpstream(resolved, branch),
  ]);

  return {
    path: resolved,
    branch,
    lastCommit,
    workingTree,
    upstream,
  };
}

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const path = req.nextUrl.searchParams.get('path');
  if (!path) {
    return NextResponse.json({ error: 'path parameter required' }, { status: 400 });
  }

  const cacheKey = path;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return NextResponse.json(cached.value, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const value = await buildStatus(path);
    cache.set(cacheKey, { value, ts: Date.now() });
    return NextResponse.json(value, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json(
      {
        path,
        branch: null,
        lastCommit: null,
        workingTree: { additions: 0, deletions: 0, fileCount: 0 },
        upstream: { ahead: 0, behind: 0, upstreamRef: null },
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 200 },
    );
  }
}
