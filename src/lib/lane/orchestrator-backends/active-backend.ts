/**
 * Active-orchestrator-backend resolution — SERVER-side leaf (reads operator
 * defaults from disk). Split from `billing.ts` (2026-07-02) so the pure billing
 * map stays client-bundle-safe; split from `registry.ts` so leaf consumers
 * (brain-access → packet-prompt) can resolve the active backend without pulling
 * every backend implementation. Both re-export from here / billing.
 */

import { resolveInAppOrchestratorEnabledSync, resolveOrchestratorBackendSync } from '@/lib/operator/defaults';
import type { OrchestratorBackendId } from './types';

/**
 * Resolve the active orchestrator backend id.
 *
 * The `orchestratorBackend` operator setting picks the backend:
 *   - **'auto' (default)** → defer to the legacy `inAppOrchestratorEnabled`
 *     boolean, BYTE-IDENTICAL to the pre-setting behavior:
 *       · toggle OFF (default) → Codex GPT-5.5 xhigh
 *       · toggle ON            → Claude
 *   - a specific id ('codex' | 'claude' | 'openclaw' | …) → forces that backend.
 * A per-request `msg.backend` still overrides this (see ws-server's
 * `resolveMsgBackendId`).
 */
export function resolveOrchestratorBackendId(): OrchestratorBackendId {
  const setting = resolveOrchestratorBackendSync();
  if (setting !== 'auto') return setting;
  return resolveInAppOrchestratorEnabledSync() ? 'claude' : 'codex';
}
