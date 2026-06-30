/**
 * Claude orchestrator backend — a thin delegate over the existing, UNMODIFIED
 * `orchestrator-session.ts` (the interactive Claude Code REPL). Extracted
 * verbatim from `registry.ts` so the MoA/Collide backend can import it without
 * a registry ↔ moa import cycle. File-per-backend, matching openclaw/acp.
 */

import {
  ensureOrchestratorSession,
  getOrchestratorSession,
  sendToOrchestrator,
} from '@/lib/lane/orchestrator-session';
import type { OrchestratorBackend } from './types';

export const claudeBackend: OrchestratorBackend = {
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
