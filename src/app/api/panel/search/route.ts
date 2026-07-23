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
import { execFile } from 'node:child_process';
import os from 'node:os';
import { readdirSync, readFileSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { ensureGitHubIssues, normalizeRepoSlug, resolveRepoSlug } from '@/lib/github-broker';
import { listLanes } from '@/lib/lane/registry';
import { agentDisplayLabel } from '@/lib/orchestrator/display';
import { listRepos } from '@/lib/repos/registry';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { getDataDir } from '@/lib/data-dir-migration';
import { parseDirectiveFile } from '@/lib/cortex/directives/parse';

const HOME = process.env.HOME || os.homedir();
const CHAT_HISTORY_DIR = join(getDataDir(), 'chat-history');
const execFileAsync = promisify(execFile);

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

function safeRoot(workspace: string): string {
  return workspace.startsWith('~') ? workspace.replace('~', HOME) : workspace;
}

// ── Issues ─────────────────────────────────────────────────────────────────

async function searchIssuesForRepo(
  query: string,
  repoSlug: string,
  browse = false,
): Promise<SearchResult[]> {
  const result = await ensureGitHubIssues(repoSlug).catch(() => null);
  if (!result) return [];

  const lowered = query.toLowerCase();
  const issues = result.issues
    .filter((issue) => {
      if (browse) return issue.state === 'open';
      const haystack = `${issue.title}\n${issue.body ?? ''}\n#${issue.number}`.toLowerCase();
      return haystack.includes(lowered);
    })
    .sort((left, right) => browse
      ? Date.parse(right.updatedAt || right.createdAt) - Date.parse(left.updatedAt || left.createdAt)
      : 0)
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
        score: browse
          ? Date.parse(issue.updatedAt || issue.createdAt)
          : 70 + titleStarts + numberHit + stateBonus,
      };
    });
  return issues;
}

async function registeredRepoSlug(
  repo: RepoRegistryEntry,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const cached = cache.get(repo.localPath);
  if (cached !== undefined) return cached;

  let slug = normalizeRepoSlug(repo.remoteUrl);
  if (!slug && repo.isGitRepo !== false) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', repo.localPath, 'config', '--get', 'remote.origin.url'],
        { encoding: 'utf-8', timeout: 2_500, maxBuffer: 128 * 1024 },
      );
      slug = normalizeRepoSlug(stdout.trim());
    } catch {
      slug = null;
    }
  }
  cache.set(repo.localPath, slug);
  return slug;
}

async function resolveIssueRepoSlugs(repoLike: string | null, cap: number): Promise<string[]> {
  if (repoLike && /^[\w.-]+\/[\w.-]+$/.test(repoLike)) return [repoLike];

  const repos = await listRepos().catch(() => []);
  const cache = new Map<string, string | null>();

  if (repoLike) {
    const resolved = await resolveRepoSlug(repoLike, '');
    if (resolved) return [resolved];
    const normalized = repoLike.toLowerCase();
    const match = repos.find((repo) => (
      repo.name.toLowerCase() === normalized
      || repo.localPath.toLowerCase() === normalized
    ));
    if (!match) return [];
    const slug = await registeredRepoSlug(match, cache);
    return slug ? [slug] : [];
  }

  const resolvedSlugs = await Promise.all(
    repos
      .slice(0, 6)
      .map((repo) => registeredRepoSlug(repo, cache)),
  );
  return Array.from(new Set(resolvedSlugs.filter((slug): slug is string => Boolean(slug)))).slice(0, cap);
}

