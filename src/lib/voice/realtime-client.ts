/**
 * Symon Realtime — browser WebRTC client (Track B, P3).
 *
 * Owns the RTCPeerConnection inside the webview: mic in (getUserMedia) flows to
 * OpenAI, the model's audio comes back into a hidden <audio> element. The SDP
 * offer/answer handshake is proxied through our server (/api/voice/realtime/sdp)
 * so the webview never touches api.openai.com directly and the OpenAI key stays
 * server-side. The 'oai-events' data channel carries session config now and
 * function-call routing later (P4).
 *
 * Browser-only — never import server code here (no `server-only`). Heavily
 * logged with [realtime] so the live talk↔hear loop is observable while we tune.
 */

// Symon's persona lives in the shared session-config module so the desk session
// and the phone-hosted Agent-mode mint (/api/mobile/symon/session) speak with the
// identical brain. Isomorphic module — safe to import from this browser-only file
// (it carries no `server-only` poison pill). See docs/symon-agent-mode.md.
import {
  DEFAULT_INSTRUCTIONS,
  DEFAULT_VOICE,
} from '@/lib/voice/realtime-session-config';
import {
  startCodexBrowserRealtimeSession,
  type CodexBrowserRealtimeSession,
} from '@/lib/voice/codex-realtime-browser';

export type RealtimeStatus =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'live'
  | 'stopping'
  | 'error';

export function realtimeCallReviewGuardId(sessionId: string, callId: string): string {
  return `desktop:${JSON.stringify([sessionId, callId])}`;
}

export interface RealtimeSessionHandle {
  stop: () => Promise<void>;
  appendText: (text: string) => Promise<void>;
  appendSpeech: (text: string) => Promise<void>;
  readonly mode: 'openai-byok' | 'codex-oauth' | 'text';
  readonly status: RealtimeStatus;
}

