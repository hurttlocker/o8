/**
 * Usage rows for Pi on o8's managed model (#3742). The relay meters the
 * allowance; these rows record each call's tokens locally, at no per-call
 * charge to the operator, so every role's managed calls appear with the rest.
 */

import type { Model } from '@earendil-works/pi-ai/compat';
import { logUsage } from '@/lib/db/usage';
import type { PiUsageAttribution } from './openrouter-choice';
import { createManagedPiTransport, type ManagedPiTransportOptions, type PiModelTransport } from './sdk/transport';

interface RawUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown } | null;
}

function tokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function recordPiManagedUsage(model: Model<'openai-completions'>, attribution: PiUsageAttribution,
  usage: RawUsage | null, status: 'completed' | 'failed'): void {
  try {
    logUsage({
      userId: null,
      model: model.id,
      provider: 'runtime',
      inputTokens: tokens(usage?.prompt_tokens),
      outputTokens: tokens(usage?.completion_tokens),
      cacheReadTokens: tokens(usage?.prompt_tokens_details?.cached_tokens),
      costUsd: 0,
      sessionKey: attribution.sessionKey,
      repoPath: attribution.repoPath ?? null,
      laneId: attribution.laneId ?? null,
      packetId: attribution.packetId ?? null,
      missionId: attribution.missionId ?? null,
      role: attribution.role,
      runId: attribution.runId ?? null,
      agentName: attribution.agentName,
      requestType: 'chat',
      metadata: {
        runtime: 'pi',
        carrier: 'o8-managed',
        payer: 'o8-managed',
        costSource: 'allowance',
        ...(attribution.surface ? { surface: attribution.surface } : {}),
        // The relay reports no usage for a call it refused or that failed early.
        usageReported: usage !== null,
        status,
      },
    });
  } catch (error) {
    console.warn('[pi-managed] usage row failed:', error instanceof Error ? error.message : error);
  }
}

/** The managed transport, recording one usage row per model call. */
export function createPiManagedUsageTransport(model: Model<'openai-completions'>, attribution: PiUsageAttribution,
  options: Omit<ManagedPiTransportOptions, 'model' | 'observeRawUsage'> = {}): PiModelTransport {
  return async function* (context, signal) {
    let usage: RawUsage | null = null;
    let failed = false;
    const transport = createManagedPiTransport({ ...options, model, observeRawUsage: (raw) => {
      if (raw && typeof raw === 'object') usage = raw as RawUsage;
    } });
    try {
      for await (const event of transport(context, signal)) {
        if (event.type === 'error') failed = true;
        yield event;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      recordPiManagedUsage(model, attribution, usage, failed ? 'failed' : 'completed');
    }
  };
}
