/**
 * Cortex Client — Local / Cloud / Hybrid
 *
 * Abstraction layer over the Cortex memory engine.
 * Three implementations:
 *   - LocalCortexClient  → shells out to `~/bin/cortex` binary (current behavior)
 *   - CloudCortexClient  → HTTPS to hosted Cortex cloud API (future)
 *   - HybridCortexClient → reads local, writes both, syncs periodically (future)
 *
 * All API routes call getCortexClient() which returns the correct implementation
 * based on environment config. Today that's always LocalCortexClient.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/223
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

// ── Configuration ──

const CORTEX_BINARY = process.env.CORTEX_BINARY || path.join(os.homedir(), 'bin', 'cortex');
const CORTEX_CLOUD_URL = process.env.CORTEX_CLOUD_URL || ''; // e.g. https://cortex-cloud.fly.dev
const CORTEX_CLOUD_TOKEN = process.env.CORTEX_CLOUD_TOKEN || '';
const CORTEX_MODE = (process.env.CORTEX_MODE || 'local') as 'local' | 'cloud' | 'hybrid';
const EXEC_TIMEOUT = 8_000;
const CACHE_TTL_MS = 30_000;

// ══════════════════════════════════════════════════════════════════
//  CortexClient Interface — the contract all implementations share
// ══════════════════════════════════════════════════════════════════

export interface CortexClient {
  /** Is this client's backing store reachable? */
  isAvailable(): Promise<boolean>;

  /** Search memories (BM25 + semantic hybrid). */
  search(query: string, limit?: number): Promise<CortexSearchResult[]>;

  /** Store a new memory (text → auto-extracted facts). */
  store(text: string, source?: string): Promise<{ ok: boolean; memoryId?: number }>;

  /** Get memory statistics. */
  stats(): Promise<CortexStats | null>;

  /** Get stale (decaying) facts. */
  stale(limit?: number): Promise<CortexStaleFact[]>;

  /** Get conflicting facts. */
  conflicts(limit?: number): Promise<CortexConflict[]>;

  /** Reinforce a fact (reset decay timer). */
  reinforce(factId: number): Promise<boolean>;

  /** Retire a fact (mark as no longer relevant). */
  retire(factId: number): Promise<boolean>;

  /** Supersede a fact (old replaced by new). */
  supersede(oldFactId: number, newFactId: number): Promise<boolean>;

  /** Query facts by metadata filters. */
  query(where: string, limit?: number): Promise<CortexQueryResult[]>;

  /** Get a synthesized answer from Cortex (LLM-powered). */
  answer(query: string): Promise<string | null>;

  /** Graph traversal from a subject or fact ID. */
  graph(options: { subject?: string; factId?: number; depth?: number }): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  } | null>;

  /** Get belief states (active/retired/superseded counts). */
  beliefs(): Promise<{ total: number; states: Record<string, number> } | null>;

  /** Inspect beliefs with structured fact data. */
  beliefsInspect(options?: { state?: string; limit?: number }): Promise<Array<Record<string, unknown>>>;

  /** Sync local ↔ cloud (only meaningful for HybridCortexClient). */
  sync?(): Promise<{ uploaded: number; downloaded: number; conflicts: number }>;
}

// ══════════════════════════════════════════════════════════════════
//  LocalCortexClient — shells out to the `cortex` binary
// ══════════════════════════════════════════════════════════════════

