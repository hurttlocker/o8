/**
 * Orchestrator backend registry.
 *
 * Resolves the active orchestrator backend and exposes Codex + Claude as
 * `OrchestratorBackend` implementations. Both are thin delegates — they call
 * straight into the existing, UNMODIFIED `orchestrator-session.ts` (Claude)
 * and `codex-orchestrator-session.ts` (Codex) modules. Adding a backend
 * (openclaw, Hermes) is one new file + one entry in `BACKENDS`.
 *
 * Orchestrator call sites use `getActiveOrchestratorBackend()` instead of
 * branching on `inAppOrchestratorEnabled` directly — the registry is the
 * single chokepoint that knows which backend is active.
 */

import {
  ensureCodexOrchestratorSession,
  getCodexOrchestratorSession,
  sendToCodexOrchestrator,
} from '@/lib/lane/codex-orchestrator-session';
import {
  ensureOrchestratorSession,
  getOrchestratorSession,
  sendToOrchestrator,
} from '@/lib/lane/orchestrator-session';
import { resolveInAppOrchestratorEnabledSync } from '@/lib/operator/defaults';
import { openclawBackend } from './openclaw';
import type { OrchestratorBackend, OrchestratorBackendId } from './types';

// ── Delegate backends ────────────────────────────────────────────────────────

const claudeBackend: OrchestratorBackend = {
  id: 'claude',
  label: 'Claude',
  peekSession(repoPath, _agent, threadId) {
    const session = getOrchestratorSession(repoPath, threadId);
    return session ? { sessionName: session.sessionName, status: session.status } : null;
  },
  ensureSession(repoPath, _agent, threadId) {
    const session = ensureOrchestratorSession(repoPath, threadId);
    return { sessionName: session.sessionName, status: session.status };
  },
  sendTurn(repoPath, message, onEvent, options) {
    return sendToOrchestrator(ensureOrchestratorSession(repoPath, options?.threadId), message, onEvent, options);
  },
};

const codexBackend: OrchestratorBackend = {
  id: 'codex',
  label: 'Codex',
  peekSession(repoPath, _agent, threadId) {
    const session = getCodexOrchestratorSession(repoPath, threadId);
    return session ? { sessionName: session.sessionName, status: session.status } : null;
  },
  ensureSession(repoPath, _agent, threadId) {
    const session = ensureCodexOrchestratorSession(repoPath, threadId);
    return { sessionName: session.sessionName, status: session.status };
  },
  sendTurn(repoPath, message, onEvent, options) {
    return sendToCodexOrchestrator(
      ensureCodexOrchestratorSession(repoPath, options?.threadId),
      message,
      onEvent,
      options,
    );
  },
};

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Registered backends. `openclaw` is added when its backend module ships;
 * `getOrchestratorBackend` falls back to Codex for an unregistered id.
 */
const BACKENDS: Partial<Record<OrchestratorBackendId, OrchestratorBackend>> = {
  claude: claudeBackend,
  codex: codexBackend,
  openclaw: openclawBackend,
};

/** The default backend — also the fallback for any unregistered id. */
const DEFAULT_BACKEND = codexBackend;

export function getOrchestratorBackend(id: OrchestratorBackendId): OrchestratorBackend {
  return BACKENDS[id] ?? DEFAULT_BACKEND;
}

/**
 * Resolve the active orchestrator backend id.
 *
 * Until the openclaw backend ships there is no dedicated operator setting, so
 * this derives directly from the legacy `inAppOrchestratorEnabled` boolean —
 * behavior is byte-identical to the pre-registry dual-path branches:
 *   - toggle OFF (default) → Codex GPT-5.5 xhigh
 *   - toggle ON            → Claude
 * The openclaw step swaps this for an `orchestratorBackend` operator setting
 * that falls back to this same derivation.
 */
export function resolveOrchestratorBackendId(): OrchestratorBackendId {
  return resolveInAppOrchestratorEnabledSync() ? 'claude' : 'codex';
}

/** The active backend, resolved from operator settings. */
export function getActiveOrchestratorBackend(): OrchestratorBackend {
  return getOrchestratorBackend(resolveOrchestratorBackendId());
}
