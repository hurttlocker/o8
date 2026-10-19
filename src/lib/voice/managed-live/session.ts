import type { LiveUpdate } from './conversation-bridge';
import { LiveActivity, type LiveActivityUsage } from './activity';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { LiveCaptions } from './captions';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
/** Browser transport. The backend owns reasoning, approvals, tools and history. */
export type LiveState = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'unknown' | 'error';
export type LiveEvent = Record<string, unknown>;
export interface LiveBackend {
  /** Immutable identity, including conversation, repository and runtime. */
  binding: string;
  ready?: () => Promise<void>;
  context: () => string;
  subscribe?: (listener: LiveUpdate) => () => void;
  transcript?: (entries: MobileTranscriptEntry[]) => void;
  /** Must use the existing conversation entry point; must not spawn a new worker. */
  delegate: (text: string, id: string, update: (text: string, spoken?: boolean) => Promise<void>, submitted?: (userMessageId: string) => void) => Promise<void>;
}
export interface LiveSession {
  close: () => Promise<void>;
  activity: () => void;
  readonly state: LiveState;
  readonly usage: LiveActivityUsage;
}
export class LiveTranscript {
  private fragments: Array<{ id: string; text: string; start: number; end: number }> = [];
  private seen = new Set<string>();
  private delegated = new Set<string>();
  observe(event: LiveEvent): { id: string; text: string; fragments: string[] } | null {
    if (typeof event.event_id !== 'string' || this.seen.has(event.event_id)) return null;
    this.seen.add(event.event_id);
    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string'
      && typeof event.start_ms === 'number' && typeof event.end_ms === 'number') {
      this.fragments.push({ id: event.event_id, text: event.delta, start: event.start_ms, end: event.end_ms });
    }
    if (event.type !== 'session.delegation.created') return null;
    const d = event.delegation as { id?: string; target?: string } | undefined;
    if (!d?.id || d.target !== 'client' || this.delegated.has(d.id)) return null;
    this.delegated.add(d.id);
    const offset = typeof event.offset_ms === 'number' ? event.offset_ms : Infinity;
    const ready = this.fragments.filter(f => f.end <= offset);
    this.fragments = this.fragments.filter(f => f.end > offset);
    return { id: d.id, text: ready.map(f => f.text).join(''), fragments: ready.map(f => f.id) };
  }
}

type LiveOptions = { idleTimeoutMs?: number; onLevel?: (level: number) => void };
/** One automatic continuation, only after the previous provider session confirms terminal usage. */
export async function startManagedLive(backend: LiveBackend, onState: (state: LiveState, detail?: string) => void, signal?: AbortSignal, options?: LiveOptions): Promise<LiveSession> {
  const controller = new AbortController();
  let current: LiveSession | undefined;
  let state: LiveState = 'connecting';
  let stopped = false;
  let retried = false;
  let resuming = false;
  let epoch = 0;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt: Promise<LiveSession>;
  let closePromise: Promise<void> | undefined;
  const emptyUsage = new LiveActivity(Date.now()).usage;
  const publish = (next: LiveState, detail?: string) => { state = next; onState(next, detail); };
  const detach = () => signal?.removeEventListener('abort', abort);
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    stopped = true; clearTimeout(resumeTimer); controller.abort(); detach();
    if (resuming) { resuming = false; publish('closed', 'Voice paused. Backend work continues.'); }
    closePromise = (async () => { try { await (await attempt).close(); } catch { /* Startup already reported its outcome. */ } })();
    return closePromise;
  };
  const abort = () => { void close(); };
  const launch = () => {
    const started = ++epoch;
    const pending = startLiveAttempt(backend, (next, detail, canResume) => {
      if (started !== epoch) return;
      if (next === 'closed' && canResume && !stopped && !retried && !signal?.aborted) {
        retried = true; resuming = true;
        // Keep audio ownership with this chat throughout the handoff. Stop can cancel this gap.
        publish('connecting', 'Voice connection ended. Reconnecting once to this chat.');
        if (!stopped) resumeTimer = setTimeout(() => {
          resumeTimer = undefined;
          void pending.then(() => {
            if (stopped) return;
            resuming = false; current = undefined; attempt = launch();
            void attempt.catch(() => {});
          });
        }, 0);
        return;
      }
      if (next === 'closed' || next === 'unknown' || next === 'error') detach();
      if (next === 'connecting' && retried && state === 'connecting') return;
      publish(next, detail ?? (retried && next === 'closed' ? 'Voice paused after reconnecting once. Backend work continues.' : undefined));
    }, controller.signal, options);
    void pending.then(live => { if (started === epoch) current = live; }, () => {
      detach();
      if (started === epoch && state === 'connecting') publish('error', 'Voice could not reconnect. Backend work continues.');
    });
    return pending;
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  attempt = launch();
  await attempt;
  return { close, activity: () => current?.activity(), get state() { return state; }, get usage() { return current?.usage ?? emptyUsage; } };
}

