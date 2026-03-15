/**
 * Cortex CLI Client
 *
 * Wraps the `cortex` binary with typed JSON parsing.
 * Same pattern as `openclaw status --json` — shell out, parse, return typed data.
 *
 * All methods are safe: if Cortex is not installed or errors, they return
 * empty/default values instead of throwing. The UI degrades gracefully.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  CortexConflict,
  CortexHealthSummary,
  CortexQueryResult,
  CortexSearchResult,
  CortexStaleFact,
  CortexStats,
  ContextInjection,
  RecallCard,
} from './types';

const execFileAsync = promisify(execFile);

// ── Binary resolution ──

const CORTEX_BINARY = process.env.CORTEX_BINARY || path.join(os.homedir(), 'bin', 'cortex');
const EXEC_TIMEOUT = 8_000; // 8s max for any Cortex call
const CACHE_TTL_MS = 30_000; // 30s cache for stats/health

let cortexAvailable: boolean | null = null;

/**
 * Check if the Cortex binary exists and is executable.
 * Result is cached for the process lifetime.
 */
export async function isCortexAvailable(): Promise<boolean> {
  if (cortexAvailable !== null) return cortexAvailable;
  try {
    await access(CORTEX_BINARY);
    const { stdout } = await execFileAsync(CORTEX_BINARY, ['stats'], { timeout: 5_000 });
    cortexAvailable = stdout.includes('"memories"');
    return cortexAvailable;
  } catch {
    cortexAvailable = false;
    return false;
  }
}

/**
 * Run a Cortex CLI command and parse JSON output.
 * Returns null on any error (not installed, timeout, parse failure).
 */