export interface StartRealtimeOptions {
  /** OpenAI realtime voice (marin, alloy, echo, shimmer, cedar, …). */
  voice?: string;
  /** System prompt / persona for Symon. */
  instructions?: string;
  /** Override the realtime model. */
  model?: string;
  /** Existing direct OpenAI path, or the fenced local Codex OAuth transport. */
  transport?: 'openai-byok' | 'codex-oauth';
  onStatus?: (status: RealtimeStatus, detail?: string) => void;
  /** Raw 'oai-events' messages (transcripts, response.done, function_call — P4 hook). */
  onEvent?: (event: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

const LOG = '[realtime]';

export interface RealtimeUtteranceTracker {
  observe: (event: Record<string, unknown>) => void;
  /** Empty string means a system-only response; null means ASR failed or timed out. */
  transcriptForResponse: (responseId: string, timeoutMs?: number) => Promise<string | null>;
}

const SPOKEN_REVIEW_APPROVAL_TOOLS = new Set([
  'o8_approve_item',
  'o8_reject_item',
]);
const PROTECTED_ASR_TIMEOUT_MS = 10_000;

export type RealtimeApprovalAudioFailure =
  | 'no_audio'
  | 'interrupted'
  | 'response_incomplete'
  | 'session_ended'
  | 'audio_already_claimed'
  | 'timeout';

export type RealtimeApprovalAudioResult =
  | { ok: true }
  | { ok: false; reason: RealtimeApprovalAudioFailure };

export interface RealtimeApprovalAudioGate {
  observe: (event: Record<string, unknown>) => void;
  waitForPlaybackStop: (responseId: string) => Promise<RealtimeApprovalAudioResult>;
  claimForProtectedCall: (responseId: string) => RealtimeApprovalAudioResult;
  abort: () => void;
}

interface ApprovalAudioState {
  started: boolean;
  guarded: boolean;
  claimed: boolean;
  result: RealtimeApprovalAudioResult | null;
  waiters: Set<(result: RealtimeApprovalAudioResult) => void>;
}

function responseIdFromRealtimeEvent(event: Record<string, unknown>): string {
  const direct = event['response_id'];
  if (typeof direct === 'string' && direct) return direct;
  const response = event['response'];
  if (!response || typeof response !== 'object') return '';
  const nested = (response as Record<string, unknown>)['id'];
  return typeof nested === 'string' ? nested : '';
}

/**
 * Hold packet approval/rejection calls until the review audio has actually left
 * the WebRTC output buffer. A generated response is insufficient: interruption,
 * teardown, or a response with no audio must never reach the native confirm gate.
 */
export function createRealtimeApprovalAudioGate(
  timeoutMs = 30_000,
): RealtimeApprovalAudioGate {
  const states = new Map<string, ApprovalAudioState>();
  let activeResponseId = '';
  let playbackResponseId = '';
  let ended = false;

  const stateFor = (responseId: string) => {
    let state = states.get(responseId);
    if (!state) {
      state = {
        started: false,
        guarded: false,
        claimed: false,
        result: null,
        waiters: new Set(),
      };
      states.set(responseId, state);
    }
    return state;
  };

  const settle = (
    responseId: string,
    result: RealtimeApprovalAudioResult,
    override = false,
  ) => {
    if (!responseId) return;
    const state = stateFor(responseId);
    if (state.claimed) return;
    if (state.result && !override) return;
    state.result = result;
    for (const resolve of state.waiters) resolve(result);
    state.waiters.clear();
  };

  const failCurrentPlayback = (
    reason: RealtimeApprovalAudioFailure,
    responseIdHint = '',
  ) => {
    const responseId = responseIdHint || playbackResponseId || activeResponseId;
    if (responseId) settle(responseId, { ok: false, reason }, true);
    playbackResponseId = '';
  };

  return {
    observe: (event) => {
      const type = typeof event.type === 'string' ? event.type : '';
      const eventResponseId = responseIdFromRealtimeEvent(event);
      if (type === 'response.created') {
        activeResponseId = eventResponseId;
        if (activeResponseId) stateFor(activeResponseId);
        return;
      }
      if (type === 'output_audio_buffer.started') {
        const responseId = eventResponseId || activeResponseId;
        if (!responseId) return;
        playbackResponseId = responseId;
        stateFor(responseId).started = true;
        return;
      }
      if (type === 'output_audio_buffer.stopped') {
        const responseId = eventResponseId || playbackResponseId || activeResponseId;
        const state = responseId ? states.get(responseId) : undefined;
        if (responseId && state?.started) settle(responseId, { ok: true });
        if (playbackResponseId === responseId) playbackResponseId = '';
        return;
      }
      if (type === 'output_audio_buffer.cleared') {
        failCurrentPlayback('interrupted', eventResponseId);
        return;
      }
      if (type === 'input_audio_buffer.speech_started') {
        for (const [responseId, state] of states) {
          if (state.guarded && !state.claimed) {
            settle(responseId, { ok: false, reason: 'interrupted' }, true);
          }
        }
        if (playbackResponseId || activeResponseId) failCurrentPlayback('interrupted');
        return;
      }
      if (type === 'response.done') {
        const response = event['response'];
        const status = response && typeof response === 'object'
          ? (response as Record<string, unknown>)['status']
          : undefined;
        if (eventResponseId && typeof status === 'string' && status !== 'completed') {
          settle(eventResponseId, { ok: false, reason: 'response_incomplete' });
        }
        if (activeResponseId === eventResponseId) activeResponseId = '';
      }
    },
    waitForPlaybackStop: async (responseId) => {
      if (ended) return { ok: false, reason: 'session_ended' };
      const state = responseId ? states.get(responseId) : undefined;
      if (!state?.started) return { ok: false, reason: 'no_audio' };
      state.guarded = true;
      if (state.result) return state.result;

      return new Promise<RealtimeApprovalAudioResult>((resolve) => {
        let settled = false;
        const finish = (result: RealtimeApprovalAudioResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          state.waiters.delete(finish);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle(responseId, { ok: false, reason: 'timeout' });
        }, timeoutMs);
        state.waiters.add(finish);
      });
    },
    claimForProtectedCall: (responseId) => {
      if (ended) return { ok: false, reason: 'session_ended' };
      const state = responseId ? states.get(responseId) : undefined;
      if (!state?.started) return { ok: false, reason: 'no_audio' };
      if (state.claimed) return { ok: false, reason: 'audio_already_claimed' };
      if (!state.result?.ok) {
        return state.result ?? { ok: false, reason: 'response_incomplete' };
      }
      state.claimed = true;
      return { ok: true };
    },
    abort: () => {
      if (ended) return;
      ended = true;
      for (const responseId of states.keys()) {
        settle(responseId, { ok: false, reason: 'session_ended' });
      }
      activeResponseId = '';
      playbackResponseId = '';
    },
  };
}

/**
 * Attribute completed input transcripts by their Realtime conversation item,
 * then bind each response to the item active at response.created. Transcription
 * completion is asynchronous and may arrive after response.done, so callers
 * await that item's completed/failed event instead of borrowing whichever
 * transcript was completed most recently or imposing a guessed deadline.
 */
export function createRealtimeUtteranceTracker(): RealtimeUtteranceTracker {
  let currentItemId = '';
  const transcripts = new Map<string, string | null>();
  const responseItems = new Map<string, string>();
  const waiters = new Map<string, Set<(transcript: string | null) => void>>();
  const itemOrder: string[] = [];

  const rememberItem = (itemId: string) => {
    if (!itemId || itemOrder.includes(itemId)) return;
    itemOrder.push(itemId);
    while (itemOrder.length > 32) {
      const expired = itemOrder.shift();
      if (!expired) break;
      transcripts.delete(expired);
      waiters.delete(expired);
      for (const [responseId, responseItemId] of responseItems) {
        if (responseItemId === expired) responseItems.delete(responseId);
      }
    }
  };

  return {
    observe: (event) => {
      if (
        event.type === 'input_audio_buffer.speech_started'
        || event.type === 'input_audio_buffer.committed'
      ) {
        const itemId = event['item_id'];
        if (typeof itemId === 'string' && itemId) {
          currentItemId = itemId;
          rememberItem(itemId);
        }
      }
      if (event.type === 'response.created') {
        const response = event['response'];
        const responseId = response && typeof response === 'object'
          ? (response as Record<string, unknown>)['id']
          : undefined;
        if (typeof responseId === 'string' && responseId && currentItemId) {
          responseItems.set(responseId, currentItemId);
        }
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const itemId = event['item_id'];
        const transcript = event['transcript'];
        if (typeof itemId !== 'string' || !itemId || typeof transcript !== 'string') return;
        const normalized = transcript.trim();
        rememberItem(itemId);
        transcripts.set(itemId, normalized);
        for (const resolve of waiters.get(itemId) ?? []) resolve(normalized);
        waiters.delete(itemId);
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed') {
        const itemId = event['item_id'];
        if (typeof itemId !== 'string' || !itemId) return;
        rememberItem(itemId);
        transcripts.set(itemId, null);
        for (const resolve of waiters.get(itemId) ?? []) resolve(null);
        waiters.delete(itemId);
      }
    },
    transcriptForResponse: async (responseId, timeoutMs) => {
      const itemId = responseItems.get(responseId);
      if (!itemId) return '';
      const ready = transcripts.get(itemId);
      if (ready !== undefined) return ready;
      return new Promise<string | null>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (transcript: string | null) => {
          if (timer) clearTimeout(timer);
          const itemWaiters = waiters.get(itemId);
          itemWaiters?.delete(finish);
          if (itemWaiters?.size === 0) waiters.delete(itemId);
          resolve(transcript);
        };
        const itemWaiters = waiters.get(itemId) ?? new Set<(transcript: string | null) => void>();
        itemWaiters.add(finish);
        waiters.set(itemId, itemWaiters);
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => finish(null), Math.max(0, timeoutMs));
        }
      });
    },
  };
}