class LocalCortexClient implements CortexClient {
  private available: boolean | null = null;
  private availableCheckedAt = 0;
  private static readonly AVAILABLE_TTL_MS = 60_000;
  private cache = new Map<string, { data: unknown; ts: number }>();

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.available !== null && now - this.availableCheckedAt < LocalCortexClient.AVAILABLE_TTL_MS) {
      return this.available;
    }
    try {
      await access(CORTEX_BINARY);
      const { stdout } = await execFileAsync(CORTEX_BINARY, ['stats'], { timeout: 5_000 });
      this.available = stdout.includes('"memories"');
      this.availableCheckedAt = now;
      return this.available;
    } catch {
      this.available = false;
      this.availableCheckedAt = now;
      return false;
    }
  }

  private async run<T>(args: string[]): Promise<T | null> {
    try {
      if (!(await this.isAvailable())) return null;
      const { stdout } = await execFileAsync(CORTEX_BINARY, args, {
        timeout: EXEC_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' },
      });
      return JSON.parse(stdout.trim()) as T;
    } catch (err) {
      console.error(`[cortex-local] Command failed: cortex ${args.join(' ')}`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data as T;
    return null;
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, ts: Date.now() });
  }

  private invalidateCache(...keys: string[]): void {
    for (const k of keys) this.cache.delete(k);
  }

  async search(query: string, limit = 5): Promise<CortexSearchResult[]> {
    const results = await this.run<CortexSearchResult[]>(['search', query, String(limit), '--json']);
    return results ?? [];
  }

  async store(text: string, source?: string): Promise<{ ok: boolean; memoryId?: number }> {
    // Cortex has no `store` command — it's import-first.
    // Write text to a temp file and import it with --extract.
    const { writeFileSync, mkdirSync, unlinkSync } = await import('node:fs');
    const { join } = await import('node:path');
    const os = await import('node:os');

    const tmpDir = join(os.tmpdir(), 'cortex-chat-extract');
    mkdirSync(tmpDir, { recursive: true });

    const filename = source
      ? `${source.replace(/[^a-zA-Z0-9-_]/g, '_')}.md`
      : `chat-${Date.now()}.md`;
    const tmpFile = join(tmpDir, filename);

    writeFileSync(tmpFile, text, 'utf-8');

    try {
      const result = await this.run<{ imported?: number; memory_id?: number }>(
        ['import', tmpFile, '--extract']
      );
      this.invalidateCache('stats', 'health');
      return { ok: result !== null, memoryId: result?.memory_id };
    } finally {
      try { unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
    }
  }

  async stats(): Promise<CortexStats | null> {
    const cached = this.getCached<CortexStats>('stats');
    if (cached) return cached;
    const stats = await this.run<CortexStats>(['stats']);
    if (stats) this.setCache('stats', stats);
    return stats;
  }

  async stale(limit = 10): Promise<CortexStaleFact[]> {
    const results = await this.run<CortexStaleFact[]>(['stale', '--limit', String(limit), '--json']);
    return results ?? [];
  }

  async conflicts(limit = 10): Promise<CortexConflict[]> {
    const results = await this.run<CortexConflict[]>(['conflicts', '--limit', String(limit)]);
    return results ?? [];
  }

  async reinforce(factId: number): Promise<boolean> {
    const result = await this.run<{ ok?: boolean }>(['reinforce', String(factId)]);
    this.invalidateCache('stats', 'health');
    return result !== null;
  }

  async retire(factId: number): Promise<boolean> {
    const result = await this.run<{ ok?: boolean }>(['beliefs', 'set', 'retired', String(factId)]);
    this.invalidateCache('stats', 'health');
    return result !== null;
  }

  async supersede(oldFactId: number, newFactId: number): Promise<boolean> {
    const result = await this.run<{ ok?: boolean }>(['supersede', String(oldFactId), '--by', String(newFactId)]);
    this.invalidateCache('stats', 'health');
    return result !== null;
  }

  async query(where: string, limit = 10): Promise<CortexQueryResult[]> {
    const results = await this.run<CortexQueryResult[]>(['query', '--where', where, '--limit', String(limit)]);
    return results ?? [];
  }

  async answer(query: string): Promise<string | null> {
    const result = await this.run<{ answer: string }>(['answer', query, '--json']);
    return result?.answer ?? null;
  }

  async graph(options: { subject?: string; factId?: number; depth?: number }): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  } | null> {
    const args = ['graph'];
    if (options.subject) {
      args.push('--subject', options.subject);
    } else if (options.factId !== undefined) {
      args.push(String(options.factId));
    } else {
      return null;
    }
    args.push('--depth', String(options.depth ?? 2), '--export', 'json');
    return this.run(args);
  }

  async beliefs(): Promise<{ total: number; states: Record<string, number> } | null> {
    return this.run(['beliefs']);
  }

  async beliefsInspect(options?: { state?: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const args = ['beliefs', 'inspect', '--json'];
    if (options?.state) args.push('--state', options.state);
    if (options?.limit) args.push('--limit', String(options.limit));
    const result = await this.run<{ facts: Array<Record<string, unknown>> }>(args);
    return result?.facts ?? [];
  }
}

// ══════════════════════════════════════════════════════════════════
//  CloudCortexClient — HTTPS to hosted Cortex cloud API
//  Stub for #224 (Cloud Cortex Go HTTP Service)
// ══════════════════════════════════════════════════════════════════

