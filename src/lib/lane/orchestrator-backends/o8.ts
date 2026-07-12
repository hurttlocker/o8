/**
 * o8 orchestrator backend — the FREE conversational surface.
 *
 * Routes an orchestrator turn to the Vercel AI Gateway free model
 * (`streamFreeOrchestratorChat`) so the operator can exercise the full
 * orchestrator UI — token streaming, transcripts, banners, thread restore —
 * without drawing on any Claude / Codex subscription pool. It replaces the
 * experimental llm-chat tab as the free-test surface (operator ruling
 * 2026-07-12).
 *
 * v1 is pure conversational streaming: NO tools, NO dispatch, NO MCP. If the
 * model is asked to do repo work it answers in text and never dispatches.
 *
 * Stateless: the gateway holds no server session, so a "session" here is just a
 * deterministic per-repo+thread name used to route WS broadcasts. Prior turns
 * are reconstructed from the persisted thread transcript on every send (the user
 * message is already on disk by the time ws-server calls `sendTurn`).
 */

import { missingChatGatewayEnv, streamFreeOrchestratorChat } from '@/lib/chat/gateway-client';
import type { ChatHistoryMessage } from '@/lib/chat/types';
import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { readOrchestratorThreadMessages } from '@/lib/mobile/orchestrator-thread-history';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/** Helicone telemetry bucket — the free o8 model has no per-operator identity. */
const O8_FREE_USER_ID = 'o8-orchestrator-free';

/** Deterministic-name registry so `peekSession` mirrors an ensured session. */
const ensured = new Set<string>();

function o8SessionName(repoPath: string, threadId?: string | null): string {
  return sessionNameForRepo('o8-free-orchestrator', repoPath, threadId);
}

async function sendToO8Orchestrator(
  sessionName: string,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions,
): Promise<void> {
  const missing = missingChatGatewayEnv();
  if (missing.length > 0) {
    onEvent({
      type: 'error',
      error: `The free o8 model isn't configured on this install (missing ${missing.join(', ')}). Switch the composer to Claude or Codex.`,
    });
    onEvent({ type: 'done', sessionId: sessionName, cost: 0 });
    return;
  }

  // ws-server appends the user message to the thread transcript BEFORE calling
  // the backend, so the reconstructed history's last entry IS this turn. Use it
  // as-is; fall back to the raw message param only for non-thread-backed turns
  // (empty history) — never both, so the current turn is never doubled.
  const prior = readOrchestratorThreadMessages(options.threadId);
  const messages: ChatHistoryMessage[] =
    prior.length > 0 && prior[prior.length - 1].role === 'user'
      ? prior
      : [...prior, { role: 'user', content: message }];

  try {
    const stream = streamFreeOrchestratorChat({
      userId: O8_FREE_USER_ID,
      messages,
      abortSignal: options.signal,
    });
    for await (const chunk of stream) {
      if (chunk) onEvent({ type: 'text', text: chunk });
    }
    onEvent({ type: 'done', sessionId: sessionName, cost: 0 });
  } catch (err) {
    // A user interrupt aborts the stream — that's a clean stop, not an error
    // line. Any other failure (gateway down / no network) surfaces as a system
    // line in the transcript. Either way emit the terminal `done` so the client
    // "Working" latch releases (mirrors openclaw's error→done ordering).
    if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The free o8 model hit an error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    onEvent({ type: 'done', sessionId: sessionName, cost: 0 });
  }
}

export const o8Backend: OrchestratorBackend = {
  id: 'o8',
  label: 'o8',
  peekSession(repoPath, _agent, threadId): OrchestratorSessionInfo | null {
    const sessionName = o8SessionName(repoPath, threadId);
    return ensured.has(sessionName) ? { sessionName, status: 'ready' } : null;
  },
  ensureSession(repoPath, _agent, threadId): OrchestratorSessionInfo {
    const sessionName = o8SessionName(repoPath, threadId);
    ensured.add(sessionName);
    return { sessionName, status: 'ready' };
  },
  sendTurn(repoPath, message, onEvent, options) {
    const sessionName = o8SessionName(repoPath, options?.threadId);
    ensured.add(sessionName);
    return sendToO8Orchestrator(sessionName, message, onEvent, options ?? {});
  },
};