/**
 * Mirror a key realtime event into the Rust app log (record_realtime_event →
 * o8.log) so a live voice test is observable from outside the webview — the
 * webview only forwards console.error otherwise. Fire-and-forget; a no-op
 * outside a Tauri webview.
 */
function forwardLog(line: string): void {
  import('@tauri-apps/api/core')
    .then((m) => m.invoke('record_realtime_event', { line }))
    .catch(() => { /* not in a Tauri webview */ });
}

/**
 * Meter a realtime response. gpt-realtime reports per-response token usage in
 * `response.done.usage`; forward it to the server so it's priced + written to
 * usage_logs (the spend you see during the $5 dogfood). Fire-and-forget — a
 * metering hiccup must never interrupt the conversation.
 */
function reportUsage(usage: unknown, model: string | undefined, sessionKey: string): void {
  if (!usage || typeof usage !== 'object') return;
  fetch('/api/voice/realtime/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ usage, model, sessionKey }),
  }).catch(() => { /* metering is best-effort */ });
}

/**
 * Mirror the session PRESENCE to the screen dock (the always-on Symon pill) so
 * "voice is live" shows up where Symon lives — not only in the IDE window. Maps
 * the fine-grained {@link RealtimeStatus} down to the dock's simple set
 * (`off | connecting | live | error`). Fire-and-forget; a no-op outside a Tauri
 * webview.
 */