class CloudCortexClient implements CortexClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  private async api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      if (!res.ok) {
        console.error(`[cortex-cloud] ${res.status} ${res.statusText} for ${path}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      console.error(`[cortex-cloud] Request failed: ${path}`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.baseUrl || !this.token) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/health`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async search(query: string, limit = 5): Promise<CortexSearchResult[]> {
    const results = await this.api<CortexSearchResult[]>('/api/v1/search', {
      method: 'POST',
      body: { query, limit },
    });
    return results ?? [];
  }

  async store(text: string, source?: string): Promise<{ ok: boolean; memoryId?: number }> {
    const result = await this.api<{ ok: boolean; memory_id?: number }>('/api/v1/store', {
      method: 'POST',
      body: { text, source },
    });
    return { ok: result?.ok ?? false, memoryId: result?.memory_id };
  }

  async stats(): Promise<CortexStats | null> {
    return this.api<CortexStats>('/api/v1/stats');
  }

  async stale(limit = 10): Promise<CortexStaleFact[]> {
    const results = await this.api<CortexStaleFact[]>(`/api/v1/stale?limit=${limit}`);
    return results ?? [];
  }

  async conflicts(limit = 10): Promise<CortexConflict[]> {
    const results = await this.api<CortexConflict[]>(`/api/v1/conflicts?limit=${limit}`);
    return results ?? [];
  }

  async reinforce(factId: number): Promise<boolean> {
    const result = await this.api<{ ok: boolean }>(`/api/v1/facts/${factId}/reinforce`, { method: 'POST' });
    return result?.ok ?? false;
  }

  async retire(factId: number): Promise<boolean> {
    const result = await this.api<{ ok: boolean }>(`/api/v1/facts/${factId}/retire`, { method: 'POST' });
    return result?.ok ?? false;
  }

  async supersede(oldFactId: number, newFactId: number): Promise<boolean> {
    const result = await this.api<{ ok: boolean }>(`/api/v1/facts/${oldFactId}/supersede`, {
      method: 'POST',
      body: { newFactId },
    });
    return result?.ok ?? false;
  }

  async query(where: string, limit = 10): Promise<CortexQueryResult[]> {
    const results = await this.api<CortexQueryResult[]>('/api/v1/query', {
      method: 'POST',
      body: { where, limit },
    });
    return results ?? [];
  }

  async answer(query: string): Promise<string | null> {
    const result = await this.api<{ answer: string }>('/api/v1/answer', {
      method: 'POST',
      body: { query },
    });
    return result?.answer ?? null;
  }

  async graph(options: { subject?: string; factId?: number; depth?: number }): Promise<{
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  } | null> {
    return this.api('/api/v1/graph', { method: 'POST', body: options });
  }

  async beliefs(): Promise<{ total: number; states: Record<string, number> } | null> {
    return this.api('/api/v1/beliefs');
  }

  async beliefsInspect(options?: { state?: string; limit?: number }): Promise<Array<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (options?.state) params.set('state', options.state);
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const result = await this.api<{ facts: Array<Record<string, unknown>> }>(`/api/v1/beliefs/inspect${qs}`);
    return result?.facts ?? [];
  }

  async sync(): Promise<{ uploaded: number; downloaded: number; conflicts: number }> {
    const result = await this.api<{ uploaded: number; downloaded: number; conflicts: number }>(
      '/api/v1/sync',
      { method: 'POST' },
    );
    return result ?? { uploaded: 0, downloaded: 0, conflicts: 0 };
  }
}

// ══════════════════════════════════════════════════════════════════
//  HybridCortexClient — reads local, writes both, syncs
//  Stub for #225 (Local ↔ Cloud Sync Protocol)
// ══════════════════════════════════════════════════════════════════

class HybridCortexClient implements CortexClient {
  private local: LocalCortexClient;
  private cloud: CloudCortexClient;

  constructor(cloudUrl: string, cloudToken: string) {
    this.local = new LocalCortexClient();
    this.cloud = new CloudCortexClient(cloudUrl, cloudToken);
  }

  async isAvailable(): Promise<boolean> {
    // Available if EITHER backend is reachable (offline-first)
    const [localOk, cloudOk] = await Promise.all([
      this.local.isAvailable(),
      this.cloud.isAvailable(),
    ]);
    return localOk || cloudOk;
  }

  // Reads: prefer local (faster), fall back to cloud
  async search(query: string, limit = 5): Promise<CortexSearchResult[]> {
    if (await this.local.isAvailable()) {
      return this.local.search(query, limit);
    }
    return this.cloud.search(query, limit);
  }

