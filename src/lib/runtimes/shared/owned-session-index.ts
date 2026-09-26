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
import { listOwnedSessionLifecycles } from './owned-session-lifecycle';
import { archiveRootForOwnedSessionRoot } from './owned-session/archive';

export interface OwnedActiveRun {
  id?: string;
  pid?: number;
  processGroupId?: number;
  tmuxSession?: string;
  commandIdentity?: string;
  processMarker?: string;
}

export interface IndexedOwnedActiveRun extends OwnedActiveRun {
  surfaceId: string;
}

export interface OwnedLaunchMutationMatch {
  surfaceId: string;
  cwd: string;
  repoPath: string;
  laneId?: string;
  packetId?: string;
  outcome: 'running' | 'finished' | 'interrupted' | 'failed';
}

export interface OwnedSessionDisplay {
  sessionKey: string;
  name: string;
  model: string | null;
  runtime: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'idle';
}

/** Resolve the owned roots FRESH per call — env may be set after import (tests),
 *  and the resolution is cheap. */
export function ownedRoots(): ReadonlyArray<{ marker: string; root: string }> {
  const roots = [
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
    {
      marker: 'cursor-owned:',
      root: process.env.O8_OWNED_CURSOR_ROOT || path.join(getDataDir(), 'owned-cursor'),
    },
    {
      marker: 'grok-owned:',
      root: process.env.O8_OWNED_GROK_ROOT || path.join(getDataDir(), 'owned-grok'),
    },
    {
      marker: 'prime-agent-owned:',
      root: process.env.O8_OWNED_PRIME_AGENT_ROOT || path.join(getDataDir(), 'owned-prime-agent'),
    },
    {
      marker: 'pi-owned:',
      root: process.env.O8_OWNED_PI_ROOT || path.join(getDataDir(), 'owned-pi'),
    },
  ];
  const seen = new Set(roots.map((entry) => entry.marker));
  for (const lifecycle of listOwnedSessionLifecycles()) {
    if (seen.has(lifecycle.surfaceIdPrefix)) continue;
    roots.push({ marker: lifecycle.surfaceIdPrefix, root: lifecycle.resolveRoot() });
    seen.add(lifecycle.surfaceIdPrefix);
  }
  return roots;
}

/** Resolve a pane's identity after its owned session leaves the live fleet. */
export async function readOwnedSessionDisplay(surfaceId: string): Promise<OwnedSessionDisplay | null> {
  const root = ownedRoots().find((entry) => surfaceId.startsWith(entry.marker));
  if (!root) return null;
  const directory = surfaceId.slice(root.marker.length);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(directory)) return null;

  for (const base of [root.root, archiveRootForOwnedSessionRoot(root.root)]) {
    let parsed: {
      surfaceId?: unknown;
      title?: unknown;
      model?: unknown;
      activeRun?: unknown;
      recentRuns?: Array<{ outcome?: unknown; startedAt?: unknown }>;
    };
    try {
      parsed = JSON.parse(await readFile(path.join(base, directory, 'session.json'), 'utf-8'));
    } catch {
      continue;
    }
    if (parsed.surfaceId !== surfaceId) continue;
    const outcome = Array.isArray(parsed.recentRuns)
      ? [...parsed.recentRuns].sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))[0]?.outcome
      : null;
    const status = parsed.activeRun ? 'running'
      : outcome === 'finished' ? 'completed'
        : outcome === 'failed' ? 'failed'
          : outcome === 'interrupted' ? 'interrupted'
            : 'idle';
    return {
      sessionKey: surfaceId,
      name: typeof parsed.title === 'string' && parsed.title.trim()
        ? parsed.title.trim().slice(0, 120)
        : root.marker.slice(0, -7),
      model: typeof parsed.model === 'string' && parsed.model.trim()
        ? parsed.model.trim().slice(0, 120) : null,
      runtime: root.marker.slice(0, -7),
      status,
    };
  }
  return null;
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
          id: typeof parsed.activeRun.id === 'string' ? parsed.activeRun.id : undefined,
          pid: typeof parsed.activeRun.pid === 'number' ? parsed.activeRun.pid : undefined,
          processGroupId: typeof parsed.activeRun.processGroupId === 'number'
            ? parsed.activeRun.processGroupId
            : undefined,
          tmuxSession: typeof parsed.activeRun.tmuxSession === 'string' ? parsed.activeRun.tmuxSession : undefined,
          commandIdentity: typeof parsed.activeRun.commandIdentity === 'string'
            ? parsed.activeRun.commandIdentity
            : undefined,
          processMarker: typeof parsed.activeRun.processMarker === 'string'
            ? parsed.activeRun.processMarker
            : undefined,
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

/** Safety-critical lookup that bypasses the short fleet cache before a kill. */
export async function lookupOwnedActiveRunFresh(surfaceId: string): Promise<OwnedActiveRun | null> {
  const match = ownedRoots().find((root) => surfaceId.startsWith(root.marker));
  if (!match) return null;
  const index = await buildRootIndex(match.root);
  rootCache.set(match.root, { builtAt: Date.now(), index });
  return index.get(surfaceId) ?? null;
}

/** List every owned session whose persisted metadata still carries an active run. */
export async function listOwnedActiveRuns(now: number = Date.now()): Promise<IndexedOwnedActiveRun[]> {
  const indexes = await Promise.all(ownedRoots().map(({ root }) => getRootIndex(root, now)));
  const active = new Map<string, IndexedOwnedActiveRun>();
  for (const index of indexes) {
    for (const [surfaceId, run] of index) {
      if (run.pid !== undefined || run.tmuxSession !== undefined) active.set(surfaceId, { surfaceId, ...run });
    }
  }
  return [...active.values()];
}

/**
 * Recover an o8-owned launch after the server died before receipt finalization.
 * The marker is written into session.json before spawn, so a match proves that
 * this exact mutation crossed the owned launch boundary.
 */
export async function findOwnedLaunchByMutationId(
  clientMutationId: string,
): Promise<OwnedLaunchMutationMatch | null> {
  // Finished workers may already have been archived by the time the lead
  // submits its review receipt. Search both roots for the exact launch marker.
  for (const root of ownedRoots().flatMap(({ root }) => [root, archiveRootForOwnedSessionRoot(root)])) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const parsed = JSON.parse(
          await readFile(path.join(root, entry.name, 'session.json'), 'utf-8'),
        ) as Partial<OwnedLaunchMutationMatch> & {
          launchMutationId?: unknown;
          activeRun?: { outcome?: unknown };
          recentRuns?: Array<{ outcome?: unknown }>;
        };
        if (parsed.launchMutationId !== clientMutationId
          || typeof parsed.surfaceId !== 'string'
          || typeof parsed.cwd !== 'string'
          || typeof parsed.repoPath !== 'string') continue;
        const rawOutcome = parsed.activeRun?.outcome ?? parsed.recentRuns?.[0]?.outcome;
        if (rawOutcome !== 'running' && rawOutcome !== 'finished'
          && rawOutcome !== 'interrupted' && rawOutcome !== 'failed') continue;
        return {
          surfaceId: parsed.surfaceId,
          cwd: parsed.cwd,
          repoPath: parsed.repoPath,
          laneId: typeof parsed.laneId === 'string' ? parsed.laneId : undefined,
          packetId: typeof parsed.packetId === 'string' ? parsed.packetId : undefined,
          outcome: rawOutcome,
        };
      } catch {
        // One corrupt session must not hide a valid correlated session.
      }
    }
  }
  return null;
}

/** Test-only: drop the memo so a test's fs writes are read fresh. */
export function resetOwnedSessionIndex(): void {
  rootCache.clear();
}
