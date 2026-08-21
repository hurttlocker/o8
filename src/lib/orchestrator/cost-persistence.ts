import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb, usageLogs } from '@/lib/db';
import { getRuntime } from '@/lib/runtimes';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';

const LOG_PREFIX = '[cost-persistence]';

type UsageProvider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'opencode' | 'runtime';

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
  costSource?: 'gateway' | 'estimate' | 'unknown';
}

export interface PersistedSessionCost {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  model: string | null;
  costSource: 'gateway' | 'estimate';
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

export function readPersistedSessionCost(sessionKey: string): PersistedSessionCost | null {
  const normalized = sessionKey.trim();
  const db = getDb();
  if (!normalized || !db) return null;

  const row = db
    .select({
      inputTokens: usageLogs.inputTokens,
      outputTokens: usageLogs.outputTokens,
      costUsd: usageLogs.costUsd,
      model: usageLogs.model,
      provider: usageLogs.provider,
    })
    .from(usageLogs)
    .where(eq(usageLogs.sessionKey, normalized))
    .get();

  if (!row) return null;
  return {
    inputTokens: normalizeTokenCount(row.inputTokens),
    outputTokens: normalizeTokenCount(row.outputTokens),
    totalCostUsd: normalizeUsd(row.costUsd),
    model: row.model?.trim() || null,
    costSource: row.provider === 'openrouter' ? 'gateway' : 'estimate',
  };
}

// Problem C — exhaustive dispatch switch: maps runtime → billing provider.
// Each runtime routes to a different payment provider (anthropic/openai/google).
// Add a new runtime case here when adding a new adapter. Never collapse to a label lookup.
function providerForRuntime(runtime: string, costSource?: PersistSessionCostInput['costSource']): UsageProvider {
  if (costSource === 'gateway') return 'openrouter';
  if (runtime === 'claude-code') {
    return 'anthropic';
  }
  if (runtime === 'codex') {
    return 'openai';
  }
  if (runtime === 'gemini') {
    return 'google';
  }
  if (runtime === 'opencode') {
    return 'opencode';
  }
  return 'runtime';
}

function agentNameForRuntime(runtime: string) {
  // Capability-map lookup for display label; optional chaining guards against unknown runtimes.
  const label = ORCHESTRATOR_RUNTIMES[runtime as keyof typeof ORCHESTRATOR_RUNTIMES]?.label;
  return label ?? runtime;
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

  const provider = providerForRuntime(input.runtime, input.costSource);
  const existing = db
    .select({
      id: usageLogs.id,
      inputTokens: usageLogs.inputTokens,
      outputTokens: usageLogs.outputTokens,
      cacheReadTokens: usageLogs.cacheReadTokens,
      cacheWriteTokens: usageLogs.cacheWriteTokens,
      costUsd: usageLogs.costUsd,
      provider: usageLogs.provider,
    })
    .from(usageLogs)
    .where(eq(usageLogs.sessionKey, sessionKey))
    .get();

  if (existing) {
    db.update(usageLogs).set({
      model: input.model?.trim() || input.runtime,
      provider: existing.provider === 'openrouter' && input.costSource !== 'gateway' ? 'openrouter' : provider,
      inputTokens: Math.max(normalizeTokenCount(existing.inputTokens), normalizeTokenCount(input.inputTokens)),
      outputTokens: Math.max(normalizeTokenCount(existing.outputTokens), normalizeTokenCount(input.outputTokens)),
      cacheReadTokens: Math.max(normalizeTokenCount(existing.cacheReadTokens), normalizeTokenCount(input.cacheReadTokens)),
      cacheWriteTokens: Math.max(normalizeTokenCount(existing.cacheWriteTokens), normalizeTokenCount(input.cacheWriteTokens)),
      costUsd: input.costSource === 'gateway'
        ? normalizeUsd(input.costUsd)
        : existing.provider === 'openrouter'
          ? normalizeUsd(existing.costUsd)
          : Math.max(normalizeUsd(existing.costUsd), normalizeUsd(input.costUsd)),
      repoPath: resolve(input.repoPath),
      agentName: agentNameForRuntime(input.runtime),
      billingPeriod: billingPeriodFor(),
    }).where(eq(usageLogs.id, existing.id)).run();
    return true;
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

    const persisted = await persistSessionCost({
      sessionKey: input.sessionKey,
      runtime: input.runtime,
      model: telemetry.model,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      costUsd: finiteNumber(telemetry.estimatedCostUsd),
      repoPath: input.repoPath,
      cacheReadTokens: telemetry.cacheReadTokens,
      cacheWriteTokens: telemetry.cacheWriteTokens,
      costSource: telemetry.costSource,
    });
    if (persisted) {
      const { getLaneEvents, listLanes } = await import('@/lib/lane/registry');
      const lane = listLanes().find((candidate) => candidate.sessionKey === input.sessionKey && candidate.packetId);
      if (lane?.packetId) {
        const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
        await patchMissionPacket(lane.packetId, {
          spendTelemetry: {
            costUsd: finiteNumber(telemetry.estimatedCostUsd),
            inputTokens: normalizeTokenCount(telemetry.inputTokens),
            outputTokens: normalizeTokenCount(telemetry.outputTokens),
            costSource: telemetry.costSource ?? 'estimate',
            capHit: getLaneEvents(lane.id, 200).some((event) => event.verb === 'spend_cap_hit'),
            updatedAt: new Date().toISOString(),
          },
        });
      }
    }
    return persisted;
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to persist runtime session cost for ${input.sessionKey}.`, error);
    return false;
  }
}
