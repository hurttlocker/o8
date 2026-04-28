/**
 * Cmd+K command palette fan-out search.
 *
 * Issue #661 — full-overlay command palette across the desktop app. This route
 * is the server-side fan-out used by the new CommandPalette component. The
 * older `/api/panel/universal-search` route still backs the inline TitleBar
 * search; this one is purpose-built for the overlay's grouped result shape.
 *
 * Categories returned:
 *   - issues  : open issues across registered repos (or the requested repo)
 *   - files   : repo file matches via `find` filename glob
 *   - agents  : runtime inventory agents matching name / task / model
 *
 * Recents are stored client-side in localStorage; the client merges them in
 * for the empty-query state. We do NOT touch localStorage from the server.
 *
 * Auth: covered by the global middleware via the `/api/panel/` GATED_PREFIX.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import os from 'node:os';
import { ensureGitHubIssues, resolveRepoSlug } from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

const HOME = process.env.HOME || os.homedir();
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();

type SearchKind = 'issue' | 'file' | 'agent';

interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string;
  /** Navigation hints — the client decides what to do with these. */
  target?: {
    issueNumber?: number;
    repo?: string;
    filePath?: string;
    line?: number;
    sessionKey?: string;
  };
  score: number;
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  groups: Record<SearchKind, SearchResult[]>;
  error?: string;
}

function safeRoot(workspace: string | null): string {
  if (!workspace) return DEFAULT_ROOT;
  return workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace;
}

// ── Issues ─────────────────────────────────────────────────────────────────

