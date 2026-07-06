/**
 * Collide (MoA) config resolution.
 *
 * The default brain is {claude, codex} → claude: Claude + Codex propose
 * independently, Claude aggregates + executes. Resolution layers (highest wins):
 *   operator settings (collideProposers / collideAggregator) → env → code default.
 *
 * The operator-settings layer is wired in Step 4/5; today this resolves from env
 * + the code default so the engine is usable the moment it's registered.
 */

import type { OrchestratorBackendId } from './types';
import type { MoaConfig, MoaParticipant } from './moa';
import { resolveCollideAggregatorSync, type CollideAggregator } from '@/lib/operator/defaults';
import { MODEL_IDS } from '@/lib/models';

/** Default brain — Claude (opus, max) + Codex (gpt-5.5, xhigh) → Claude (opus, max). */
export const DEFAULT_COLLIDE_CONFIG: MoaConfig = {
  id: 'collide',
  label: 'Collide',
  proposers: [
    { backend: 'claude', model: MODEL_IDS.orchestratorDefault, thinkingEffort: 'max' },
    { backend: 'codex', model: MODEL_IDS.codexDefault, thinkingEffort: 'xhigh' },
  ],
  aggregator: { backend: 'claude', model: MODEL_IDS.orchestratorDefault, thinkingEffort: 'max' },
};

const VALID_BACKENDS: OrchestratorBackendId[] = ['claude', 'codex'];

function coerceParticipant(raw: unknown): MoaParticipant | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const backend = obj.backend;
  if (typeof backend !== 'string' || !VALID_BACKENDS.includes(backend as OrchestratorBackendId)) return null;
  const participant: MoaParticipant = { backend: backend as OrchestratorBackendId };
  if (typeof obj.model === 'string' && obj.model.trim()) participant.model = obj.model.trim();
  if (typeof obj.thinkingEffort === 'string') participant.thinkingEffort = obj.thinkingEffort as MoaParticipant['thinkingEffort'];
  return participant;
}

function parseProposersEnv(raw: string | undefined): MoaParticipant[] | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const proposers = parsed.map(coerceParticipant).filter((p): p is MoaParticipant => p !== null);
    return proposers.length > 0 ? proposers : null;
  } catch {
    return null;
  }
}

function parseAggregatorEnv(raw: string | undefined): MoaParticipant | null {
  if (!raw || !raw.trim()) return null;
  try {
    return coerceParticipant(JSON.parse(raw));
  } catch {
    return null;
  }
}

function aggregatorFor(defaultSetting: CollideAggregator, activeBackend?: OrchestratorBackendId): MoaParticipant {
  const backend = defaultSetting === 'auto'
    ? activeBackend === 'codex' ? 'codex' : 'claude'
    : defaultSetting;
  const fallback = DEFAULT_COLLIDE_CONFIG.proposers.find((p) => p.backend === backend);
  return fallback ?? { backend };
}

/**
 * Resolve the active Collide config. Pure-ish: reads env each call so an
 * override applies on the next turn. Always returns a valid config (falls back
 * to the code default piece-by-piece).
 */
export function resolveCollideConfig(activeBackend?: OrchestratorBackendId): MoaConfig {
  const proposers = parseProposersEnv(process.env.O8_COLLIDE_PROPOSERS) ?? DEFAULT_COLLIDE_CONFIG.proposers;
  const aggregator = parseAggregatorEnv(process.env.O8_COLLIDE_AGGREGATOR)
    ?? aggregatorFor(resolveCollideAggregatorSync(), activeBackend);
  return { id: 'collide', label: 'Collide', proposers, aggregator };
}
