import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, usageLogs } from '@/lib/db';
import { getRuntime } from '@/lib/runtimes';

const LOG_PREFIX = '[cost-persistence]';

type UsageProvider = 'anthropic' | 'openai' | 'google';

export interface PersistSessionCostInput {
  sessionKey: string;
  runtime: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number;
  repoPath: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function billingPeriodFor(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeTokenCount(value: unknown) {
  return Math.max(0, Math.round(finiteNumber(value)));
}

function normalizeUsd(value: number) {
  return Number(finiteNumber(value).toFixed(6));
}

function providerForRuntime(runtime: string): UsageProvider | null {
  if (runtime === 'claude-code') {
    return 'anthropic';
  }
  if (runtime === 'codex') {
    return 'openai';
  }
  return null;
}

function agentNameForRuntime(runtime: string) {
  if (runtime === 'claude-code') {
    return 'Claude Code';
  }
  if (runtime === 'codex') {
    return 'Codex CLI';
  }
  return runtime;
}

export async function persistSessionCost(input: PersistSessionCostInput): Promise<boolean> {
  const db = getDb();
  if (!db) {
    console.warn(`${LOG_PREFIX} Database unavailable, skipping ${input.sessionKey}.`);
    return false;
  }

  const sessionKey = input.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }

  const provider = providerForRuntime(input.runtime);
  if (!provider) {
    console.warn(`${LOG_PREFIX} Unsupported runtime "${input.runtime}" for ${sessionKey}.`);
    return false;
  }

  const existing = db
    .select({ id: usageLogs.id })
    .from(usageLogs)
    .where(eq(usageLogs.sessionKey, sessionKey))
    .get();

  if (existing) {
    return false;
  }

  db.insert(usageLogs).values({
    id: randomUUID(),
    userId: null,
    model: input.model?.trim() || input.runtime,
    provider,
    inputTokens: normalizeTokenCount(input.inputTokens),
    outputTokens: normalizeTokenCount(input.outputTokens),
    cacheReadTokens: normalizeTokenCount(input.cacheReadTokens),
    cacheWriteTokens: normalizeTokenCount(input.cacheWriteTokens),
    costUsd: normalizeUsd(input.costUsd),
    sessionKey,
    repoPath: resolve(input.repoPath),
    agentName: agentNameForRuntime(input.runtime),
    requestType: 'completion',
    billingPeriod: billingPeriodFor(),
  }).run();

  console.log(`${LOG_PREFIX} Persisted ${sessionKey}.`);
  return true;
}

export async function persistRuntimeSessionCost(input: {
  sessionKey: string;
  runtime: string;
  repoPath: string;
}): Promise<boolean> {
  try {
    const adapter = getRuntime(input.runtime);
    if (!adapter?.capabilities.costTelemetry || !adapter.getTelemetry) {
      console.warn(`${LOG_PREFIX} Runtime ${input.runtime} has no telemetry for ${input.sessionKey}.`);
      return false;
    }

    const telemetry = await adapter.getTelemetry(input.sessionKey);
    if (!telemetry) {
      console.warn(`${LOG_PREFIX} No telemetry found for ${input.sessionKey}.`);
      return false;
    }

    return persistSessionCost({
      sessionKey: input.sessionKey,
      runtime: input.runtime,
      model: telemetry.model,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      costUsd: finiteNumber(telemetry.estimatedCostUsd),
      repoPath: input.repoPath,
      cacheReadTokens: telemetry.cacheReadTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to persist runtime session cost for ${input.sessionKey}.`, error);
    return false;
  }
}
