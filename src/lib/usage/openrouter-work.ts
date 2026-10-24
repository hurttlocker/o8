/**
 * "Work run by o8" on OpenRouter (#3481).
 *
 * Reads the usage rows o8's own callers wrote for OpenRouter requests. This is
 * a different scope from the key figures OpenRouter reports for the connected
 * key, which include use outside o8, so the two are never added together.
 *
 * Each row's cost keeps its basis. Provider-reported cost, o8's estimates, rows
 * written without a basis, and calls whose cost is unknown are summed
 * separately. An unknown cost is never counted as zero spend: those calls are
 * counted, with the worst case o8 reserved for them before the call.
 */

import 'server-only';

import { and, eq, gte } from 'drizzle-orm';
import { getDb, usageLogs } from '@/lib/db';

export type OpenRouterCostBasis = 'reported' | 'estimated' | 'unlabeled' | 'unknown';

const COST_BASIS_PRIORITY: Record<OpenRouterCostBasis, number> = {
  unknown: 0, unlabeled: 1, estimated: 2, reported: 3,
};

export interface OpenRouterWorkTotals {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Cost OpenRouter reported for the call. */
  reportedUsd: number;
  /** Cost o8 priced from tokens because OpenRouter reported none. */
  estimatedUsd: number;
  /** Cost written by an older caller that did not record its basis. */
  unlabeledUsd: number;
  /** Calls whose cost is not known. Their cost is not in any sum above. */
  unknownCostCalls: number;
  /** The worst case o8 admitted for the unknown-cost calls, where it recorded one. */
  unknownReservedUsd: number;
}

export interface OpenRouterWorkGroup extends OpenRouterWorkTotals {
  key: string;
}

export interface OpenRouterWorkSummary {
  since: string;
  firstCallAt: string | null;
  lastCallAt: string | null;
  totals: OpenRouterWorkTotals;
  /** Grouped by the seat or feature that made the call. */
  bySource: OpenRouterWorkGroup[];
  byModel: OpenRouterWorkGroup[];
  /** Rows dropped because another row already carried the same OpenRouter generation id. */
  duplicateRows: number;
}

type UsageRow = typeof usageLogs.$inferSelect;

function metadataOf(row: UsageRow): Record<string, unknown> {
  if (!row.metadataJson) return {};
  try {
    const parsed = JSON.parse(row.metadataJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function openRouterCostBasis(metadata: Record<string, unknown>): OpenRouterCostBasis {
  const source = metadata.costSource;
  if (source === 'provider_response' || source === 'gateway') return 'reported';
  if (source === 'estimate') return 'estimated';
  if (source === 'unknown') return 'unknown';
  // The chat-title writer labels its cost this way.
  if (metadata.costUsage === 'provider-reported') return 'reported';
  if (metadata.costUsage === 'unavailable') return 'unknown';
  return 'unlabeled';
}

function sourceOf(row: UsageRow, metadata: Record<string, unknown>): string {
  if (metadata.runtime === 'pi') {
    return row.role === 'orchestrator' ? 'Pi lead' : row.role === 'worker' ? 'Pi worker' : `Pi ${row.role ?? 'other'}`;
  }
  return row.agentName?.trim() || row.role || 'other';
}

function emptyTotals(): OpenRouterWorkTotals {
  return {
    calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0,
    reportedUsd: 0, estimatedUsd: 0, unlabeledUsd: 0, unknownCostCalls: 0, unknownReservedUsd: 0,
  };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function add(totals: OpenRouterWorkTotals, row: UsageRow, metadata: Record<string, unknown>): void {
  const basis = openRouterCostBasis(metadata);
  totals.calls += 1;
  if (metadata.status === 'failed' || metadata.status === 'stopped' || (typeof metadata.outcome === 'string' && metadata.outcome !== 'success')) {
    totals.failedCalls += 1;
  }
  totals.inputTokens += Math.max(0, row.inputTokens ?? 0);
  totals.outputTokens += Math.max(0, row.outputTokens ?? 0);
  const cost = finite(row.costUsd);
  if (basis === 'reported') totals.reportedUsd += cost;
  else if (basis === 'estimated') totals.estimatedUsd += cost;
  else if (basis === 'unlabeled') totals.unlabeledUsd += cost;
  else {
    totals.unknownCostCalls += 1;
    totals.unknownReservedUsd += finite(metadata.reservedUsd);
  }
}

function rounded<T extends OpenRouterWorkTotals>(totals: T): T {
  const usd = (value: number) => Math.round(value * 1e8) / 1e8;
  return {
    ...totals,
    reportedUsd: usd(totals.reportedUsd),
    estimatedUsd: usd(totals.estimatedUsd),
    unlabeledUsd: usd(totals.unlabeledUsd),
    unknownReservedUsd: usd(totals.unknownReservedUsd),
  };
}

function groups(map: Map<string, OpenRouterWorkTotals>): OpenRouterWorkGroup[] {
  return [...map.entries()]
    .map(([key, totals]) => rounded({ key, ...totals }))
    .sort((a, b) => b.reportedUsd - a.reportedUsd || b.calls - a.calls || a.key.localeCompare(b.key));
}

/** SQLite's CURRENT_TIMESTAMP form, which `usage_logs.created_at` uses. */
function sqliteTimestamp(at: Date): string {
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

function isoTimestamp(value: string): string {
  return value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
}

export function summarizeOpenRouterWork(options: { since: Date }): OpenRouterWorkSummary {
  const since = sqliteTimestamp(options.since);
  const summary: OpenRouterWorkSummary = {
    since: options.since.toISOString(), firstCallAt: null, lastCallAt: null,
    totals: emptyTotals(), bySource: [], byModel: [], duplicateRows: 0,
  };
  const db = getDb();
  if (!db) return summary;
  const rows = db.select().from(usageLogs)
    .where(and(eq(usageLogs.provider, 'openrouter'), gte(usageLogs.createdAt, since)))
    .orderBy(usageLogs.createdAt)
    .all();
  const selected = new Map<string, { row: UsageRow; metadata: Record<string, unknown> }>();
  for (const row of rows) {
    const metadata = metadataOf(row);
    const generationId = typeof metadata.generationId === 'string' && metadata.generationId ? metadata.generationId : null;
    const key = generationId ? `generation:${generationId}` : `row:${row.id}`;
    const previous = selected.get(key);
    if (previous) {
      summary.duplicateRows += 1;
      // Later provider evidence replaces an estimate or unknown cost, while
      // a weaker duplicate cannot downgrade an already reported generation.
      if (COST_BASIS_PRIORITY[openRouterCostBasis(metadata)]
        <= COST_BASIS_PRIORITY[openRouterCostBasis(previous.metadata)]) continue;
    }
    selected.set(key, { row, metadata });
  }
  const bySource = new Map<string, OpenRouterWorkTotals>();
  const byModel = new Map<string, OpenRouterWorkTotals>();
  const chronological = [...selected.values()].sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt));
  for (const { row, metadata } of chronological) {
    add(summary.totals, row, metadata);
    const source = sourceOf(row, metadata);
    if (!bySource.has(source)) bySource.set(source, emptyTotals());
    add(bySource.get(source)!, row, metadata);
    const model = row.model || 'unknown';
    if (!byModel.has(model)) byModel.set(model, emptyTotals());
    add(byModel.get(model)!, row, metadata);
    summary.firstCallAt ??= isoTimestamp(row.createdAt);
    summary.lastCallAt = isoTimestamp(row.createdAt);
  }
  summary.totals = rounded(summary.totals);
  summary.bySource = groups(bySource);
  summary.byModel = groups(byModel);
  return summary;
}
