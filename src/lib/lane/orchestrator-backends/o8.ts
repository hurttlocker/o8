/**
 * o8 orchestrator backend — the FREE conversational surface.
 *
 * Routes an orchestrator turn to the DESKTOP free-chat rail — the branded
 * zero-setup `o8-operator` model behind `/api/v2/proxy/llm` (Gemini Flash with
 * an OpenRouter free fallback, resolved server-side). This is the same rail the
 * llm-chat tab's default model rides, so it works on every desktop install with
 * no cloud-only env (the Vercel AI Gateway path needs CLERK_SECRET_KEY, which by
 * policy never ships to the desktop). It lets the operator exercise the full
 * orchestrator UI — token streaming, transcripts, banners, thread restore —
 * without drawing on any Claude / Codex subscription pool. Replaces the
 * experimental llm-chat tab as the free-test surface (operator ruling
 * 2026-07-12).
 *
 * v1 is pure conversational streaming: NO tools (`disableTools: true`), NO
 * dispatch, NO MCP. If the model is asked to do repo work it answers in text and
 * never dispatches.
 *
 * Stateless: the proxy holds no server session, so a "session" here is just a
 * deterministic per-repo+thread name used to route WS broadcasts. Prior turns
 * are reconstructed from the persisted thread transcript on every send (the user
 * message is already on disk by the time ws-server calls `sendTurn`).
 *
 * The fetch targets the loopback API base (`getApiBase()`), and ws-server runs
 * on loopback, so the middleware passes it without a bearer token.
 */

import { sessionNameForRepo } from '@/lib/lane/orchestrator-session-core';
import { readOrchestratorThreadMessages } from '@/lib/mobile/orchestrator-thread-history';
import { getApiBase } from '@/lib/panel/api-port';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type {
  OrchestratorBackend,
  OrchestratorSessionInfo,
  OrchestratorTurnOptions,
} from './types';

/**
 * Conversational framing appended to the proxy's own chat system prompt (the
 * proxy folds any `role: 'system'` message into its system context). Keeps the
 * free model from claiming it can dispatch or run tools.
 */
const O8_SYSTEM_PROMPT = [
  'You are o8 — the free conversational model inside the o8 control plane.',
  'Answer concisely and helpfully.',
  'You are a chat surface only in this mode: you cannot dispatch agents, run tools,',
  'edit files, or drive the repo. If the operator asks for real repo work, say plainly',
  'that the free o8 model is conversational only and that they can switch the composer',
  'to Claude or Codex to dispatch actual agents. Never claim you dispatched or ran anything.',
].join(' ');

type ProxyMessage = { role: 'system' | 'user' | 'assistant'; content: string };

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
  const done = () => onEvent({ type: 'done', sessionId: sessionName, cost: 0 });

  // ws-server appends the user message to the thread transcript BEFORE calling
  // the backend, so the reconstructed history's last entry IS this turn. Use it
  // as-is; fall back to the raw message param only for non-thread-backed turns
  // (empty history) — never both, so the current turn is never doubled.
  const prior = readOrchestratorThreadMessages(options.threadId);
  const history: ProxyMessage[] =
    prior.length > 0 && prior[prior.length - 1].role === 'user'
      ? prior
      : [...prior, { role: 'user', content: message }];
  const messages: ProxyMessage[] = [{ role: 'system', content: O8_SYSTEM_PROMPT }, ...history];

  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/api/v2/proxy/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'o8-operator',
        provider: 'operator',
        messages,
        disableTools: true,
      }),
      signal: options.signal,
    });
  } catch (err) {
    // Reaching the proxy failed (or a user abort landed before the response). A
    // clean stop is not an error line; anything else surfaces as one.
    if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The free o8 model couldn't reach the model service: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
    return;
  }

  // Non-2xx from the proxy is a JSON error body (`{ error }`), not an SSE stream.
  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json() as { error?: unknown };
      if (typeof payload?.error === 'string' && payload.error.trim()) detail = payload.error;
    } catch {
      // Non-JSON body — keep the status-code detail.
    }
    onEvent({ type: 'error', error: `The free o8 model is unavailable: ${detail}` });
    done();
    return;
  }

  // SSE frames: `data: {json}\n\n`, terminated by `data: [DONE]`. We map
  // `{ type: 'content', text }` → text events and `{ type: 'error', message }`
  // → an error event; every other frame (thinking / usage / tool_call / sources
  // / fallback) is irrelevant to v1 conversational streaming and skipped.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]' || data.trim() === '') continue;
        let parsed: { type?: string; text?: unknown; message?: unknown };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.type === 'content' && typeof parsed.text === 'string') {
          if (parsed.text) onEvent({ type: 'text', text: parsed.text });
        } else if (parsed.type === 'error') {
          onEvent({
            type: 'error',
            error: typeof parsed.message === 'string' && parsed.message.trim()
              ? parsed.message
              : 'The free o8 model hit an error.',
          });
        }
      }
    }
    done();
  } catch (err) {
    // A user interrupt aborts the read — a clean stop, no error line. Any other
    // failure surfaces as a system line. Either way emit the terminal `done` so
    // the client "Working" latch releases (mirrors openclaw's error→done order).
    if (!options.signal?.aborted) {
      onEvent({
        type: 'error',
        error: `The free o8 model hit an error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    done();
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
