/**
 * Pi model choice (#3584): the managed model stays the default; an explicit
 * `openrouter/<model-id>` choice runs Pi on the user's OpenRouter connection.
 * The choice is checked against the OpenRouter catalogue (text output, tool
 * support and a listed price) before any call, so an unusable model fails
 * visibly instead of falling back. Every call writes one usage row with the
 * runtime, carrier, exact model, OpenRouter's generation id and its reported
 * cost; a call with no reported cost is recorded as unknown, not as free.
 */

import 'server-only';

import type { Model } from '@earendil-works/pi-ai/compat';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { logUsage, type UsageRole } from '@/lib/db/usage';
import { getOpenRouterModelMetadata } from '@/lib/orchestrator/openrouter-model-metadata';
import { O8_MANAGED_PI_MODEL } from '@/lib/pi/sdk/live-contract';
import {
  createOpenRouterPiTransport,
  isOpenRouterPiModelChoice,
  OPENROUTER_PI_MODEL_PREFIX,
  OpenRouterSpendCeiling,
  openRouterPiModel,
  type OpenRouterPiPricing,
  type OpenRouterPiReceipt,
} from '@/lib/pi/sdk/openrouter-transport';
import type { PiModelTransport } from '@/lib/pi/sdk/transport';

export class PiModelChoiceError extends Error {
  override name = 'PiModelChoiceError';
}

export interface PiUsageAttribution {
  role: UsageRole;
  agentName: string;
  sessionKey?: string;
  repoPath?: string | null;
  laneId?: string | null;
  packetId?: string | null;
  missionId?: string | null;
  runId?: string | null;
}

export type PiModelRoute =
  | { carrier: 'managed'; model: Model<'openai-completions'>; label: string }
  | { carrier: 'openrouter'; model: Model<'openai-completions'>; label: string; choice: string; pricing: OpenRouterPiPricing };

/** The model id a receipt or session record names for this route. */
export function piRouteModelId(route: PiModelRoute): string {
  return route.carrier === 'openrouter' ? route.choice : route.model.id;
}

export async function resolvePiModelRoute(requested?: string | null): Promise<PiModelRoute> {
  if (!isOpenRouterPiModelChoice(requested)) return { carrier: 'managed', model: O8_MANAGED_PI_MODEL, label: O8_MANAGED_PI_MODEL.name };
  const modelId = requested.slice(OPENROUTER_PI_MODEL_PREFIX.length);
  if (!(await resolveOpenRouterKey())) {
    throw new PiModelChoiceError('Connect OpenRouter in Settings > Providers, or turn the connection on, to run Pi on an OpenRouter model.');
  }
  const catalogue = await getOpenRouterModelMetadata('most-popular');
  if (!catalogue) throw new PiModelChoiceError('The OpenRouter model list is unavailable. Try again in a moment.');
  const entry = catalogue.get(requested);
  if (!entry || entry.compatible === false) {
    throw new PiModelChoiceError(`${modelId} cannot run Pi on OpenRouter: Pi needs a text model with tool support.`);
  }
  if (entry.inputPricePerMillion === undefined || entry.outputPricePerMillion === undefined) {
    throw new PiModelChoiceError(`${modelId} has no listed OpenRouter price, so o8 cannot bound its cost.`);
  }
  const pricing = { inputPerMillion: entry.inputPricePerMillion, outputPerMillion: entry.outputPricePerMillion };
  return {
    carrier: 'openrouter',
    choice: requested,
    pricing,
    model: openRouterPiModel(modelId, pricing, entry.contextLength),
    label: `${entry.label ?? modelId} (OpenRouter)`,
  };
}

export function recordPiOpenRouterReceipt(receipt: OpenRouterPiReceipt, attribution: PiUsageAttribution): void {
  // A refused call never reached OpenRouter, so it has no usage to record.
  if (receipt.status === 'refused') return;
  try {
    logUsage({
      userId: null,
      model: `${OPENROUTER_PI_MODEL_PREFIX}${receipt.model}`,
      provider: 'openrouter',
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      cacheReadTokens: receipt.cacheReadTokens,
      costUsd: receipt.costUsd ?? 0,
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
        carrier: 'openrouter',
        costSource: receipt.costUsd === null ? 'unknown' : 'provider_response',
        generationId: receipt.generationId,
        status: receipt.status,
        reservedUsd: receipt.reservedUsd,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
      },
    });
  } catch (error) {
    console.warn('[pi-openrouter] usage receipt failed:', error instanceof Error ? error.message : error);
  }
}

/** The transport for an OpenRouter route, bounded by one spend ceiling and recording every call. */
export function createPiOpenRouterRouteTransport(
  route: Extract<PiModelRoute, { carrier: 'openrouter' }>,
  options: { ceilingUsd: number; attribution: PiUsageAttribution; onReceipt?: (receipt: OpenRouterPiReceipt) => void; fetch?: typeof fetch },
): { transport: PiModelTransport; ceiling: OpenRouterSpendCeiling } {
  const ceiling = new OpenRouterSpendCeiling(options.ceilingUsd);
  const transport = createOpenRouterPiTransport({
    model: route.model,
    pricing: route.pricing,
    ceiling,
    resolveKey: resolveOpenRouterKey,
    fetch: options.fetch,
    onReceipt: (receipt) => {
      recordPiOpenRouterReceipt(receipt, options.attribution);
      options.onReceipt?.(receipt);
    },
  });
  return { transport, ceiling };
}
