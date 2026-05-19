/**
 * Orchestrator backend contract.
 *
 * An "orchestrator backend" is a runtime that, given a user message + the o8
 * operator MCP config, drives one orchestrator turn and emits an
 * `OrchestratorEvent` stream. Codex and Claude are the first two backends;
 * openclaw is added next, Hermes after.
 *
 * The backend is NOT the worker runtime. Workers (Codex packets in isolated
 * worktrees) are dispatched by the orchestrator through the o8 operator MCP,
 * regardless of which backend orchestrates — that is the whole point of the
 * orchestrator-runtime ≠ worker-runtime rule (issue #1075).
 *
 * See `registry.ts` for the registry + the Codex/Claude delegate backends.
 */

import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/** The set of orchestrator backends. `openclaw` is registered in a later step. */
export type OrchestratorBackendId = 'codex' | 'claude' | 'openclaw';

export type OrchestratorSessionStatus = 'ready' | 'busy' | 'dead';

export interface OrchestratorTurnOptions {
  /** `'full'` runs autonomously; `'plan'` requires approval for writes. */
  permissionMode?: 'full' | 'plan';
  thinkingEffort?: ThinkingEffort;
  model?: string;
  /**
   * openclaw agent id for the turn — openclaw backend only, ignored by codex /
   * claude. Omitted → the backend's default agent. See docs/openclaw-integration.md.
   */
  agent?: string;
  /** Aborts the in-flight turn — the backend SIGTERMs its subprocess. */
  signal?: AbortSignal;
}

/** Lightweight view of a backend's per-repo session. */
export interface OrchestratorSessionInfo {
  sessionName: string;
  status: OrchestratorSessionStatus;
}

export interface OrchestratorBackend {
  readonly id: OrchestratorBackendId;
  /** Human-readable label, used in logs. */
  readonly label: string;
  /**
   * Look up the repo's session WITHOUT creating one — null if none exists.
   * `agent` selects the openclaw agent (openclaw backend only).
   */
  peekSession(repoPath: string, agent?: string): OrchestratorSessionInfo | null;
  /**
   * Ensure a session exists for the repo, creating/recovering as needed.
   * `agent` selects the openclaw agent (openclaw backend only).
   */
  ensureSession(repoPath: string, agent?: string): OrchestratorSessionInfo;
  /**
   * Run one orchestrator turn. Ensures the session, spawns the backend, and
   * streams `OrchestratorEvent`s to `onEvent`. Resolves when the turn ends.
   */
  sendTurn(
    repoPath: string,
    message: string,
    onEvent: (event: OrchestratorEvent) => void,
    options?: OrchestratorTurnOptions,
  ): Promise<void>;
}