async function runCortex<T>(args: string[]): Promise<T | null> {
  try {
    if (!(await isCortexAvailable())) return null;
    const { stdout } = await execFileAsync(CORTEX_BINARY, args, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return JSON.parse(stdout.trim()) as T;
  } catch (err) {
    console.error(`[cortex-client] Command failed: cortex ${args.join(' ')}`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Simple cache ──

const cache = new Map<string, { data: unknown; ts: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data as T;
  return null;
}

function setCache(key: string, data: unknown): void {
  cache.set(key, { data, ts: Date.now() });
}

// ── Public API ──

/**
 * Search Cortex memories. Returns ranked results.
 */
export async function cortexSearch(query: string, limit = 5): Promise<CortexSearchResult[]> {
  const results = await runCortex<CortexSearchResult[]>(['search', query, String(limit), '--json']);
  return results ?? [];
}

/**
 * Get memory statistics.
 */
export async function cortexStats(): Promise<CortexStats | null> {
  const cached = getCached<CortexStats>('stats');
  if (cached) return cached;

  const stats = await runCortex<CortexStats>(['stats']);
  if (stats) setCache('stats', stats);
  return stats;
}

/**
 * Get stale (decaying) facts.
 */
export async function cortexStale(limit = 10): Promise<CortexStaleFact[]> {
  const results = await runCortex<CortexStaleFact[]>(['stale', '--limit', String(limit), '--json']);
  return results ?? [];
}

/**
 * Get conflicting facts.
 */
export async function cortexConflicts(limit = 10): Promise<CortexConflict[]> {
  const results = await runCortex<CortexConflict[]>(['conflicts', '--limit', String(limit)]);
  return results ?? [];
}

/**
 * Reinforce a fact (reset decay timer).
 */
export async function cortexReinforce(factId: number): Promise<boolean> {
  const result = await runCortex<{ ok?: boolean }>(['reinforce', String(factId)]);
  cache.delete('stats'); // Invalidate stats cache
  return result !== null;
}

/**
 * Supersede a fact with another.
 */
export async function cortexSupersede(factId: number): Promise<boolean> {
  const result = await runCortex<{ ok?: boolean }>(['supersede', String(factId)]);
  cache.delete('stats');
  return result !== null;
}

/**
 * Retire a fact (mark as no longer relevant).
 */
export async function cortexRetire(factId: number): Promise<boolean> {
  const result = await runCortex<{ ok?: boolean }>(['beliefs', 'set', 'retired', String(factId)]);
  cache.delete('stats');
  return result !== null;
}

/**
 * Query facts by metadata filters.
 */
export async function cortexQuery(where: string, limit = 10): Promise<CortexQueryResult[]> {
  const results = await runCortex<CortexQueryResult[]>(['query', '--where', where, '--limit', String(limit)]);
  return results ?? [];
}

/**
 * Get a synthesized answer from Cortex (LLM-powered).
 */
export async function cortexAnswer(query: string): Promise<string | null> {
  const result = await runCortex<{ answer: string }>(['answer', query, '--json']);
  return result?.answer ?? null;
}

// ── Composed Operations (for UI surfaces) ──

/**
 * Build recall cards from search results.
 * Maps raw Cortex search output to UI-friendly cards.
 */
export async function getRecallCards(query: string, limit = 5): Promise<RecallCard[]> {
  const results = await cortexSearch(query, limit);
  return results.map((r) => ({
    id: r.memory_id,
    memoryId: r.memory_id,
    text: r.snippet || r.content.slice(0, 200),
    factType: (r.class as RecallCard['factType']) || 'state',
    confidence: r.score,
    source: shortenPath(r.source_file),
    sourceSection: r.source_section,
    age: formatAge(r.imported_at),
    score: r.score,
  }));
}

/**
 * Build full health summary for the dashboard.
 * Runs stats + stale + conflicts in parallel.
 */
export async function getHealthSummary(): Promise<CortexHealthSummary> {
  if (!(await isCortexAvailable())) {
    return {
      stats: emptyStats(),
      staleFacts: [],
      conflicts: [],
      available: false,
      error: 'Cortex binary not found. Install from https://github.com/hurttlocker/cortex',
    };
  }

  const cached = getCached<CortexHealthSummary>('health');
  if (cached) return cached;

  const [stats, staleFacts, conflicts] = await Promise.all([
    cortexStats(),
    cortexStale(10),
    cortexConflicts(5),
  ]);

  const summary: CortexHealthSummary = {
    stats: stats ?? emptyStats(),
    staleFacts,
    conflicts,
    available: stats !== null,
    error: stats === null ? 'Failed to read Cortex stats' : undefined,
  };

  setCache('health', summary);
  return summary;
}

/**
 * Build context injection for pre-launch.
 * Searches for relevant facts and formats them as an agent context block.
 */
export async function getContextInjection(
  prompt: string,
  cwd?: string,
  branch?: string,
): Promise<ContextInjection> {
  // Build a richer query from prompt + workspace context
  const queryParts = [prompt];
  if (cwd) queryParts.push(path.basename(cwd));
  if (branch) queryParts.push(branch);
  const query = queryParts.join(' ').slice(0, 200);

  const cards = await getRecallCards(query, 5);

  // Filter to high-relevance results only
  const relevant = cards.filter((c) => c.score > 0.4);

  if (relevant.length === 0) {
    return { facts: [], contextBlock: '', factCount: 0 };
  }

  // Build the context block that gets prepended to the agent prompt
  const lines = relevant.map((fact, i) =>
    `${i + 1}. [${fact.factType}] ${fact.text} (${(fact.confidence * 100).toFixed(0)}% relevance)`,
  );

  const contextBlock = [
    '[INSTITUTIONAL MEMORY — from Cortex]',
    'The following facts are relevant to this task:',
    ...lines,
    'Consider these when making implementation decisions.',
    '---',
  ].join('\n');

  return {
    facts: relevant,
    contextBlock,
    factCount: relevant.length,
  };
}

// ── Helpers ──

function shortenPath(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatAge(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const hours = ms / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

function emptyStats(): CortexStats {
  return {
    memories: 0,
    facts: 0,
    sources: 0,
    storage_bytes: 0,
    avg_confidence: 0,
    facts_by_type: { config: 0, decision: 0, identity: 0, kv: 0, location: 0, preference: 0, relationship: 0, state: 0, temporal: 0 },
    freshness: { today: 0, this_week: 0, this_month: 0, older: 0 },
    growth: { memories_24h: 0, memories_7d: 0, facts_24h: 0, facts_7d: 0 },
    alerts: [],
    confidence_distribution: { high: 0, medium: 0, low: 0, total: 0 },
    date_range: '',
  };
}
