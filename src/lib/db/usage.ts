/**
 * Usage Tracking Data Access Layer
 *
 * Records and queries token consumption for billing.
 * Supports per-model, per-agent, per-period breakdowns.
 */

import { eq, and, sql, desc } from 'drizzle-orm';
import { getDb, usageLogs } from './index';
import { randomUUID } from 'node:crypto';

// ── Types ──

export type Provider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'opencode' | 'runtime';
export type UsageRole = 'orchestrator' | 'worker' | 'reviewer' | 'compaction' | 'retrieval' | 'other';

export interface LogUsageInput {
  /** Null for operator-level local spend (house convention: such rows are
   *  attributed via agentName — matches the Codex/Gemini writers). */
  userId: string | null;
  model: string;
  provider: Provider;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  sessionKey?: string;
  repoPath?: string | null;
  laneId?: string | null;
  packetId?: string | null;
  missionId?: string | null;
  role?: UsageRole | null;
  attempt?: number;
  runId?: string | null;
  metadata?: Record<string, unknown> | null;
  agentName?: string;
  requestType?: 'chat' | 'completion' | 'embedding';
}

export interface UsageSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  byModel: Record<string, { costUsd: number; requests: number }>;
  byAgent: Record<string, { costUsd: number; requests: number }>;
  byDay: Array<{ date: string; costUsd: number; requests: number }>;
}

// ── Helpers ──

function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ── Operations ──

/**
 * Log a single API request's token usage.
 */
export function logUsage(input: LogUsageInput): void {
  getDb()!.insert(usageLogs).values({
    id: randomUUID(),
    userId: input.userId,
    model: input.model,
    provider: input.provider,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens ?? 0,
    cacheWriteTokens: input.cacheWriteTokens ?? 0,
    costUsd: input.costUsd,
    sessionKey: input.sessionKey ?? null,
    repoPath: input.repoPath ?? null,
    laneId: input.laneId ?? null,
    packetId: input.packetId ?? null,
    missionId: input.missionId ?? null,
    role: input.role ?? null,
    attempt: Math.max(1, Math.round(input.attempt ?? 1)),
    runId: input.runId ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    agentName: input.agentName ?? null,
    requestType: input.requestType ?? 'chat',
    billingPeriod: currentBillingPeriod(),
  }).run();
}

/**
 * Get total cost for a user in the current billing period.
 */
export function getCurrentPeriodCost(userId: string): number {
  const period = currentBillingPeriod();
  const result = getDb()!
    .select({ total: sql<number>`COALESCE(SUM(cost_usd), 0)` })
    .from(usageLogs)
    .where(and(
      eq(usageLogs.userId, userId),
      eq(usageLogs.billingPeriod, period),
    ))
    .get();
  return result?.total ?? 0;
}

/**
 * Get remaining budget for a user (null = unlimited/BYOK).
 */
export function getRemainingBudget(userId: string, budgetUsd: number | null): number | null {
  if (budgetUsd === null) return null; // BYOK, no budget
  const spent = getCurrentPeriodCost(userId);
  return Math.max(0, budgetUsd - spent);
}

/**
 * Get full usage summary for a user in a given period.
 */
export function getUsageSummary(userId: string, period?: string): UsageSummary {
  const db = getDb()!;
  const targetPeriod = period ?? currentBillingPeriod();

  const logs = db
    .select()
    .from(usageLogs)
    .where(and(
      eq(usageLogs.userId, userId),
      eq(usageLogs.billingPeriod, targetPeriod),
    ))
    .orderBy(desc(usageLogs.createdAt))
    .all();

  const byModel: Record<string, { costUsd: number; requests: number }> = {};
  const byAgent: Record<string, { costUsd: number; requests: number }> = {};
  const byDayMap: Record<string, { costUsd: number; requests: number }> = {};

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const log of logs) {
    totalCostUsd += log.costUsd;
    totalInputTokens += log.inputTokens;
    totalOutputTokens += log.outputTokens;

    // By model
    if (!byModel[log.model]) byModel[log.model] = { costUsd: 0, requests: 0 };
    byModel[log.model].costUsd += log.costUsd;
    byModel[log.model].requests += 1;

    // By agent
    const agent = log.agentName ?? 'unknown';
    if (!byAgent[agent]) byAgent[agent] = { costUsd: 0, requests: 0 };
    byAgent[agent].costUsd += log.costUsd;
    byAgent[agent].requests += 1;

    // By day
    const day = log.createdAt.split('T')[0] ?? log.createdAt.split(' ')[0];
    if (!byDayMap[day]) byDayMap[day] = { costUsd: 0, requests: 0 };
    byDayMap[day].costUsd += log.costUsd;
    byDayMap[day].requests += 1;
  }

  const byDay = Object.entries(byDayMap)
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    requestCount: logs.length,
    byModel,
    byAgent,
    byDay,
  };
}

/**
 * Get recent usage logs (for the usage dashboard feed).
 */
export function getRecentUsage(userId: string, limit = 50) {
  const _d = getDb(); if (!_d) return []; return _d
    .select()
    .from(usageLogs)
    .where(eq(usageLogs.userId, userId))
    .orderBy(desc(usageLogs.createdAt))
    .limit(limit)
    .all();
}
