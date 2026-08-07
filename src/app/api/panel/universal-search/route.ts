export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { ensureGitHubIssues, resolveRepoSlug } from '@/lib/github-broker';

const HOME = process.env.HOME || os.homedir();
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || `process.cwd()`;

// ── Result types ──

interface UniversalResult {
  kind: 'conversation' | 'agent' | 'issue' | 'file' | 'symbol';
  title: string;
  detail: string;
  /** Navigation target */
  target?: {
    sessionKey?: string;
    issueNumber?: number;
    filePath?: string;
    line?: number;
  };
  score: number;
}

// ── Helpers ──

function execFileQuiet(file: string, args: string[], opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execFileSync(file, args, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: opts?.timeout ?? 4000,
      maxBuffer: 512 * 1024,
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

// ── Symbol search (skeleton map) ──

function searchSymbolsProvider(query: string, workspace?: string): UniversalResult[] {
  try {
    // Dynamic import to avoid breaking if skeleton module isn't available
    const { searchSymbols } = require('@/lib/skeleton') as typeof import('@/lib/skeleton');
    const root = workspace
      ? (workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace)
      : DEFAULT_ROOT;
    const results = searchSymbols(root, query, 8);
    return results.map(r => ({
      kind: 'symbol' as const,
      title: `${r.symbol.exported ? 'export ' : ''}${r.symbol.kind} ${r.symbol.name}`,
      detail: `${r.filePath}:${r.symbol.line}`,
      target: { filePath: r.filePath, line: r.symbol.line },
      score: r.score * 0.85,
    }));
  } catch {
    return [];
  }
}

// ── Search providers ──

async function searchConversations(query: string): Promise<UniversalResult[]> {
  void query;
  return [];
}

async function searchIssues(query: string, repoLike?: string): Promise<UniversalResult[]> {
  const repo = await resolveRepoSlug(repoLike ?? null, '');
  if (!repo) return [];

  const result = await ensureGitHubIssues(repo).catch(() => null);
  if (!result) return [];

  const lowerQuery = query.toLowerCase();
  return result.issues
    .filter((issue) => {
      const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
      return haystack.includes(lowerQuery);
    })
    .slice(0, 8)
    .map((issue) => ({
      kind: 'issue' as const,
      title: `#${issue.number} ${issue.title}`,
      detail: `${issue.state} · ${issue.body.slice(0, 100)}`,
      target: { issueNumber: issue.number },
      score: 0.75,
    }));
}

function searchFiles(query: string, workspace?: string): UniversalResult[] {
  const root = workspace
    ? (workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace)
    : DEFAULT_ROOT;

  const results: UniversalResult[] = [];
  const needle = query.toLowerCase();

  // Filename matches — run `find` with no shell, then filter by query in JS.
  const findOut = execFileQuiet(
    'find',
    [
      '.', '-maxdepth', '5', '-type', 'f',
      '-not', '-path', '*/.git/*',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.next/*',
      '-not', '-path', '*/target/*',
      '-not', '-path', '*/dist/*',
    ],
    { cwd: root, timeout: 3000 },
  );
  const findMatches = findOut
    .split('\n')
    .filter((line) => line && line.toLowerCase().includes(needle))
    .slice(0, 8);
  for (const line of findMatches) {
    const clean = line.startsWith('./') ? line.slice(2) : line;
    results.push({
      kind: 'file',
      title: clean.split('/').pop() ?? clean,
      detail: clean,
      target: { filePath: clean },
      score: 0.8,
    });
  }

  // Content matches via ripgrep
  const rgOut = execFileQuiet(
    'rg',
    ['--json', '-i', '-m', '2', '--max-filesize', '500K', '-g', '!*.lock', '-g', '!*.min.*', '--', query],
    { cwd: root, timeout: 4000 },
  );
  for (const rawLine of rgOut.split('\n').filter(Boolean).slice(0, 40)) {
    try {
      const parsed = JSON.parse(rawLine);
      if (parsed.type === 'match' && parsed.data) {
        const filePath = parsed.data.path?.text ?? '';
        const lineNum = parsed.data.line_number ?? 0;
        const lineText = (parsed.data.lines?.text ?? '').trim().slice(0, 200);
        if (filePath && !results.some(r => r.target?.filePath === filePath && r.target?.line === lineNum)) {
          results.push({
            kind: 'file',
            title: `${filePath.split('/').pop()}:${lineNum}`,
            detail: lineText,
            target: { filePath, line: lineNum },
            score: 0.65,
          });
        }
      }
    } catch { /* skip */ }
  }

  return results.slice(0, 10);
}

// ── Main handler ──

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  const workspace = searchParams.get('workspace') ?? undefined;
  const repo = searchParams.get('repo') ?? undefined;
  const categories = searchParams.get('categories')?.split(',').filter((category) => category !== 'memory')
    ?? ['conversation', 'issue', 'file', 'symbol'];

  if (!query || query.length < 2) {
    return NextResponse.json({ results: [], query: query ?? '', categories });
  }

  try {
    // Run searches in parallel
    // Agent search is done client-side to avoid oversized URLs (inventory is ~30KB)
    const searches = await Promise.allSettled([
      categories.includes('conversation') ? searchConversations(query) : Promise.resolve([]),
      categories.includes('issue') ? searchIssues(query, repo) : Promise.resolve([]),
      categories.includes('file') ? Promise.resolve(searchFiles(query, workspace)) : Promise.resolve([]),
      categories.includes('symbol') ? Promise.resolve(searchSymbolsProvider(query, workspace)) : Promise.resolve([]),
    ]);

    const allResults: UniversalResult[] = [];
    for (const result of searches) {
      if (result.status === 'fulfilled') {
        allResults.push(...result.value);
      }
    }

    // Sort by score descending
    allResults.sort((a, b) => b.score - a.score);

    return NextResponse.json({
      results: allResults.slice(0, 25),
      query,
      categories,
    });
  } catch {
    return NextResponse.json(
      { results: [], query, error: 'Search failed', categories },
      { status: 500 },
    );
  }
}