async function searchIssuesForRepo(
  query: string,
  repoSlug: string,
): Promise<SearchResult[]> {
  const result = await ensureGitHubIssues(repoSlug).catch(() => null);
  if (!result) return [];

  const lowered = query.toLowerCase();
  return result.issues
    .filter((issue) => {
      const haystack = `${issue.title}\n${issue.body ?? ''}\n#${issue.number}`.toLowerCase();
      return haystack.includes(lowered);
    })
    .slice(0, 8)
    .map<SearchResult>((issue) => {
      const titleStarts = issue.title.toLowerCase().startsWith(lowered) ? 30 : 0;
      const numberHit = String(issue.number) === query.replace(/^#/, '') ? 60 : 0;
      const stateBonus = issue.state === 'open' ? 10 : 0;
      return {
        kind: 'issue',
        id: `issue:${repoSlug}:${issue.number}`,
        title: `#${issue.number} ${issue.title}`,
        detail: `${repoSlug} · ${issue.state}${(issue.body ?? '').trim() ? ` · ${(issue.body ?? '').slice(0, 80)}` : ''}`,
        target: { issueNumber: issue.number, repo: repoSlug },
        score: 70 + titleStarts + numberHit + stateBonus,
      };
    });
}

async function searchIssues(
  query: string,
  repoLike: string | null,
): Promise<SearchResult[]> {
  // If a specific repo is requested, search only that one.
  if (repoLike) {
    const slug = await resolveRepoSlug(repoLike, '');
    if (!slug) return [];
    return searchIssuesForRepo(query, slug);
  }

  // Otherwise fan out across registered repos. Cap parallelism — large
  // operator fleets can have 10+ repos and we don't want to thrash the
  // GitHub broker on every keystroke.
  const repos = await listRepos().catch(() => []);
  const resolvedSlugs = await Promise.all(
    repos
      .slice(0, 6)
      .map((entry) => resolveRepoSlug(entry.remoteUrl ?? null, '').catch(() => null)),
  );
  const slugs = Array.from(
    new Set(resolvedSlugs.filter((s): s is string => Boolean(s))),
  ).slice(0, 4);

  if (slugs.length === 0) return [];

  const settled = await Promise.allSettled(
    slugs.map((slug) => searchIssuesForRepo(query, slug)),
  );

  const out: SearchResult[] = [];
  for (const entry of settled) {
    if (entry.status === 'fulfilled') out.push(...entry.value);
  }
  return out;
}

// ── Files (server-side fs glob via find) ───────────────────────────────────

function searchFiles(query: string, workspace: string | null): SearchResult[] {
  const root = safeRoot(workspace);
  const escaped = query.replace(/"/g, '');
  if (!escaped) return [];

  const cmd = `find . -maxdepth 5 -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/target/*' -not -path '*/dist/*' -not -path '*/out/*' | grep -i "${escaped}" | head -10`;

  try {
    const stdout = execSync(cmd, {
      cwd: root,
      encoding: 'utf-8',
      timeout: 2500,
      maxBuffer: 256 * 1024,
    }).trim();

    return stdout
      .split('\n')
      .filter(Boolean)
      .map<SearchResult>((line, index) => {
        const cleaned = line.startsWith('./') ? line.slice(2) : line;
        const basename = cleaned.split('/').pop() ?? cleaned;
        const lowered = query.toLowerCase();
        const exact = basename.toLowerCase() === lowered ? 60 : 0;
        const starts = basename.toLowerCase().startsWith(lowered) ? 25 : 0;
        return {
          kind: 'file',
          id: `file:${cleaned}`,
          title: basename,
          detail: cleaned,
          target: { filePath: cleaned },
          score: 50 + exact + starts - index, // slight ranking by find order
        };
      });
  } catch {
    return [];
  }
}

// ── Agents ─────────────────────────────────────────────────────────────────

async function searchAgents(query: string): Promise<SearchResult[]> {
  try {
    const snapshot = await getRuntimeInventorySnapshot();
    const lowered = query.toLowerCase();
    const out: SearchResult[] = [];
    for (const agent of snapshot.agents) {
      const name = (agent.name ?? '').toLowerCase();
      const task = (agent.currentTask ?? '').toLowerCase();
      const model = (agent.model ?? '').toLowerCase();
      const branch = (agent.branch ?? '').toLowerCase();
      const matchedName = name.includes(lowered);
      const matchedTask = task.includes(lowered);
      const matchedModel = model.includes(lowered);
      const matchedBranch = branch.includes(lowered);
      if (!matchedName && !matchedTask && !matchedModel && !matchedBranch) continue;
      const score = 40
        + (matchedName ? 30 : 0)
        + (matchedTask ? 12 : 0)
        + (matchedBranch ? 8 : 0)
        + (matchedModel ? 4 : 0);
      const detailParts: string[] = [];
      if (agent.status) detailParts.push(String(agent.status));
      if (agent.runtime) detailParts.push(String(agent.runtime));
      if (agent.branch) detailParts.push(agent.branch);
      out.push({
        kind: 'agent',
        id: `agent:${agent.sessionKey || agent.id}`,
        title: agent.name || 'Session',
        detail: detailParts.join(' · ') || (agent.currentTask ?? '').slice(0, 80),
        target: { sessionKey: agent.sessionKey || agent.id },
        score,
      });
      if (out.length >= 10) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse<SearchResponse>> {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') ?? '').trim();
  const workspace = searchParams.get('workspace');
  const repoParam = searchParams.get('repo');

  const emptyGroups: Record<SearchKind, SearchResult[]> = {
    issue: [],
    file: [],
    agent: [],
  };

  if (!query || query.length < 2) {
    return NextResponse.json({ query, results: [], groups: emptyGroups });
  }

  try {
    const [issues, files, agents] = await Promise.all([
      searchIssues(query, repoParam),
      Promise.resolve(searchFiles(query, workspace)),
      searchAgents(query),
    ]);

    const groups: Record<SearchKind, SearchResult[]> = {
      issue: issues.sort((a, b) => b.score - a.score).slice(0, 8),
      file: files.sort((a, b) => b.score - a.score).slice(0, 10),
      agent: agents.sort((a, b) => b.score - a.score).slice(0, 8),
    };

    const results = [...groups.agent, ...groups.issue, ...groups.file].sort(
      (a, b) => b.score - a.score,
    );

    return NextResponse.json({ query, results, groups });
  } catch (err) {
    return NextResponse.json(
      {
        query,
        results: [],
        groups: emptyGroups,
        error: err instanceof Error ? err.message : 'Search failed',
      },
      { status: 500 },
    );
  }
}
