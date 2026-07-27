/**
 * Browser half of the fenced Codex app-server realtime route. It owns no media
 * or persona logic; realtime-client.ts keeps the existing RTCPeerConnection and
 * delegates only the local JSON-RPC session lifecycle and event long-poll here.
 */

export type CodexBrowserRealtimeMode = 'codex-oauth' | 'text';

export interface CodexBrowserRealtimeEvent {
  seq: number;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

export interface StartCodexBrowserRealtimeInput {
  sdp: string;
  voice?: string;
  model?: string;
  prompt?: string;
  onEvent?: (event: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

export interface CodexBrowserRealtimeSession {
  readonly mode: CodexBrowserRealtimeMode;
  readonly answerSdp: string | null;
  readonly fallbackReason: string | null;
  appendText: (text: string) => Promise<void>;
  appendSpeech: (text: string) => Promise<void>;
  stop: () => Promise<void>;
}

interface StartResponse {
  ok?: boolean;
  sessionId?: string;
  mode?: CodexBrowserRealtimeMode;
  sdp?: string | null;
  fallbackReason?: string | null;
  reason?: string;
}

interface PollResponse {
  ok?: boolean;
  events?: CodexBrowserRealtimeEvent[];
  nextSince?: number;
  reason?: string;
}

async function post(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch('/api/voice/realtime/codex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || data?.ok !== true) {
    throw new Error(
      typeof data?.reason === 'string'
        ? data.reason
        : `Codex realtime request failed (${response.status}).`,
    );
  }
  return data;
}

export async function startCodexBrowserRealtimeSession(
  input: StartCodexBrowserRealtimeInput,
): Promise<CodexBrowserRealtimeSession> {
  const started = await post({
    action: 'start',
    sdp: input.sdp,
    transport: 'webrtc',
    outputModality: 'audio',
    voice: input.voice,
    model: input.model,
    prompt: input.prompt,
    allowTextFallback: true,
  }) as StartResponse;
  const sessionId = typeof started.sessionId === 'string' ? started.sessionId : '';
  const mode = started.mode === 'codex-oauth' ? 'codex-oauth' : 'text';
  if (!sessionId) throw new Error('Codex realtime start returned no session id.');

  let stopped = false;
  let since = 0;
  let pollController: AbortController | null = null;

  const poll = async () => {
    while (!stopped) {
      pollController = new AbortController();
      try {
        const response = await fetch(
          `/api/voice/realtime/codex?sessionId=${encodeURIComponent(sessionId)}&since=${since}&timeoutMs=20000`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: pollController.signal,
          },
        );
        const data = await response.json().catch(() => null) as PollResponse | null;
        if (!response.ok || !data?.ok) {
          throw new Error(data?.reason || `Codex realtime event poll failed (${response.status}).`);
        }
        since = typeof data.nextSince === 'number' ? data.nextSince : since;
        for (const event of data.events ?? []) {
          try {
            input.onEvent?.({ type: event.method, ...event.params });
          } catch {
            // A consumer callback cannot break the transport poll.
          }
        }
      } catch (error) {
        if (stopped || (error instanceof DOMException && error.name === 'AbortError')) return;
        input.onError?.(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        pollController = null;
      }
    }
  };
  void poll();

  return {
    mode,
    answerSdp: typeof started.sdp === 'string' ? started.sdp : null,
    fallbackReason: typeof started.fallbackReason === 'string'
      ? started.fallbackReason
      : null,
    appendText: async (text) => {
      await post({ action: 'appendText', sessionId, text, role: 'user' });
    },
    appendSpeech: async (text) => {
      await post({ action: 'appendSpeech', sessionId, text });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      pollController?.abort();
      await post({ action: 'stop', sessionId }).catch(() => {});
    },
  };
}
