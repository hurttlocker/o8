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

export type RealtimeStatus =
  | 'idle'
  | 'requesting-mic'
  | 'connecting'
  | 'live'
  | 'stopping'
  | 'error';

export interface RealtimeSessionHandle {
  stop: () => Promise<void>;
  readonly status: RealtimeStatus;
}

export interface StartRealtimeOptions {
  /** OpenAI realtime voice (marin, alloy, echo, shimmer, cedar, …). */
  voice?: string;
  /** System prompt / persona for Symon. */
  instructions?: string;
  /** Override the realtime model. */
  model?: string;
  onStatus?: (status: RealtimeStatus, detail?: string) => void;
  /** Raw 'oai-events' messages (transcripts, response.done, function_call — P4 hook). */
  onEvent?: (event: Record<string, unknown>) => void;
  onError?: (message: string) => void;
}

const LOG = '[realtime]';

const DEFAULT_INSTRUCTIONS =
  "You are Symon, the voice of o8 — the operator's desktop command surface. " +
  'Speak naturally and concisely, like a sharp teammate who is easy to talk to. ' +
  'You can see and act on the operator’s machine through tools, but never take a ' +
  'destructive or irreversible action without a clear spoken confirmation. When ' +
  'something is ambiguous, ask a short question instead of guessing.';

/**
 * Start a live realtime voice session. Returns a handle immediately (status
 * flips through requesting-mic → connecting → live); call `stop()` any time to
 * abort mid-connect or end a live session. All teardown is idempotent.
 */
export function startRealtimeSession(opts: StartRealtimeOptions = {}): RealtimeSessionHandle {
  let status: RealtimeStatus = 'idle';
  let aborted = false;
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;

  const setStatus = (s: RealtimeStatus, detail?: string) => {
    status = s;
    console.log(`${LOG} status → ${s}${detail ? `: ${detail}` : ''}`);
    try { opts.onStatus?.(s, detail); } catch { /* listener threw — ignore */ }
  };

  const teardown = async () => {
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

  const fail = (msg: string) => {
    console.error(`${LOG} error: ${msg}`);
    setStatus('error', msg);
    try { opts.onError?.(msg); } catch { /* */ }
    void teardown();
  };

  const handle: RealtimeSessionHandle = {
    get status() { return status; },
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
      console.log(`${LOG} data channel open — sending session.update`);
      const update = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: opts.instructions || DEFAULT_INSTRUCTIONS,
          audio: {
            input: { transcription: { model: 'whisper-1' } },
            output: { voice: opts.voice || 'marin' },
          },
        },
      };
      try { dc!.send(JSON.stringify(update)); }
      catch (e) { console.warn(`${LOG} session.update send failed:`, e); }
    };
    dc.onmessage = (ev) => {
      let parsed: Record<string, unknown> | null = null;
      try { parsed = JSON.parse(ev.data as string); } catch { return; }
      if (!parsed) return;
      if (typeof parsed.type === 'string') {
        // Surface errors loudly; everything else is fine at log level.
        if (parsed.type === 'error') console.error(`${LOG} oai error:`, parsed);
        else console.log(`${LOG} event: ${parsed.type}`);
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
