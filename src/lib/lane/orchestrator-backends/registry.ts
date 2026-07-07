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

import { resolveOrchestratorBackendId, resolveReviewerBackendId } from './active-backend';
import { claudeBackend } from './claude';
import { codexBackend } from './codex';
import { openclawBackend } from './openclaw';
import { acpBackend, hermesBackend } from './acp';
import { collideBackend } from './moa';
import { fableBackend } from './fable';
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
  fable: fableBackend,
};

/** The default backend — also the fallback for any unregistered id. */
const DEFAULT_BACKEND = codexBackend;

export function getOrchestratorBackend(id: OrchestratorBackendId): OrchestratorBackend {
  return BACKENDS[id] ?? DEFAULT_BACKEND;
}

// Active-id resolution lives in the server leaf `active-backend.ts`; billing
// classes in the PURE leaf `billing.ts` (client-bundle-safe) — so brain-access/
// packet-prompt and the client compaction trigger resolve what they need
// without pulling every backend implementation through this module.
// Re-exported for existing call-sites (ws-server). IMPORT-PATH TRAP: client
// code must import these from './billing' / './active-backend' DIRECTLY —
// importing via this registry pulls every backend implementation (and their
// session modules) into the bundle.
export { resolveOrchestratorBackendId, resolveReviewerBackendId } from './active-backend';
export { isMeteredOrchestratorBackend } from './billing';

/** The active backend, resolved from operator settings. */
export function getActiveOrchestratorBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveOrchestratorBackendId());
}

/** The backend that runs lane auto-reviews ('follow' rides the orchestrator). */
export function getActiveReviewerBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveReviewerBackendId());
}
