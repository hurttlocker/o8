/**
 * Shared owned-session index (perf, 2026-07-03).
 *
 * Three timer sweepers — the silent-exit detector (twice per 30s tick) and the
 * lane zombie reaper (per 5-min tick) — each resolved a lane's owned session by
 * `readdir`+parsing EVERY `session.json` under the owned roots, per lane. That
 * is O(active-lanes × sessions) fs reads per tick with no sharing, and two
 * copies of the same `readOwnedActiveRun` loop. This module scans each root
 * ONCE and memoizes the result for a short TTL, so every per-lane lookup inside
 * a tick (and across sweepers within the window) shares one scan.
 *
 * TTL is deliberately tiny (2s): liveness does not change faster than a sweeper
 * tick, and every consumer's grace window (>= 45s) dwarfs 2s of staleness, so
 * the memo can never make a live session look dead or vice-versa within a
 * decision window. Semantics are byte-identical to the old per-file loop:
 *   - lookup returns `null`  → surfaceId not present under its root
 *   - lookup returns `{}`    → present but `activeRun` cleared (definitively dead)
 *   - lookup returns `{pid?, tmuxSession?}` → present with an active run
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export interface OwnedActiveRun {
  pid?: number;
  tmuxSession?: string;
}

/** Resolve the owned roots FRESH per call — env may be set after import (tests),
 *  and the resolution is cheap. */
export function ownedRoots(): ReadonlyArray<{ marker: string; root: string }> {
  return [
    {
      marker: 'codex-owned:',
      root: process.env.CORTEX_IDE_OWNED_CODEX_ROOT || path.join(getDataDir(), 'owned-codex'),
    },
    {
      marker: 'claude-code-owned:',
      root: process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT || path.join(getDataDir(), 'owned-claude-code'),
    },
    {
      marker: 'gemini-owned:',
      root: process.env.O8_OWNED_GEMINI_ROOT || path.join(getDataDir(), 'owned-gemini'),
    },
    {
      marker: 'opencode-owned:',
      root: process.env.O8_OWNED_OPENCODE_ROOT || path.join(getDataDir(), 'owned-opencode'),
    },
  ];
}

const INDEX_TTL_MS = 2_000;

/** Per-root memo: surfaceId → activeRun (or {} when cleared). */
type RootIndex = Map<string, OwnedActiveRun>;
const rootCache = new Map<string, { builtAt: number; index: RootIndex }>();

async function buildRootIndex(root: string): Promise<RootIndex> {
  const index: RootIndex = new Map();
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return index; // root missing — every lookup under it resolves to "gone".
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return;
    const metadataPath = path.join(root, entry.name, 'session.json');
    let raw: string;
    try {
      raw = await readFile(metadataPath, 'utf-8');
    } catch {
      return;
    }
    let parsed: { surfaceId?: string; activeRun?: OwnedActiveRun };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      return;
    }
    if (typeof parsed.surfaceId !== 'string') return;
    index.set(parsed.surfaceId, parsed.activeRun
      ? {
          pid: typeof parsed.activeRun.pid === 'number' ? parsed.activeRun.pid : undefined,
          tmuxSession: typeof parsed.activeRun.tmuxSession === 'string' ? parsed.activeRun.tmuxSession : undefined,
        }
      : {});
  }));
  return index;
}

async function getRootIndex(root: string, now: number): Promise<RootIndex> {
  const cached = rootCache.get(root);
  if (cached && now - cached.builtAt < INDEX_TTL_MS) return cached.index;
  const index = await buildRootIndex(root);
  rootCache.set(root, { builtAt: now, index });
  return index;
}

/**
 * Resolve a lane's owned active run, sharing a per-root scan across all callers
 * within the TTL. Returns `null` when the surfaceId is not present under its
 * matching root; `{}` when present-but-cleared; the run otherwise.
 */
export async function lookupOwnedActiveRun(surfaceId: string, now: number = Date.now()): Promise<OwnedActiveRun | null> {
  const match = ownedRoots().find((r) => surfaceId.startsWith(r.marker));
  if (!match) return null;
  const index = await getRootIndex(match.root, now);
  return index.get(surfaceId) ?? null;
}

/** Test-only: drop the memo so a test's fs writes are read fresh. */
export function resetOwnedSessionIndex(): void {
  rootCache.clear();
}