  // Writes: write to local first, then async to cloud
  async store(text: string, source?: string): Promise<{ ok: boolean; memoryId?: number }> {
    const localResult = await this.local.store(text, source);
    // Fire-and-forget cloud write (don't block on it)
    this.cloud.store(text, source).catch((err) => {
      console.error('[cortex-hybrid] Cloud store failed (will sync later):', err);
    });
    return localResult;
  }

  async stats(): Promise<CortexStats | null> {
    if (await this.local.isAvailable()) return this.local.stats();
    return this.cloud.stats();
  }

  async stale(limit = 10): Promise<CortexStaleFact[]> {
    if (await this.local.isAvailable()) return this.local.stale(limit);
    return this.cloud.stale(limit);
  }

  async conflicts(limit = 10): Promise<CortexConflict[]> {
    if (await this.local.isAvailable()) return this.local.conflicts(limit);
    return this.cloud.conflicts(limit);
  }

  async reinforce(factId: number): Promise<boolean> {
    const ok = await this.local.reinforce(factId);
    this.cloud.reinforce(factId).catch(() => {});
    return ok;
  }

  async retire(factId: number): Promise<boolean> {
    const ok = await this.local.retire(factId);
    this.cloud.retire(factId).catch(() => {});
    return ok;
  }

  async supersede(oldFactId: number, newFactId: number): Promise<boolean> {
    const ok = await this.local.supersede(oldFactId, newFactId);
    this.cloud.supersede(oldFactId, newFactId).catch(() => {});
    return ok;
  }

  async query(where: string, limit = 10): Promise<CortexQueryResult[]> {
    if (await this.local.isAvailable()) return this.local.query(where, limit);
    return this.cloud.query(where, limit);
  }

  async answer(query: string): Promise<string | null> {
    if (await this.local.isAvailable()) return this.local.answer(query);
    return this.cloud.answer(query);
  }

  async graph(options: { subject?: string; factId?: number; depth?: number }) {
    if (await this.local.isAvailable()) return this.local.graph(options);
    return this.cloud.graph(options);
  }

  async beliefs() {
    if (await this.local.isAvailable()) return this.local.beliefs();
    return this.cloud.beliefs();
  }

  async beliefsInspect(options?: { state?: string; limit?: number }) {
    if (await this.local.isAvailable()) return this.local.beliefsInspect(options);
    return this.cloud.beliefsInspect(options);
  }

  async sync(): Promise<{ uploaded: number; downloaded: number; conflicts: number }> {
    return this.cloud.sync();
  }
}

// ══════════════════════════════════════════════════════════════════
//  Client Factory — returns the right implementation
// ══════════════════════════════════════════════════════════════════

let clientInstance: CortexClient | null = null;

/**
 * Get the Cortex client for this environment.
 * Respects CORTEX_MODE env var: 'local' (default), 'cloud', or 'hybrid'.
 * Singleton — one client per process.
 */
export function getCortexClient(): CortexClient {
  if (clientInstance) return clientInstance;

  switch (CORTEX_MODE) {
    case 'cloud':
      if (!CORTEX_CLOUD_URL || !CORTEX_CLOUD_TOKEN) {
        console.warn('[cortex] CORTEX_MODE=cloud but missing CORTEX_CLOUD_URL or CORTEX_CLOUD_TOKEN. Falling back to local.');
        clientInstance = new LocalCortexClient();
      } else {
        clientInstance = new CloudCortexClient(CORTEX_CLOUD_URL, CORTEX_CLOUD_TOKEN);
      }
      break;
    case 'hybrid':
      if (!CORTEX_CLOUD_URL || !CORTEX_CLOUD_TOKEN) {
        console.warn('[cortex] CORTEX_MODE=hybrid but missing cloud config. Falling back to local.');
        clientInstance = new LocalCortexClient();
      } else {
        clientInstance = new HybridCortexClient(CORTEX_CLOUD_URL, CORTEX_CLOUD_TOKEN);
      }
      break;
    case 'local':
    default:
      clientInstance = new LocalCortexClient();
      break;
  }

  return clientInstance;
}

/**
 * Reset the client singleton (useful for testing or config changes).
 */
export function resetCortexClient(): void {
  clientInstance = null;
}

// ══════════════════════════════════════════════════════════════════
//  Backward-compatible exports — existing code uses these directly
//  These now delegate to getCortexClient() internally
// ══════════════════════════════════════════════════════════════════

/** @deprecated Use getCortexClient().isAvailable() */
export async function isCortexAvailable(): Promise<boolean> {
  return getCortexClient().isAvailable();
}

