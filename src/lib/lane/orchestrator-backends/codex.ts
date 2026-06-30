/**
 * Codex orchestrator backend — a thin delegate over the existing, UNMODIFIED
 * `codex-orchestrator-session.ts`. Extracted verbatim from `registry.ts` so the
 * MoA/Collide backend can import it without a registry ↔ moa import cycle.
 * File-per-backend, matching openclaw/acp.
 */

import {
  ensureCodexOrchestratorSession,
  getCodexOrchestratorSession,
  sendToCodexOrchestrator,
} from '@/lib/lane/codex-orchestrator-session';
import type { OrchestratorBackend } from './types';

export const codexBackend: OrchestratorBackend = {
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
