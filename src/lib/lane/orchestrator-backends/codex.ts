/**
 * Codex orchestrator backend, a delegate over `codex-orchestrator-session.ts`.
 * Extracted from `registry.ts` so the
 * MoA/Collide backend can import it without a registry ↔ moa import cycle.
 * File-per-backend, matching openclaw/acp.
 */

import { prewarmHaiku } from '@/lib/cortex/qa/llm/haiku-adapter';
import { prewarmSonnetCli } from '@/lib/cortex/qa/llm/sonnet-adapter';
import {
  buildCodexOrchestratorPrompt,
  ensureCodexOrchestratorSession,
  getCodexOrchestratorSession,
  sendToCodexOrchestrator,
} from '@/lib/lane/codex-orchestrator-session';
import type { OrchestratorBackend } from './types';
import { getCodexAppBridgeSteer } from '@/lib/codex/app-bridge-steer';
import { getRemoteCodexAppBridgeSteer } from '@/lib/codex/app-bridge-steer-relay';

/** Capability is scoped to a specific running bridge, never a global setting. */
export function codexLiveSteerForThread(repoPath: string, threadId: string): OrchestratorBackend['liveSteer'] {
  return getCodexAppBridgeSteer(getCodexOrchestratorSession(repoPath, threadId))
    ?? getRemoteCodexAppBridgeSteer({ repoPath, threadId });
}

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
    if (options?.permissionMode === 'outside-workspace') return Promise.reject(new Error('Outside workspace commands require the built-in lead.'));
    void prewarmHaiku().catch(() => {});
    void prewarmSonnetCli().catch(() => {});
    return sendToCodexOrchestrator(
      ensureCodexOrchestratorSession(repoPath, options?.threadId),
      buildCodexOrchestratorPrompt(repoPath, message, {
        toolProfile: options?.toolProfile,
        orchestrationMode: options?.orchestrationMode,
      }),
      onEvent,
      { ...options, permissionMode: options?.permissionMode },
    );
  },
};
