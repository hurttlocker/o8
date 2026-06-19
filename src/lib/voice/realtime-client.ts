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

const DEFAULT_INSTRUCTIONS =
  "You are Symon, the voice of o8 — the operator's desktop command surface. " +
  'Speak naturally and concisely, like a sharp teammate who is easy to talk to; ' +
  'keep replies short since they are spoken aloud. ' +
  'You can act on the operator’s machine through tools. Before you run a tool that ' +
  'changes something — dispatching agents, sending mail, running commands, editing ' +
  'files — say in one short sentence what you are about to do; some actions pop an ' +
  'approval card the operator taps to allow, so your heads-up tells them why. ' +
  'Read-only lookups — status, lists, "what\'s running", asking the Brain — just do, ' +
  'then answer. ' +
  'You are the CONDUCTOR, not the whole orchestra — route each request to whoever does ' +
  'it best, then narrate. Do simple things yourself: status, lists, what is running, ' +
  'weather, music, volume, opening a surface, a quick Brain question. For anything DEEP ' +
  'or multi-step — writing or changing code, figuring something out, showing or ' +
  'rendering something on the operator screen, work that needs several tools — hand it ' +
  'to the live agent with o8_delegate and narrate what is happening while it works, ' +
  'rather than doing that heavy lifting yourself. Use o8_dispatch when they want a ' +
  'separate tracked coding worker in a worktree; use o8_delegate when they want the ' +
  'agent to act live, right now. ' +
  'Never read long tool output back verbatim; summarize the part that ' +
  'answers the question. When something is ambiguous, ask one short question instead ' +
  'of guessing.';

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
  let toolDefs: Array<Record<string, unknown>> = [];

  const setStatus = (s: RealtimeStatus, detail?: string) => {
    status = s;
    console.log(`${LOG} status → ${s}${detail ? `: ${detail}` : ''}`);
    forwardLog(`status → ${s}${detail ? `: ${detail}` : ''}`);
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
      if (mod) {
        try { result = await mod.invoke('realtime_invoke_tool', { name, args }); }
        catch (e) { result = { error: (e as Error)?.message || String(e) }; }
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
      console.log(`${LOG} data channel open — sending session.update`);
      const update: Record<string, unknown> = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: opts.instructions || DEFAULT_INSTRUCTIONS,
          audio: {
            input: { transcription: { model: 'whisper-1' } },
            output: { voice: opts.voice || 'marin' },
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
        } else console.log(`${LOG} event: ${parsed.type}`);
      }
      if (parsed.type === 'response.done') {
        const response = parsed['response'];
        if (response && typeof response === 'object') {
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