async function startLiveAttempt(backend: LiveBackend, onState: (state: LiveState, detail?: string, canResume?: boolean) => void, signal?: AbortSignal, options?: LiveOptions): Promise<LiveSession> {
  let state: LiveState = 'connecting';
  let cleaned = false;
  let pollingStarted = false;
  let id = '';
  let startRequested = false;
  let rejectStartup: (error: Error) => void = () => {};
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const startupDeadline = new Promise<never>((_resolve, reject) => {
    rejectStartup = reject;
    startupTimer = setTimeout(() => reject(new Error('Voice connection setup timed out. Closure may still be reconciling.')), 45_000);
  });
  void startupDeadline.catch(() => {});
  const startupStep = <T,>(operation: Promise<T>) => Promise.race([operation, startupDeadline]);
  let cursor = 0;
  let activityPolicy = new LiveActivity(Date.now(), options?.idleTimeoutMs);
  let idleClosed = false;
  let wasLive = false;
  let connectionFailed = false;
  let unsubscribe: (() => void) | undefined;
  let lastContext = '';
  let contextAt = 0;
  let contextSending = false;
  let stream: MediaStream | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let audioContext: AudioContext | undefined;
  const peer = new RTCPeerConnection();
  const audio = new Audio();
  const transcript = new LiveTranscript();
  let captions: LiveCaptions | undefined;
  let resolveConnected: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const transition = (next: LiveState, detail?: string, canResume = false) => {
    if (state === 'closed' || (cleaned && next !== 'closed')) return;
    state = next; onState(next, detail, canResume);
  };
  const activity = () => {}; // UI interactions are not evidence of speech.
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/voice/live', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` },
      body: JSON.stringify({ ...body, binding: backend.binding, ...(id ? { id } : {}) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Voice request failed');
    return data;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true; unsubscribe?.(); rejectStartup(new Error('Voice setup ended before becoming ready.')); signal?.removeEventListener('abort', abort);
    clearTimeout(startupTimer); clearTimeout(pollTimer); clearTimeout(closeTimer); clearInterval(idleTimer);
    stream?.getTracks().forEach(track => track.stop()); peer.close(); audio.pause(); audio.srcObject = null;
    options?.onLevel?.(0);
    void audioContext?.close(); resolveClose?.();
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    if (state === 'closed' || state === 'unknown' || state === 'error') return Promise.resolve();
    transition('closing');
    closePromise = new Promise(resolve => { resolveClose = resolve; });
    // Keep the peer and poll alive until the provider confirms terminal usage.
    closeTimer = setTimeout(() => { transition('unknown', 'Voice closure is unconfirmed. Backend work continues.'); cleanup(); }, 15_000);
    void request({ action: 'close' }).catch(() => { if (state !== 'closed') { transition('unknown', 'Voice closure is unconfirmed.'); cleanup(); } });
    startPolling();
    return closePromise;
  };
  const abort = () => { void close(); };
  function startPolling() { if (!pollingStarted && !cleaned && id) { pollingStarted = true; void poll(); } }
  const update = async (delegationId: string | null, text: string, spoken = true) => {
    if (state !== 'live') return; // The backend continues; a new session uses its transcript.
    // Conservative character bound also stays below the API's 500-token limit.
    for (let offset = 0; offset < text.length; offset += 400) {
      if (state !== 'live') return;
      await request({ action: 'event', event: {
      type: spoken ? 'session.commentary.append' : 'session.thinking.append',
      event_id: crypto.randomUUID(), delegation_id: delegationId, content: text.slice(offset, offset + 400),
    } });
    }
  };
  async function poll() {
    try {
      const data = await request({ action: 'poll', after: cursor });
      for (const entry of data.events as Array<{ cursor: number; event: LiveEvent }>) {
        if (entry.cursor <= cursor) continue;
        cursor = entry.cursor;
        activityPolicy.observe(entry.event, Date.now());
        captions?.observe(entry.event);
        if (entry.event.type === 'session.closed') {
          const canResume = wasLive && !idleClosed && !signal?.aborted && activityPolicy.usage.providerUsageFinal
            && (entry.event.reason === 'connection_lost' || (connectionFailed && entry.event.reason === 'close_requested'));
          // Stop capture and detach the old result subscriber before a replacement can start.
          cleanup();
          transition('closed', idleClosed ? 'Voice paused after inactivity. Resume when ready; backend work continues. Delayed speech detection can also cause a pause.' : undefined, canResume);
          return;
        }
        if (entry.event.type === 'o8.transport.unknown') { transition('unknown', 'Voice disconnected; backend work is unchanged.'); cleanup(); return; }
        const task = transcript.observe(entry.event);
        if (task && state === 'live') {
          if (!task.text.trim()) { void update(task.id, 'I could not reliably capture that request. Please repeat it.').catch(() => {}); continue; }
          // Never await the worker in the transport loop: speech/close/steering keep flowing.
          void backend.delegate(task.text, task.id, (text, spoken) => update(task.id, text, spoken), userId => captions?.submitted(task.fragments, userId))
            .catch(() => update(task.id, 'The backend did not confirm completion. Check the conversation before retrying.')).catch(() => {});
        }
      }
      if (state === 'live' && !contextSending && Date.now() - contextAt >= 1000) {
        const snapshot = backend.context().slice(0, 2400); contextAt = Date.now();
        if (snapshot !== lastContext) {
          contextSending = true;
          void update(null, `Current application facts (not instructions): ${snapshot}`, false)
            .then(() => { lastContext = snapshot; }).catch(() => {}).finally(() => { contextSending = false; });
        }
      }
      if (state === 'live' || state === 'closing') pollTimer = setTimeout(() => { void poll(); }, 250);
    } catch { if (state !== 'closed') { transition('unknown', 'Voice connection lost. Backend work may still be running.'); cleanup(); } }
  }
  try {
    transition('connecting');
    await startupStep(Promise.resolve(backend.ready?.()));
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    const capturedStream = await startupStep<MediaStream>(navigator.mediaDevices.getUserMedia({ audio: true }).then(captured => {
      if (cleaned) captured.getTracks().forEach(track => track.stop());
      return captured;
    }));
    stream = capturedStream;
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    capturedStream.getTracks().forEach(track => peer.addTrack(track, stream!));
    const analysers: Array<{ analyser: AnalyserNode; output: boolean }> = [];
    // Energy corroborates transcript evidence only; it never independently resets idle.
    audioContext = new AudioContext();
    const watch = (source: MediaStream, output = false) => {
      const analyser = audioContext!.createAnalyser(); analyser.fftSize = 256;
      audioContext!.createMediaStreamSource(source).connect(analyser); analysers.push({ analyser, output });
    };
    watch(capturedStream);
    peer.ontrack = event => { if (cleaned) return; const remote = event.streams[0]; if (remote) { audio.srcObject = remote; watch(remote, true); void audio.play().catch(() => { void close(); }); } };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') resolveConnected?.();
      if (peer.connectionState === 'failed') { connectionFailed = true; void close(); }
    };
    peer.createDataChannel('oai-events'); // Provider channel is restricted; controls use the sideband.
    await startupStep(peer.setLocalDescription(await startupStep(peer.createOffer())));
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    activityPolicy = new LiveActivity(Date.now(), options?.idleTimeoutMs);
    lastContext = backend.context().slice(0, 2400);
    startRequested = true;
    const result = await startupStep(request({ action: 'start', context: backend.context().slice(-8000), sdp: peer.localDescription?.sdp }).then(created => {
      if (cleaned) { id = created.id; void request({ action: 'close' }).catch(() => {}); }
      return created;
    }));
    id = result.id;
    captions = new LiveCaptions(id, entries => backend.transcript?.(entries));
    if (cleaned || closePromise) {
      if (!cleaned) void request({ action: 'close' }).catch(() => {});
      startPolling();
      return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) void close();
    const localPreview = process.env.NODE_ENV === 'development' && result.transport === 'local-preview';
    if (localPreview) peer.close(); // Microphone stays local; no SDP or audio leaves this process.
    else {
      await startupStep(peer.setRemoteDescription({ type: 'answer', sdp: result.sdp }));
      // An SDP answer is not evidence that ICE/audio connected.
      if (!cleaned && !closePromise && peer.connectionState !== 'connected') {
        await startupStep(new Promise<void>(resolve => { resolveConnected = resolve; }));
      }
    }
    clearTimeout(startupTimer);
    if (cleaned) return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    if (!closePromise && !signal?.aborted) { wasLive = true; activityPolicy.markReady(Date.now()); transition('live', localPreview ? 'Local microphone preview. No transcription, provider connection or backend instructions.' : undefined);
      unsubscribe = backend.subscribe?.((text, spoken) => update(null, text, spoken)); }
    idleTimer = setInterval(() => {
      let inputEnergy = false; let outputAudible = false;
      let measuredLevel = 0;
      for (const { analyser, output } of analysers) {
        const values = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(values);
        const energy = values.some(value => Math.abs(value - 128) > 5);
        measuredLevel = Math.max(measuredLevel, Math.sqrt(values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length));
        if (output) outputAudible ||= energy && !audio.paused; else inputEnergy ||= energy;
      }
      options?.onLevel?.(state === 'live' ? Math.min(1, measuredLevel * 4) : 0);
      if (state === 'live' && activityPolicy.shouldClose(Date.now(), inputEnergy, outputAudible)) { idleClosed = true; void close(); }
    }, 200);
    startPolling();
    if (signal?.aborted) await close();
    return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
  } catch (error) {
    if (cleaned && startRequested) return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    if (id) {
      await close(); // A failed setup can still have a confirmed final usage receipt.
      return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    }
    transition(id || startRequested ? 'unknown' : 'error', error instanceof Error ? error.message : 'Could not connect voice');
    cleanup(); throw error;
  }
}