async function searchIssues(
  query: string,
  repoLike: string | null,
): Promise<SearchResult[]> {
  const slugs = await resolveIssueRepoSlugs(repoLike, repoLike ? 1 : 4);

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

async function browseIssues(repoLike: string | null): Promise<SearchResult[]> {
  if (!repoLike) return [];
  const [slug] = await resolveIssueRepoSlugs(repoLike, 1);
  return slug ? searchIssuesForRepo('', slug, true) : [];
}

// ── Files (server-side filename search via find) ───────────────────────────

interface FileSearchRoot {
  localPath: string;
  repoName: string | null;
}

function sanitizeFilenameNeedle(query: string): string {
  return query
    .replace(/[\\/'"`*?\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchFilesInRoot(query: string, root: FileSearchRoot): Promise<SearchResult[]> {
  const needle = sanitizeFilenameNeedle(query);
  if (!needle) return [];

  try {
    const { stdout } = await execFileAsync(
      'find',
      [
        '.', '-maxdepth', '5',
        '(',
        '-path', '*/.git',
        '-o', '-path', '*/node_modules',
        '-o', '-path', '*/.next',
        '-o', '-path', '*/target',
        '-o', '-path', '*/dist',
        '-o', '-path', '*/out',
        '-o', '-path', '*/build',
        '-o', '-path', '*/.cortex-worktrees',
        '-o', '-path', '*/.agents',
        '-o', '-path', '*/.codex',
        '-o', '-path', '*/.claude/worktrees',
        ')', '-prune', '-o',
        '-type', 'f',
        '(', '-iname', `*${needle}*`, '-o', '-ipath', `*${needle}*`, ')',
        '-print',
      ],
      {
        cwd: root.localPath,
        encoding: 'utf-8',
        timeout: 2_500,
        maxBuffer: 1024 * 1024,
      },
    );

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map<SearchResult>((line, index) => {
        const cleaned = line.startsWith('./') ? line.slice(2) : line;
        const filename = cleaned.split('/').pop() ?? cleaned;
        const lowered = needle.toLowerCase();
        const pathParts = cleaned.split('/');
        const exact = filename.toLowerCase() === lowered ? 60 : 0;
        const starts = filename.toLowerCase().startsWith(lowered) ? 25 : 0;
        const directoryMatch = dirname(cleaned).toLowerCase().includes(lowered) ? 30 : 0;
        const exactDirectoryMatch = pathParts
          .slice(0, -1)
          .some((part) => part.toLowerCase() === lowered) ? 20 : 0;
        const detail = root.repoName ? `${root.repoName} · ${cleaned}` : cleaned;
        return {
          kind: 'file',
          id: `file:${root.localPath}:${cleaned}`,
          title: filename,
          detail,
          target: { filePath: root.repoName ? join(root.localPath, cleaned) : cleaned },
          score: 50 + exact + starts + directoryMatch + exactDirectoryMatch
            - (pathParts.length / 10) - (index / 10_000),
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function searchFiles(query: string, workspace: string | null): Promise<SearchResult[]> {
  const roots: FileSearchRoot[] = workspace
    ? [{ localPath: safeRoot(workspace), repoName: null }]
    : (await listRepos().catch(() => [])).slice(0, 3).map((repo) => ({
        localPath: repo.localPath,
        repoName: repo.name,
      }));
  if (roots.length === 0) return [];

  const matches = await Promise.all(roots.map((root) => searchFilesInRoot(query, root)));
  return matches.flat().sort((left, right) => right.score - left.score).slice(0, 10);
}

// ── Agents ─────────────────────────────────────────────────────────────────

function parseAgentTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function searchAgents(query: string, browse = false): Promise<SearchResult[]> {
  const lowered = query.toLowerCase();
  const out: SearchResult[] = [];
  const seenSessionKeys = new Set<string>();

  try {
    const snapshot = await getRuntimeInventorySnapshot();
    for (const agent of snapshot.agents) {
      const sessionKey = agent.sessionKey || agent.id;
      if (!sessionKey) continue;
      const name = agentDisplayLabel({
        name: agent.name,
        sessionKey,
        runtime: agent.runtime,
      });
      const matchedName = name.toLowerCase().includes(lowered);
      const matchedTask = (agent.currentTask ?? '').toLowerCase().includes(lowered);
      const matchedModel = (agent.model ?? '').toLowerCase().includes(lowered);
      const matchedBranch = (agent.branch ?? '').toLowerCase().includes(lowered);
      const matchedWorkspace = (agent.workspace ?? '').toLowerCase().includes(lowered);
      const matchedStatus = String(agent.status ?? '').toLowerCase().includes(lowered);
      const strongRetiredMatch = matchedName || (agent.workspace ?? '').toLowerCase() === lowered;
      if (!browse && (
        (!matchedName && !matchedTask && !matchedModel && !matchedBranch && !matchedWorkspace && !matchedStatus)
        || (agent.status === 'completed' && !strongRetiredMatch)
      )) continue;

      const detailParts = [agent.status, agent.runtime, agent.branch].filter(Boolean).map(String);
      out.push({
        kind: 'agent',
        id: `agent:${sessionKey}`,
        title: name,
        detail: detailParts.join(' · ') || (agent.currentTask ?? '').slice(0, 80),
        target: { sessionKey },
        score: browse
          ? 1_000_000 + (agent.lastActivityAt ?? 0)
          : 40
            + (matchedName ? 30 : 0)
            + (matchedTask ? 12 : 0)
            + (matchedBranch ? 8 : 0)
            + (matchedWorkspace ? 6 : 0)
            + (matchedModel ? 4 : 0)
            + (matchedStatus ? 2 : 0),
      });
      seenSessionKeys.add(sessionKey);
    }
  } catch {
    // The durable lanes below still make the palette useful when discovery is down.
  }

  let laneList: ReturnType<typeof listLanes> = [];
  try {
    laneList = listLanes()
      .filter((lane) => Boolean(lane.sessionKey))
      .sort((left, right) => (
        parseAgentTimestamp(right.lastEventAt ?? right.updatedAt ?? right.createdAt)
        - parseAgentTimestamp(left.lastEventAt ?? left.updatedAt ?? left.createdAt)
      ));
  } catch {
    return out;
  }

  const activeLanes = laneList.filter((lane) => (
    lane.status !== 'archived' && lane.status !== 'completed' && lane.status !== 'failed'
  ));
  const browseLanes = activeLanes.length > 0
    ? activeLanes.slice(0, 8)
    : out.length === 0 ? laneList.slice(0, 8) : [];
  const candidates = browse ? browseLanes : laneList;

  for (const lane of candidates) {
    const sessionKey = lane.sessionKey;
    if (!sessionKey || seenSessionKeys.has(sessionKey)) continue;
    const repoName = basename(lane.repoPath);
    const label = agentDisplayLabel({
      name: lane.label,
      sessionKey,
      runtime: lane.runtime,
    });
    const labelMatch = label.toLowerCase().includes(lowered);
    const repoMatch = repoName.toLowerCase().includes(lowered) || lane.repoPath.toLowerCase().includes(lowered);
    const branchMatch = lane.branch.toLowerCase().includes(lowered);
    const runtimeMatch = lane.runtime.toLowerCase().includes(lowered);
    const statusMatch = lane.status.toLowerCase().includes(lowered);
    const eventMatch = (lane.lastEventLabel ?? '').toLowerCase().includes(lowered);
    const matches = labelMatch || repoMatch || branchMatch || runtimeMatch || statusMatch || eventMatch;
    const retired = lane.status === 'archived' || lane.status === 'completed';
    const strongRetiredMatch = labelMatch
      || repoName.toLowerCase() === lowered
      || lane.branch.toLowerCase() === lowered;
    if (!browse && (!matches || (retired && !strongRetiredMatch))) continue;

    out.push({
      kind: 'agent',
      id: `agent:${sessionKey}`,
      title: label,
      detail: [lane.status, repoName, lane.runtime].join(' · '),
      target: { sessionKey },
      score: browse
        ? parseAgentTimestamp(lane.lastEventAt ?? lane.updatedAt ?? lane.createdAt)
        : 35
          + (labelMatch ? 35 : 0)
          + (repoMatch ? 10 : 0)
          + (branchMatch ? 8 : 0)
          + (runtimeMatch ? 5 : 0)
          + (eventMatch ? 3 : 0)
          - (retired ? 20 : 0),
    });
    seenSessionKeys.add(sessionKey);
    if (!browse && out.length >= 12) break;
  }

  return out.sort((left, right) => right.score - left.score);
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
async function searchChatHistory(query: string, browse = false): Promise<SearchResult[]> {
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
        if (!browse && !haystack.includes(lowered)) return null;

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
          score: browse ? entry.mtimeMs : 45 + titleMatch + startsWith + archivedPenalty,
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
function searchDirectives(query: string, browse = false): SearchResult[] {
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
      if (!browse && !haystack.includes(lowered)) continue;

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
        score: browse ? parsed.priority ?? 0 : 42 + titleMatch + startsWith,
      });
      if (!browse && out.length >= 8) break;
    } catch {
      // skip unparseable files
    }
  }
  return out
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, browse ? 10 : 8);
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<NextResponse<SearchResponse>> {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') ?? '').trim();
  const workspace = searchParams.get('workspace');
  const repoParam = searchParams.get('repo');
  const scopeParam = searchParams.get('scope');

  const emptyGroups: Record<SearchKind, SearchResult[]> = {
    issue: [],
    file: [],
    agent: [],
    chat: [],
    directive: [],
  };

  try {
    if (query.length < 2) {
      const browseKind = scopeParam === 'agent'
        || scopeParam === 'chat'
        || scopeParam === 'directive'
        || scopeParam === 'issue'
        || scopeParam === 'file'
        ? scopeParam
        : null;
      if (!browseKind) return NextResponse.json({ query, results: [], groups: emptyGroups });

      const browseResults = browseKind === 'agent'
        ? await searchAgents('', true)
        : browseKind === 'chat'
          ? await searchChatHistory('', true)
          : browseKind === 'directive'
            ? searchDirectives('', true)
            : browseKind === 'issue'
              ? await browseIssues(repoParam)
              : [];
      const groups = { ...emptyGroups, [browseKind]: browseResults };
      return NextResponse.json({ query, results: browseResults, groups });
    }

    const [issues, files, agents, chats, directives] = await Promise.all([
      searchIssues(query, repoParam),
      searchFiles(query, workspace),
      searchAgents(query),
      searchChatHistory(query),
      searchDirectives(query),
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
