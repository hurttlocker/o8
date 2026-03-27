export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';

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

function findLatestRepoState(repoPath: string) {
  if (!existsSync(STATE_SCOPE_DIR)) {
    return null;
  }

  const candidates = readdirSync(STATE_SCOPE_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const fullPath = path.join(STATE_SCOPE_DIR, file);
      try {
        const parsed = JSON.parse(readFileSync(fullPath, 'utf-8'));
        const matchesRepo = Array.isArray(parsed?.tabs)
          && parsed.tabs.some((tab: { repoPath?: string }) => tab.repoPath === repoPath);
        if (!matchesRepo) {
          return null;
        }
        const savedAt = typeof parsed?.savedAt === 'string'
          ? Date.parse(parsed.savedAt)
          : statSync(fullPath).mtimeMs;
        return {
          savedAt: Number.isFinite(savedAt) ? savedAt : statSync(fullPath).mtimeMs,
          data: parsed,
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { savedAt: number; data: unknown } => Boolean(entry))
    .sort((a, b) => b.savedAt - a.savedAt);

  return candidates[0]?.data ?? null;
}

/** GET — load persisted tab state */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const scope = sanitizeScope(url.searchParams.get('scope'));
    const repoPath = url.searchParams.get('repoPath');
    const stateFile = getStateFile(scope);

    if (existsSync(stateFile)) {
      const data = JSON.parse(readFileSync(stateFile, 'utf-8'));
      return NextResponse.json(data);
    }

    if (scope === 'tile-root' && existsSync(LEGACY_STATE_FILE)) {
      const data = JSON.parse(readFileSync(LEGACY_STATE_FILE, 'utf-8'));
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
