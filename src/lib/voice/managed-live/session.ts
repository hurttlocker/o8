import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
/** Browser transport. The backend owns reasoning, approvals, tools and history. */
export type LiveState = 'idle' | 'connecting' | 'live' | 'closing' | 'closed' | 'unknown' | 'error';
export type LiveEvent = Record<string, unknown>;
export interface LiveBackend {
  /** Immutable identity, including conversation, repository and runtime. */
  binding: string;
  ready?: () => Promise<void>;
  context: () => string;
  /** Must use the existing conversation entry point; must not spawn a new worker. */
  delegate: (text: string, id: string, update: (text: string, spoken?: boolean) => Promise<void>) => Promise<void>;
}
export interface LiveSession {
  close: () => Promise<void>;
  activity: () => void;
  readonly state: LiveState;
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

export async function startManagedLive(backend: LiveBackend, onState: (state: LiveState, detail?: string) => void, signal?: AbortSignal): Promise<LiveSession> {
  let state: LiveState = 'connecting';
  let cleaned = false;
  let pollingStarted = false;
  let id = '';
  let cursor = 0;
  let lastActivity = Date.now();
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
  const activity = () => { lastActivity = Date.now(); };
  const request = async (body: Record<string, unknown>) => {
    const response = await fetch('/api/voice/live', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` },
      body: JSON.stringify({ ...body, binding: backend.binding, ...(id ? { id } : {}) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Voice request failed');
    return data;
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true; signal?.removeEventListener('abort', abort);
    clearTimeout(pollTimer); clearTimeout(closeTimer); clearInterval(idleTimer);
    window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity);
    stream?.getTracks().forEach(track => track.stop()); peer.close(); audio.pause(); audio.srcObject = null;
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
  const update = async (delegationId: string, text: string, spoken = true) => {
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
        if (entry.event.type === 'session.closed') { transition('closed'); cleanup(); return; }
        if (entry.event.type === 'o8.transport.unknown') { transition('unknown', 'Voice disconnected; backend work is unchanged.'); cleanup(); return; }
        const task = transcript.observe(entry.event);
        if (task && state === 'live') {
          if (!task.text.trim()) { void update(task.id, 'I could not reliably capture that request. Please repeat it.').catch(() => {}); continue; }
          // Never await the worker in the transport loop: speech/close/steering keep flowing.
          void backend.delegate(task.text, task.id, (text, spoken) => update(task.id, text, spoken))
            .catch(() => update(task.id, 'The backend did not confirm completion. Check the conversation before retrying.')).catch(() => {});
        }
      }
      if (state === 'live' || state === 'closing') pollTimer = setTimeout(() => { void poll(); }, 250);
    } catch { if (state !== 'closed') { transition('unknown', 'Voice connection lost. Backend work may still be running.'); cleanup(); } }
  }
  try {
    transition('connecting');
    await backend.ready?.();
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    stream.getTracks().forEach(track => peer.addTrack(track, stream!));
    const analysers: AnalyserNode[] = [];
    // Audio level (input AND actual output) is authoritative for idle detection.
    // Transcript gaps and backend waiting do not keep the paid session alive.
    audioContext = new AudioContext();
    const watch = (source: MediaStream) => {
      const analyser = audioContext!.createAnalyser(); analyser.fftSize = 256;
      audioContext!.createMediaStreamSource(source).connect(analyser); analysers.push(analyser);
    };
    watch(stream);
    peer.ontrack = event => { if (cleaned) return; const remote = event.streams[0]; if (remote) { audio.srcObject = remote; watch(remote); void audio.play().catch(() => { void close(); }); } };
    peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') void close(); };
    peer.createDataChannel('oai-events'); // Provider channel is restricted; controls use the sideband.
    await peer.setLocalDescription(await peer.createOffer());
    signal?.throwIfAborted();
    if (cleaned || closePromise) throw new Error('Voice startup was cancelled.');
    const result = await request({ action: 'start', context: backend.context().slice(-8000), sdp: peer.localDescription?.sdp });
    id = result.id;
    if (cleaned || closePromise) {
      void request({ action: 'close' }).catch(() => {});
      startPolling();
      return { close, activity, get state() { return state; } };
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) void close();
    await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
    if (cleaned) return { close, activity, get state() { return state; } };
    if (!closePromise && !signal?.aborted) transition('live');
    activity();
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    idleTimer = setInterval(() => {
      for (const analyser of analysers) {
        const values = new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(values);
        if (values.some(value => Math.abs(value - 128) > 5)) activity();
      }
      if (state === 'live' && Date.now() - lastActivity >= 60_000) void close();
    }, 200);
    startPolling();
    if (signal?.aborted) await close();
    return { close, activity, get state() { return state; } };
  } catch (error) {
    if (id) { void request({ action: 'close' }).catch(() => {}); }
    transition(id ? 'unknown' : 'error', error instanceof Error ? error.message : 'Could not connect voice');
    cleanup(); throw error;
  }
}
