export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { listRepos } from '@/lib/repos/registry';

const HOME = process.env.HOME ?? '/tmp';
const STATE_DIR = path.join(HOME, '.cortex-ide');
const STATE_SCOPE_DIR = path.join(STATE_DIR, 'terminal-states');
const LEGACY_STATE_FILE = path.join(STATE_DIR, 'terminal-state.json');

function sanitizeScope(rawScope: string | null) {
  const trimmed = rawScope?.trim() || 'tile-root';
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120) || 'tile-root';
}

function getStateFile(scope: string) {
  return path.join(STATE_SCOPE_DIR, `${scope}.json`);
}

function normalizeScopePath(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed.replace(/^~(?=\/|$)/, HOME)).replace(/\/+$/, '');
}

function pathBelongsToRegisteredRepo(candidatePath?: string | null, repoRoots?: Set<string>) {
  const normalizedCandidate = normalizeScopePath(candidatePath);
  if (!normalizedCandidate || !repoRoots || repoRoots.size === 0) return false;
  for (const repoRoot of repoRoots) {
    if (normalizedCandidate === repoRoot || normalizedCandidate.startsWith(`${repoRoot}/`)) {
      return true;
    }
  }
  return false;
}

function filterStateToRegisteredRepos(data: unknown, repoRoots: Set<string>) {
  const tabs = Array.isArray((data as { tabs?: Array<{ repoPath?: string | null }> })?.tabs)
    ? (data as { tabs: Array<{ repoPath?: string | null; id?: string }> }).tabs
    : [];
  if (tabs.length === 0) return data;
  const filteredTabs = tabs.filter((tab) => !tab.repoPath || pathBelongsToRegisteredRepo(tab.repoPath, repoRoots));
  if (filteredTabs.length === tabs.length) return data;
  if (filteredTabs.length === 0) return null;

  const current = data as { activeTabId?: string; [key: string]: unknown };
  const nextActiveTabId = filteredTabs.some((tab) => tab.id === current.activeTabId)
    ? current.activeTabId
    : filteredTabs[0]?.id;

  return {
    ...current,
    activeTabId: nextActiveTabId,
    tabs: filteredTabs,
  };
}

function stateMatchesRepoPath(data: unknown, repoPath: string) {
  return Array.isArray((data as { tabs?: Array<{ repoPath?: string }> })?.tabs)
    && (data as { tabs: Array<{ repoPath?: string }> }).tabs.some((tab) => tab.repoPath === repoPath);
}

function repoStateStats(data: unknown, repoPath: string) {
  const tabs = Array.isArray((data as { tabs?: Array<{ repoPath?: string; kind?: string }> })?.tabs)
    ? (data as { tabs: Array<{ repoPath?: string; kind?: string }> }).tabs
    : [];
  const matchingTabs = tabs.filter((tab) => tab.repoPath === repoPath);
  return {
    matchingCount: matchingTabs.length,
    llmChatOnly: matchingTabs.length > 0 && matchingTabs.every((tab) => tab.kind === 'llm-chat'),
  };
}

function findLatestRepoState(repoPath: string, excludeFile?: string | null) {
  if (!existsSync(STATE_SCOPE_DIR)) {
    return null;
  }

  const candidates = readdirSync(STATE_SCOPE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const fullPath = path.join(STATE_SCOPE_DIR, file);
      if (excludeFile && fullPath === excludeFile) {
        return null;
      }
      try {
        const parsed = JSON.parse(readFileSync(fullPath, 'utf-8'));
        const stats = repoStateStats(parsed, repoPath);
        if (stats.matchingCount === 0) {
          return null;
        }
        const savedAt = typeof parsed?.savedAt === 'string'
          ? Date.parse(parsed.savedAt)
          : statSync(fullPath).mtimeMs;
        return {
          matchingCount: stats.matchingCount,
          savedAt: Number.isFinite(savedAt) ? savedAt : statSync(fullPath).mtimeMs,
          data: parsed,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { matchingCount: number; savedAt: number; data: unknown } => Boolean(entry))
    .sort((a, b) => {
      if (b.matchingCount !== a.matchingCount) return b.matchingCount - a.matchingCount;
      return b.savedAt - a.savedAt;
    });

  return candidates[0]?.data ?? null;
}

/** GET — load persisted tab state */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = sanitizeScope(url.searchParams.get('scope'));
    const repoPath = url.searchParams.get('repoPath');
    const repoRoots = new Set((await listRepos()).map((repo) => normalizeScopePath(repo.localPath)).filter((value): value is string => Boolean(value)));
    if (repoRoots.size === 0) {
      return NextResponse.json(null, { status: 404 });
    }
    const stateFile = getStateFile(scope);

    if (existsSync(stateFile)) {
      const data = filterStateToRegisteredRepos(JSON.parse(readFileSync(stateFile, 'utf-8')), repoRoots);
      if (!data) {
        return NextResponse.json(null, { status: 404 });
      }
      if (!repoPath) {
        return NextResponse.json(data);
      }
      if (stateMatchesRepoPath(data, repoPath)) {
        const currentStats = repoStateStats(data, repoPath);
        const fallback = findLatestRepoState(repoPath, stateFile);
        if (fallback) {
          const fallbackStats = repoStateStats(fallback, repoPath);
          const shouldPreferFallback = currentStats.llmChatOnly && fallbackStats.matchingCount > currentStats.matchingCount;
          if (shouldPreferFallback) {
            return NextResponse.json(fallback);
          }
        }
        return NextResponse.json(data);
      }
    }

    if (scope === 'tile-root' && existsSync(LEGACY_STATE_FILE)) {
      const data = filterStateToRegisteredRepos(JSON.parse(readFileSync(LEGACY_STATE_FILE, 'utf-8')), repoRoots);
      if (!data) {
        return NextResponse.json(null, { status: 404 });
      }
      return NextResponse.json(data);
    }

    if (repoPath) {
      const fallback = findLatestRepoState(repoPath);
      if (fallback) {
        return NextResponse.json(fallback);
      }
    }

    return NextResponse.json(null, { status: 404 });
  } catch {
    return NextResponse.json(null, { status: 404 });
  }
}

/** POST — save tab state */
export async function POST(request: Request) {
  try {
    const scope = sanitizeScope(new URL(request.url).searchParams.get('scope'));
    const state = await request.json();
    if (!existsSync(STATE_DIR)) {
      mkdirSync(STATE_DIR, { recursive: true });
    }
    if (!existsSync(STATE_SCOPE_DIR)) {
      mkdirSync(STATE_SCOPE_DIR, { recursive: true });
    }
    const serialized = JSON.stringify(state, null, 2);
    writeFileSync(getStateFile(scope), serialized);
    if (scope === 'tile-root') {
      writeFileSync(LEGACY_STATE_FILE, serialized);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save state' },
      { status: 500 },
    );
  }
}
