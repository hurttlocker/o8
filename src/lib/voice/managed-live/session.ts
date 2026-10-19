import type { LiveUpdate } from './conversation-bridge';
import { LiveActivity, type LiveActivityUsage } from './activity';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
/** Browser transport. The backend owns reasoning, approvals, tools and history. */
export type LiveState = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'unknown' | 'error';
export type LiveEvent = Record<string, unknown>;
export interface LiveBackend {
  /** Immutable identity, including conversation, repository and runtime. */
  binding: string;
  ready?: () => Promise<void>;
  context: () => string;
  subscribe?: (listener: LiveUpdate) => () => void;
  /** Must use the existing conversation entry point; must not spawn a new worker. */
  delegate: (text: string, id: string, update: (text: string, spoken?: boolean) => Promise<void>) => Promise<void>;
}
export interface LiveSession {
  close: () => Promise<void>;
  activity: () => void;
  readonly state: LiveState;
  readonly usage: LiveActivityUsage;
}
export class LiveTranscript {
  private fragments: Array<{ text: string; start: number; end: number }> = [];
  private seen = new Set<string>();
  private delegated = new Set<string>();
  observe(event: LiveEvent): { id: string; text: string } | null {
    if (typeof event.event_id !== 'string' || this.seen.has(event.event_id)) return null;
    this.seen.add(event.event_id);
    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string'
      && typeof event.start_ms === 'number' && typeof event.end_ms === 'number') {
      this.fragments.push({ text: event.delta, start: event.start_ms, end: event.end_ms });
    }
    if (event.type !== 'session.delegation.created') return null;
    const d = event.delegation as { id?: string; target?: string } | undefined;
    if (!d?.id || d.target !== 'client' || this.delegated.has(d.id)) return null;
    this.delegated.add(d.id);
    const offset = typeof event.offset_ms === 'number' ? event.offset_ms : Infinity;
    const ready = this.fragments.filter(f => f.end <= offset);
    this.fragments = this.fragments.filter(f => f.end > offset);
    return { id: d.id, text: ready.map(f => f.text).join('') };
  }
}

export async function startManagedLive(backend: LiveBackend, onState: (state: LiveState, detail?: string) => void, signal?: AbortSignal, options?: { idleTimeoutMs?: number; onLevel?: (level: number) => void }): Promise<LiveSession> {
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
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const transition = (next: LiveState, detail?: string) => {
    if (state === 'closed' || (cleaned && next !== 'closed')) return;
    state = next; onState(next, detail);
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
        if (entry.event.type === 'session.closed') { transition('closed', idleClosed ? 'Voice paused after inactivity. Resume when ready; backend work continues. Delayed speech detection can also cause a pause.' : undefined); cleanup(); return; }
        if (entry.event.type === 'o8.transport.unknown') { transition('unknown', 'Voice disconnected; backend work is unchanged.'); cleanup(); return; }
        const task = transcript.observe(entry.event);
        if (task && state === 'live') {
          if (!task.text.trim()) { void update(task.id, 'I could not reliably capture that request. Please repeat it.').catch(() => {}); continue; }
          // Never await the worker in the transport loop: speech/close/steering keep flowing.
          void backend.delegate(task.text, task.id, (text, spoken) => update(task.id, text, spoken))
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
    peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') void close(); };
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
    if (cleaned || closePromise) {
      if (!cleaned) void request({ action: 'close' }).catch(() => {});
      startPolling();
      return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) void close();
    await startupStep(peer.setRemoteDescription({ type: 'answer', sdp: result.sdp }));
    clearTimeout(startupTimer);
    if (cleaned) return { close, activity, get state() { return state; }, get usage() { return activityPolicy.usage; } };
    if (!closePromise && !signal?.aborted) { activityPolicy.markReady(Date.now()); transition('live');
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
    if (id) { void request({ action: 'close' }).catch(() => {}); }
    transition(id || startRequested ? 'unknown' : 'error', error instanceof Error ? error.message : 'Could not connect voice');
    cleanup(); throw error;
  }
}
