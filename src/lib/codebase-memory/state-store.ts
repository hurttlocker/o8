/**
 * Persisted last-indexed git HEAD per repo.
 *
 * Lives at <data-dir>/codebase-memory-state.json. The boot indexer reads
 * this on startup, compares each repo's current HEAD against the recorded
 * one, and skips re-indexing when they match. Writes happen after every
 * successful index_repository call.
 *
 * Failures are swallowed — losing this state just means we re-index next
 * boot, which is the conservative thing to do.
 */

import 'server-only';

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import type { PersistedIndexState } from './types';

const STATE_FILE = 'codebase-memory-state.json';

function statePath(): string {
  return join(getDataDir(), STATE_FILE);
}

function emptyState(): PersistedIndexState {
  return { version: 1, heads: {} };
}

export function readPersistedIndexState(): PersistedIndexState {
  const path = statePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedIndexState>;
    if (!parsed || typeof parsed !== 'object' || !parsed.heads) return emptyState();
    return { version: 1, heads: parsed.heads as PersistedIndexState['heads'] };
  } catch {
    return emptyState();
  }
}

export function recordIndexedHead(
  repoId: string,
  head: string,
  indexedAt: string = new Date().toISOString(),
): void {
  try {
    const dir = getDataDir();
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        return;
      }
    }
    const current = readPersistedIndexState();
    current.heads[repoId] = { head, indexedAt };
    writeFileSync(statePath(), `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
  } catch {
    // Lossy on purpose — index will retry next boot.
  }
}

export function getRecordedHead(repoId: string): string | null {
  const state = readPersistedIndexState();
  return state.heads[repoId]?.head ?? null;
}
