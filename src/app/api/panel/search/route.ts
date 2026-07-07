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
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { ensureGitHubIssues, resolveRepoSlug } from '@/lib/github-broker';
import { listRepos } from '@/lib/repos/registry';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getDataDir } from '@/lib/data-dir-migration';
import { parseDirectiveFile } from '@/lib/cortex/directives/parse';

const HOME = process.env.HOME || os.homedir();
const DEFAULT_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const CHAT_HISTORY_DIR = join(HOME, '.o8', 'chat-history');

type SearchKind = 'issue' | 'file' | 'agent' | 'chat' | 'directive';

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
    /** For chat-history rows — the chat-history tabId so the parent can
     *  reopen the thread via the existing `o8:open-history-chat` event. */
    chatTabId?: string;
    /** For directive rows — the directive id so the parent can route to
     *  the Settings → Operator Defaults surface or to a directive viewer. */
    directiveId?: string;
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
  const needle = query.toLowerCase();
  if (!needle) return [];

  try {
    const stdout = execFileSync(
      'find',
      [
        '.', '-maxdepth', '5', '-type', 'f',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.next/*',
        '-not', '-path', '*/target/*',
        '-not', '-path', '*/dist/*',
        '-not', '-path', '*/out/*',
      ],
      { cwd: root, encoding: 'utf-8', timeout: 2500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    return stdout
      .split('\n')
      .filter((line) => line && line.toLowerCase().includes(needle))
      .slice(0, 10)
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

// ── Chat history (#984) ────────────────────────────────────────────────────

const CHAT_HISTORY_SCAN_CONCURRENCY = 16;

/** Map with a bounded number of in-flight async tasks, preserving input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index] as T);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(runner());
  await Promise.all(workers);
  return results;
}

/** Scan the on-disk chat-history dir for threads whose title or
 *  most-recent-message body contains the query. Keeps the read scope tight
 *  (mtime-sorted, capped, only the first user message + last message).
 *  Async + bounded-concurrency so a slow disk never blocks the request handler;
 *  results/ordering are identical to the former sync scan. */
async function searchChatHistory(query: string): Promise<SearchResult[]> {
  let files: string[];
  try {
    files = (await readdir(CHAT_HISTORY_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const lowered = query.toLowerCase();

  // Read mtime upfront so we can prefer recent threads when ranking. Order of
  // the stat calls is irrelevant — the results are sorted by mtime after.
  const statted = await mapWithConcurrency(files, CHAT_HISTORY_SCAN_CONCURRENCY, async (file) => {
    const filePath = join(CHAT_HISTORY_DIR, file);
    try {
      const s = await stat(filePath);
      return { file, filePath, mtimeMs: s.mtimeMs };
    } catch {
      return null;
    }
  });
  const ranked = statted
    .filter((entry): entry is { file: string; filePath: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 250);

  // Parse candidates in ranked (mtime-desc) windows, keeping order; a null means
  // the entry was skipped (empty thread, no match, or unreadable JSON). Stop
  // scheduling once 8 matches are collected — same tight read scope as before.
  const out: SearchResult[] = [];
  for (let i = 0; i < ranked.length && out.length < 8; i += CHAT_HISTORY_SCAN_CONCURRENCY) {
    const window = ranked.slice(i, i + CHAT_HISTORY_SCAN_CONCURRENCY);
    const parsed = await Promise.all(window.map(async (entry): Promise<SearchResult | null> => {
      try {
        const raw = await readFile(entry.filePath, 'utf-8');
        const data = JSON.parse(raw) as {
          title?: string;
          messages?: Array<{ role?: string; content?: string }>;
          repoName?: string | null;
          archivedAt?: string | null;
        };
        const tabId = basename(entry.file, '.json');
        // Skip placeholder / empty threads — those are typed-into-once-then-discarded.
        if (!data.messages || data.messages.length === 0) return null;

        const firstUser = data.messages.find((m) => m.role === 'user');
        const lastMsg = data.messages[data.messages.length - 1];
        const title = data.title
          || (firstUser?.content ? firstUser.content.slice(0, 60).replace(/\n/g, ' ') : 'Untitled');
        const preview = (lastMsg?.content ?? '').slice(0, 120).replace(/\n/g, ' ');

        const haystack = `${title}\n${preview}\n${data.repoName ?? ''}`.toLowerCase();
        if (!haystack.includes(lowered)) return null;

        const titleMatch = title.toLowerCase().includes(lowered) ? 30 : 0;
        const startsWith = title.toLowerCase().startsWith(lowered) ? 25 : 0;
        const archivedPenalty = data.archivedAt ? -15 : 0;
        const repoTag = data.repoName ? `${data.repoName} · ` : '';

        return {
          kind: 'chat',
          id: `chat:${tabId}`,
          title,
          detail: `${repoTag}${preview}`.trim().slice(0, 140),
          target: { chatTabId: tabId },
          score: 45 + titleMatch + startsWith + archivedPenalty,
        };
      } catch {
        // skip unreadable JSON files
        return null;
      }
    }));

    for (const result of parsed) {
      if (!result) continue;
      out.push(result);
      if (out.length >= 8) break;
    }
  }
  return out;
}

// ── Directives (#984) ──────────────────────────────────────────────────────

/** Scan `<dataDir>/directives/*.md` for entries whose title, scope, or body
 *  contains the query. Uses the same parser as the directive load pipeline. */
function searchDirectives(query: string): SearchResult[] {
  const directivesDir = join(getDataDir(), 'directives');
  let files: string[];
  try {
    files = readdirSync(directivesDir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const lowered = query.toLowerCase();
  const out: SearchResult[] = [];

  for (const file of files) {
    const filePath = join(directivesDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const fallbackId = basename(file, '.md');
      const parsed = parseDirectiveFile(raw, fallbackId);
      if (!parsed) continue;

      const title = parsed.title || parsed.id || file;
      const scope = parsed.scope || '';
      const body = parsed.body || '';
      const haystack = `${title}\n${scope}\n${parsed.repoName ?? ''}\n${body}`.toLowerCase();
      if (!haystack.includes(lowered)) continue;

      const titleMatch = title.toLowerCase().includes(lowered) ? 30 : 0;
      const startsWith = title.toLowerCase().startsWith(lowered) ? 20 : 0;
      const detailParts: string[] = [];
      if (scope) detailParts.push(scope);
      if (parsed.repoName) detailParts.push(parsed.repoName);
      const bodyPreview = body.split('\n').find((line) => line.trim().length > 0)?.slice(0, 100) ?? '';
      if (bodyPreview) detailParts.push(bodyPreview);

      out.push({
        kind: 'directive',
        id: `directive:${parsed.id}`,
        title,
        detail: detailParts.join(' · ').slice(0, 140),
        target: { directiveId: parsed.id },
        score: 42 + titleMatch + startsWith,
      });
      if (out.length >= 8) break;
    } catch {
      // skip unparseable files
    }
  }
  return out;
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
    chat: [],
    directive: [],
  };

  if (!query || query.length < 2) {
    return NextResponse.json({ query, results: [], groups: emptyGroups });
  }

  try {
    const [issues, files, agents, chats, directives] = await Promise.all([
      searchIssues(query, repoParam),
      Promise.resolve(searchFiles(query, workspace)),
      searchAgents(query),
      searchChatHistory(query),
      Promise.resolve(searchDirectives(query)),
    ]);

    const groups: Record<SearchKind, SearchResult[]> = {
      issue: issues.sort((a, b) => b.score - a.score).slice(0, 8),
      file: files.sort((a, b) => b.score - a.score).slice(0, 10),
      agent: agents.sort((a, b) => b.score - a.score).slice(0, 8),
      chat: chats.sort((a, b) => b.score - a.score).slice(0, 8),
      directive: directives.sort((a, b) => b.score - a.score).slice(0, 8),
    };

    const results = [...groups.agent, ...groups.issue, ...groups.file, ...groups.chat, ...groups.directive].sort(
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