/** @deprecated Use getCortexClient().search() */
export async function cortexSearch(query: string, limit = 5): Promise<CortexSearchResult[]> {
  return getCortexClient().search(query, limit);
}

/** @deprecated Use getCortexClient().stats() */
export async function cortexStats(): Promise<CortexStats | null> {
  return getCortexClient().stats();
}

/** @deprecated Use getCortexClient().stale() */
export async function cortexStale(limit = 10): Promise<CortexStaleFact[]> {
  return getCortexClient().stale(limit);
}

/** @deprecated Use getCortexClient().conflicts() */
export async function cortexConflicts(limit = 10): Promise<CortexConflict[]> {
  return getCortexClient().conflicts(limit);
}

/** @deprecated Use getCortexClient().reinforce() */
export async function cortexReinforce(factId: number): Promise<boolean> {
  return getCortexClient().reinforce(factId);
}

/** @deprecated Use getCortexClient().retire() */
export async function cortexRetire(factId: number): Promise<boolean> {
  return getCortexClient().retire(factId);
}

/** @deprecated Use getCortexClient().supersede() */
export async function cortexSupersede(oldFactId: number, newFactId: number): Promise<boolean> {
  return getCortexClient().supersede(oldFactId, newFactId);
}

/** @deprecated Use getCortexClient().query() */
export async function cortexQuery(where: string, limit = 10): Promise<CortexQueryResult[]> {
  return getCortexClient().query(where, limit);
}

/** @deprecated Use getCortexClient().answer() */
export async function cortexAnswer(query: string): Promise<string | null> {
  return getCortexClient().answer(query);
}

// ══════════════════════════════════════════════════════════════════
//  Composed Operations — shared logic across all client types
// ══════════════════════════════════════════════════════════════════

/**
 * Build recall cards from search results.
 * Maps raw Cortex search output to UI-friendly cards.
 */
export async function getRecallCards(query: string, limit = 5): Promise<RecallCard[]> {
  const client = getCortexClient();
  const results = await client.search(query, Math.min(limit * 3, 30));

  const cards: RecallCard[] = [];
  const seenTexts: string[] = [];

  for (const r of results) {
    if (cards.length >= limit) break;

    const text = r.snippet || r.content.slice(0, 200);
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();

    if (seenTexts.some((seen) => trigramSimilarity(normalized, seen) > 0.6)) {
      continue;
    }

    seenTexts.push(normalized);
    const factIds = r.fact_ids ?? [];
    cards.push({
      id: factIds[0] ?? r.memory_id,
      memoryId: r.memory_id,
      factIds,
      text,
      factType: 'state' as RecallCard['factType'],
      confidence: r.score,
      source: shortenPath(r.source_file),
      sourceSection: r.source_section,
      age: formatAge(r.imported_at),
      score: r.score,
    });
  }

  return cards;
}

/**
 * Build full health summary for the dashboard.
 */
export async function getHealthSummary(): Promise<CortexHealthSummary> {
  const client = getCortexClient();

  if (!(await client.isAvailable())) {
    return {
      stats: emptyStats(),
      staleFacts: [],
      conflicts: [],
      available: false,
      error: 'Cortex not available. Install from https://github.com/hurttlocker/cortex',
    };
  }

  const [stats, staleFacts, conflicts] = await Promise.all([
    client.stats(),
    client.stale(10),
    client.conflicts(5),
  ]);

  return {
    stats: stats ?? emptyStats(),
    staleFacts,
    conflicts,
    available: stats !== null,
    error: stats === null ? 'Failed to read Cortex stats' : undefined,
  };
}

/**
 * Build context injection for agent pre-launch.
 */
export async function getContextInjection(
  prompt: string,
  cwd?: string,
  branch?: string,
): Promise<ContextInjection> {
  const queryParts = [prompt];
  if (cwd) queryParts.push(path.basename(cwd));
  if (branch) queryParts.push(branch);
  const query = queryParts.join(' ').slice(0, 200);

  const cards = await getRecallCards(query, 5);
  const relevant = cards.filter((c) => c.score > 0.4);

  if (relevant.length === 0) {
    return { facts: [], contextBlock: '', factCount: 0 };
  }

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

  return { facts: relevant, contextBlock, factCount: relevant.length };
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

function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 3 || b.length < 3) return 0;
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const setA = trigrams(a);
  const setB = trigrams(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / Math.max(setA.size, setB.size);
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