function forwardPresence(status: RealtimeStatus): void {
  const simple =
    status === 'live' ? 'live'
      : status === 'requesting-mic' || status === 'connecting' ? 'connecting'
        : status === 'error' ? 'error'
          : 'off'; // idle | stopping → gone
  import('@tauri-apps/api/core')
    .then((m) => m.invoke('realtime_status_changed', { status: simple }))
    .catch(() => { /* not in a Tauri webview */ });
}

// DEFAULT_INSTRUCTIONS is imported at the top of the module from the shared
// session-config source (parity with the Agent-mode mint).

/**
 * Start a live realtime voice session. Returns a handle immediately (status
 * flips through requesting-mic → connecting → live); call `stop()` any time to
 * abort mid-connect or end a live session. All teardown is idempotent.
 */
export function startRealtimeSession(opts: StartRealtimeOptions = {}): RealtimeSessionHandle {
  // Stable id for the whole conversation so every metered response groups into
  // one "Symon Voice" session in the cost dashboard.
  const meterSessionId = `realtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let status: RealtimeStatus = 'idle';
  let aborted = false;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let codexSession: CodexBrowserRealtimeSession | null = null;
  let toolDefs: Array<Record<string, unknown>> = [];
  // OpenAI emits input transcription as a separate asynchronous server event.
  // Keep the latest completed utterance so native tool calls can persist the
  // operator's words alongside the action they triggered.
  const utteranceTracker = createRealtimeUtteranceTracker();
  const approvalAudioGate = createRealtimeApprovalAudioGate();
  const activeNativeReviewGuards = new Set<string>();

  const interruptNativeReviews = () => {
    const guardIds = [...activeNativeReviewGuards];
    if (guardIds.length === 0) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => Promise.all(guardIds.map((reviewGuardId) => (
        invoke('realtime_interrupt_review', { reviewGuardId })
      ))))
      .catch((error) => console.warn(`${LOG} native review interrupt failed:`, error));
  };

  const setStatus = (s: RealtimeStatus, detail?: string) => {
    status = s;
    console.log(`${LOG} status → ${s}${detail ? `: ${detail}` : ''}`);
    forwardLog(`status → ${s}${detail ? `: ${detail}` : ''}`);
    forwardPresence(s);
    try { opts.onStatus?.(s, detail); } catch { /* listener threw — ignore */ }
  };

  const teardownMedia = async () => {
    try { dc?.close(); } catch { /* already closed */ }
    try {
      if (pc) {
        pc.getSenders().forEach((sender) => { try { sender.track?.stop(); } catch { /* */ } });
        pc.close();
      }
    } catch { /* */ }
    try { micStream?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try {
      if (audioEl) {
        audioEl.srcObject = null;
        audioEl.remove();
      }
    } catch { /* */ }
    pc = null; dc = null; micStream = null; audioEl = null;
  };

  const teardown = async () => {
    approvalAudioGate.abort();
    interruptNativeReviews();
    const activeCodexSession = codexSession;
    codexSession = null;
    await activeCodexSession?.stop();
    await teardownMedia();
  };

  const fail = (msg: string) => {
    console.error(`${LOG} error: ${msg}`);
    setStatus('error', msg);
    try { opts.onError?.(msg); } catch { /* */ }
    void teardown();
  };

  const sendEvent = (obj: Record<string, unknown>) => {
    try { dc?.send(JSON.stringify(obj)); }
    catch (e) { console.warn(`${LOG} send failed:`, e); }
  };

  // gpt-realtime surfaces function calls as items in response.done. Run each
  // through the Rust bridge (which applies the same confirm gate the cascaded
  // agent uses), return the output, then response.create so the model speaks
  // the result. Same 64-tool catalog — true parity with push-to-talk.
  const handleFunctionCalls = async (response: Record<string, unknown>) => {
    const output = response['output'];
    if (!Array.isArray(output)) return;
    const calls = output.filter(
      (it): it is { name?: string; call_id?: string; arguments?: string } =>
        !!it && typeof it === 'object' && (it as { type?: string }).type === 'function_call',
    );
    if (!calls.length) return;
    const responseId = typeof response['id'] === 'string' ? response['id'] : '';
    const hasProtectedCall = calls.some((call) => SPOKEN_REVIEW_APPROVAL_TOOLS.has(call.name || ''));
    // Arm both waits before yielding. Playback may already be stopped when
    // response.done arrives, but the guarded state stays interruptible until one
    // protected call atomically claims it below. Bounding ASR keeps a missing
    // terminal transcription event from holding a protected action forever.
    const protectedPlaybackPromise = hasProtectedCall
      ? approvalAudioGate.waitForPlaybackStop(responseId)
      : null;
    const actionUtterancePromise = utteranceTracker.transcriptForResponse(
      responseId,
      hasProtectedCall ? PROTECTED_ASR_TIMEOUT_MS : undefined,
    );
    const [actionUtterance, protectedPlayback] = protectedPlaybackPromise
      ? await Promise.all([actionUtterancePromise, protectedPlaybackPromise])
      : [await actionUtterancePromise, null];

    let mod: typeof import('@tauri-apps/api/core') | null = null;
    try { mod = await import('@tauri-apps/api/core'); } catch { /* not in a Tauri webview */ }

    for (const call of calls) {
      const name = call.name || '';
      const callId = call.call_id || '';
      let args: Record<string, unknown> = {};
      try { args = call.arguments ? JSON.parse(call.arguments) as Record<string, unknown> : {}; }
      catch { /* model sent malformed args — pass {} */ }
      console.log(`${LOG} function_call: ${name}`, args);
      forwardLog(`function_call: ${name}`);

      let result: unknown = { error: 'tool bridge unavailable' };
      if (actionUtterance === null) {
        result = { error: 'utterance_transcription_failed' };
      } else if (SPOKEN_REVIEW_APPROVAL_TOOLS.has(name)) {
        const playback = protectedPlayback ?? { ok: false as const, reason: 'no_audio' as const };
        if (!playback.ok) {
          result = {
            error: 'spoken_review_audio_incomplete',
            reason: playback.reason,
            detail: 'The spoken packet review did not finish playing. Review the packet again before approving or rejecting it.',
          };
        } else {
          const claim = approvalAudioGate.claimForProtectedCall(responseId);
          if (!claim.ok) {
            result = {
              error: 'spoken_review_audio_incomplete',
              reason: claim.reason,
              detail: claim.reason === 'audio_already_claimed'
                ? 'One spoken review can authorize only one approval or rejection attempt.'
                : 'The spoken packet review was interrupted before the action could be claimed. Review the packet again before approving or rejecting it.',
            };
          } else if (mod) {
            const reviewGuardId = `${meterSessionId}:${responseId}`;
            activeNativeReviewGuards.add(reviewGuardId);
            try {
              result = await mod.invoke('realtime_invoke_tool', {
                name,
                args,
                utterance: actionUtterance || undefined,
                reviewGuardId,
              });
            } catch (e) {
              result = { error: (e as Error)?.message || String(e) };
            } finally {
              activeNativeReviewGuards.delete(reviewGuardId);
            }
          }
        }
      } else if (mod) {
        const reviewGuardId = realtimeCallReviewGuardId(meterSessionId, callId);
        activeNativeReviewGuards.add(reviewGuardId);
        try {
          result = await mod.invoke('realtime_invoke_tool', {
            name,
            args,
            utterance: actionUtterance || undefined,
            reviewGuardId,
          });
        }
        catch (e) { result = { error: (e as Error)?.message || String(e) }; }
        finally { activeNativeReviewGuards.delete(reviewGuardId); }
      }
      const errored = !!(result && typeof result === 'object' && 'error' in (result as Record<string, unknown>));
      console.log(`${LOG} tool ${name} → ${errored ? 'error' : 'ok'}`);

      sendEvent({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
      });
    }
    sendEvent({ type: 'response.create' });
  };

  const handle: RealtimeSessionHandle = {
    get status() { return status; },
    get mode() {
      return codexSession?.mode
        ?? (opts.transport === 'codex-oauth' ? 'codex-oauth' : 'openai-byok');
    },
    appendText: async (text) => {
      if (!codexSession) throw new Error('Text append requires the Codex realtime transport.');
      await codexSession.appendText(text);
    },
    appendSpeech: async (text) => {
      if (!codexSession) throw new Error('Speech append requires the Codex realtime transport.');
      await codexSession.appendSpeech(text);
    },
    stop: async () => {
      if (status === 'idle' || status === 'stopping') return;
      aborted = true;
      setStatus('stopping');
      await teardown();
      setStatus('idle');
    },
  };

  void (async () => {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return fail('Microphone API unavailable in this environment.');
    }

    // 1. Microphone — echo cancellation matters: it stops the model hearing itself.
    setStatus('requesting-mic');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      return fail(`Microphone denied or unavailable: ${(e as Error)?.message || String(e)}`);
    }
    if (aborted) return teardown();

    // 2. Peer connection + audio sink.
    setStatus('connecting');

    // Load the native tool catalog so the model can act (P4). Same tools the
    // cascaded agent uses; each runs through the Rust confirm gate. If we're
    // not in a Tauri webview, this stays empty → conversation-only, no error.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke('realtime_tools') as Array<Record<string, unknown>>;
      if (Array.isArray(raw)) toolDefs = raw.map((t) => ({ type: 'function', ...t }));
      console.log(`${LOG} loaded ${toolDefs.length} tools`);
      forwardLog(`loaded ${toolDefs.length} tools`);
    } catch (e) {
      console.warn(`${LOG} tool catalog unavailable (conversation-only):`, e);
    }
    if (aborted) return teardown();

    pc = new RTCPeerConnection();

    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', 'true');
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);

    pc.ontrack = (ev) => {
      console.log(`${LOG} remote track: ${ev.track.kind}`);
      if (audioEl && ev.streams[0]) audioEl.srcObject = ev.streams[0];
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc?.iceConnectionState;
      console.log(`${LOG} ice → ${st}`);
      if (st === 'failed') fail('ICE connection failed.');
    };

    micStream.getTracks().forEach((t) => pc!.addTrack(t, micStream!));

    // 3. Data channel — must exist before createOffer so it lands in the SDP.
    dc = pc.createDataChannel('oai-events');
    dc.onopen = () => {
      if (opts.transport === 'codex-oauth') {
        console.log(`${LOG} data channel open — Codex app-server owns session config`);
        return;
      }
      console.log(`${LOG} data channel open — sending session.update`);
      const update: Record<string, unknown> = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: opts.instructions || DEFAULT_INSTRUCTIONS,
          audio: {
            input: { transcription: { model: 'whisper-1' } },
            output: { voice: opts.voice || DEFAULT_VOICE },
          },
          ...(toolDefs.length ? { tools: toolDefs, tool_choice: 'auto' } : {}),
        },
      };
      sendEvent(update);
    };
    dc.onmessage = (ev) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(ev.data as string); } catch { return; }
      if (!parsed) return;
      if (typeof parsed.type === 'string') {
        // Surface errors loudly; everything else is fine at log level.
        if (parsed.type === 'error') {
          console.error(`${LOG} oai error:`, parsed);
          forwardLog(`oai error: ${JSON.stringify(parsed).slice(0, 300)}`);
        } else {
          console.log(`${LOG} event: ${parsed.type}`);
          // Mirror turn boundaries to the app log (timestamps) so a live voice
          // test is diagnosable from o8.log — compare response.created/done to
          // the host's idle-stop to prove a long reply isn't cut. Low volume.
          if (parsed.type === 'response.created' || parsed.type === 'response.done') {
            forwardLog(`event: ${parsed.type}`);
          }
        }
      }
      utteranceTracker.observe(parsed);
      approvalAudioGate.observe(parsed);
      if (parsed.type === 'input_audio_buffer.speech_started') {
        interruptNativeReviews();
      }
      if (parsed.type === 'response.done' && opts.transport !== 'codex-oauth') {
        const response = parsed['response'];
        if (response && typeof response === 'object') {
          reportUsage((response as Record<string, unknown>)['usage'], opts.model, meterSessionId);
          void handleFunctionCalls(response as Record<string, unknown>);
        }
      }
      try { opts.onEvent?.(parsed); } catch { /* */ }
    };

    // 4. Offer (non-trickle — OpenAI's calls endpoint handles ICE server-side).
    let offerSdp = '';
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      offerSdp = pc.localDescription?.sdp || offer.sdp || '';
    } catch (e) {
      return fail(`Could not create offer: ${(e as Error)?.message || String(e)}`);
    }
    if (!offerSdp.trim()) return fail('Empty SDP offer.');
    if (aborted) return teardown();

    // 5. Exchange the offer for OpenAI's answer through our server proxy.
    let answerSdp = '';
    if (opts.transport === 'codex-oauth') {
      try {
        codexSession = await startCodexBrowserRealtimeSession({
          sdp: offerSdp,
          voice: opts.voice,
          model: opts.model,
          prompt: opts.instructions,
          onEvent: opts.onEvent,
          onError: (message) => fail(message),
        });
        if (codexSession.mode === 'text') {
          await teardownMedia();
          setStatus('live', codexSession.fallbackReason || 'text fallback');
          return;
        }
        if (!codexSession.answerSdp) {
          return fail('Codex realtime returned no SDP answer.');
        }
        answerSdp = codexSession.answerSdp;
      } catch (e) {
        return fail(`Codex signaling failed: ${(e as Error)?.message || String(e)}`);
      }
    } else {
      try {
        const r = await fetch('/api/voice/realtime/sdp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sdp: offerSdp, voice: opts.voice, model: opts.model }),
        });
        const d = await r.json().catch(() => null) as { ok?: boolean; sdp?: string; reason?: string } | null;
        if (!r.ok || !d?.ok || !d?.sdp) {
          return fail(d?.reason || `SDP exchange failed (${r.status}).`);
        }
        answerSdp = d.sdp;
      } catch (e) {
        return fail(`Signaling failed: ${(e as Error)?.message || String(e)}`);
      }
    }
    if (aborted) return teardown();

    // 6. Apply the answer — media starts flowing once ICE connects.
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (e) {
      return fail(`Could not apply answer: ${(e as Error)?.message || String(e)}`);
    }
    if (aborted) return teardown();

    setStatus('live', 'say something');
  })();

  return handle;
}
