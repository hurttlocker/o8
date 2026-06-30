/**
 * Orchestrator backend registry.
 *
 * Resolves the active orchestrator backend. Each backend is an
 * `OrchestratorBackend` implementation living in its own sibling file
 * (`claude.ts`, `codex.ts`, `openclaw.ts`, `acp.ts`) — registered here in
 * `BACKENDS`. The Codex/Claude delegates call straight into the existing,
 * UNMODIFIED `orchestrator-session.ts` / `codex-orchestrator-session.ts`
 * modules. Adding a backend is one new file + one entry in `BACKENDS`.
 *
 * Orchestrator call sites use `getActiveOrchestratorBackend()` instead of
 * branching on `inAppOrchestratorEnabled` directly — the registry is the
 * single chokepoint that knows which backend is active.
 */

import { resolveInAppOrchestratorEnabledSync, resolveOrchestratorBackendSync } from '@/lib/operator/defaults';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { openclawBackend } from './openclaw';
import { acpBackend, hermesBackend } from './acp';
import { collideBackend } from './moa';
import type { OrchestratorBackend, OrchestratorBackendId } from './types';

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Registered backends. `openclaw` is added when its backend module ships;
 * `getOrchestratorBackend` falls back to Codex for an unregistered id.
 */
const BACKENDS: Partial<Record<OrchestratorBackendId, OrchestratorBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
  hermes: hermesBackend,
  acp: acpBackend,
  collide: collideBackend,
};

/** The default backend — also the fallback for any unregistered id. */
const DEFAULT_BACKEND = codexBackend;

export function getOrchestratorBackend(id: OrchestratorBackendId): OrchestratorBackend {
  return BACKENDS[id] ?? DEFAULT_BACKEND;
}

/**
 * Resolve the active orchestrator backend id.
 *
 * The `orchestratorBackend` operator setting picks the backend:
 *   - **'auto' (default)** → defer to the legacy `inAppOrchestratorEnabled`
 *     boolean, BYTE-IDENTICAL to the pre-setting behavior:
 *       · toggle OFF (default) → Codex GPT-5.5 xhigh
 *       · toggle ON            → Claude
 *   - a specific id ('codex' | 'claude' | 'openclaw') → forces that backend,
 *     which is how OpenClaw becomes selectable from the desktop.
 * A per-request `msg.backend` still overrides this (see ws-server's
 * `resolveMsgBackendId`).
 */
export function resolveOrchestratorBackendId(): OrchestratorBackendId {
  const setting = resolveOrchestratorBackendSync();
  if (setting !== 'auto') return setting;
  return resolveInAppOrchestratorEnabledSync() ? 'claude' : 'codex';
}

/** The active backend, resolved from operator settings. */
export function getActiveOrchestratorBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveOrchestratorBackendId());
}
