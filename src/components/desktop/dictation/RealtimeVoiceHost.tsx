'use client';

/**
 * RealtimeVoiceHost — global voice-to-voice (realtime) toggle + live indicator.
 *
 * Double-tap Right ⌘ (detected in src-tauri/src/fn_hotkey.rs) emits the Tauri
 * event `o8:realtime-toggle`; this host — mounted once in the dashboard — flips
 * the gpt-realtime session on/off, shows a small "voice live" pill up top, and
 * auto-stops after ~90s of no speech so an idle session never burns tokens.
 *
 * The session itself lives in `@/lib/voice/realtime-client` (WebRTC in the
 * webview). Inline styles only; themed via var(--t-*). Self-contained — no props.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { isTauri } from '@/lib/tauri/bridge';
import {
  startRealtimeSession,
  type RealtimeSessionHandle,
  type RealtimeStatus,
} from '@/lib/voice/realtime-client';

const LOG = '[realtime-host]';

/**
 * Auto-stop after this long with no activity — token guardrail. Counts only
 * during USER silence between turns (the model's whole turn is suspended in
 * onEvent), so this is "how long a quiet operator keeps the line open." 90s is
 * comfortable for thinking/observing without dropping; raise if it ever feels
 * abrupt, lower to trim idle spend.
 */
const IDLE_MS = 90_000;

/**
 * USER-side activity that resets the idle clock. The MODEL's turn is handled
 * separately in onEvent via the response.* lifecycle — crucially NOT via
 * `*.audio.delta`: in WebRTC the model's audio rides the RTP media track, so
 * those byte-delta events never arrive on the data channel. Keying the idle
 * reset off them (as we used to) let the 20s timer fire mid-answer and cut a
 * long spoken response off. See the onEvent handler below.
 */
const SPEECH_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
]);

/**
 * "Open canvas" does a FULL-PAGE navigation (window.location.assign to
 * /preview/canvas-glass — the SPA bridge can't reliably cross that segment, so
 * the hard reload stays). A WebRTC session can't survive a document reload, and
 * — the part that bit 0.1.426 — React effect CLEANUPS DON'T RUN on
 * window.location.assign (the browser unloads the document before React commits),
 * so the resume marker can't be stamped on unmount. Instead a HEARTBEAT writes a
 * fresh marker to localStorage every few seconds while live; the destination
 * route (which also mounts this host) reads it on mount and auto-resumes if it's
 * recent. localStorage, not sessionStorage, so it's bulletproof across the hard
 * reload; the TTL gates a stale marker (e.g. after a crash). One ~2s reconnect
 * entering the canvas, then every canvas tool runs without dropping the line. A
 * NEW session (no prior conversation memory) — acceptable for the hop; seamless
 * same-session survival would need the reliable SPA nav this route lacks.
 */
const HANDOFF_KEY = 'o8:realtime-handoff';
const HANDOFF_TTL_MS = 12_000;
const HANDOFF_HEARTBEAT_MS = 2_500;

function writeHandoff() {
  try { localStorage.setItem(HANDOFF_KEY, String(Date.now())); } catch { /* no localStorage */ }
}
function clearHandoff() {
  try { localStorage.removeItem(HANDOFF_KEY); } catch { /* no localStorage */ }
}

export function RealtimeVoiceHost() {
  const sessionRef = useRef<RealtimeSessionHandle | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between response.created and response.done — i.e. while Symon is
  // mid-answer. The idle clock is HARD-OFF for the whole window so no
  // intermediate event can re-arm it and cut a long reply short.
  const respondingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('idle');

  const clearIdle = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  // INTENTIONAL end (toggle-off / idle-auto-off): stop the session + heartbeat
  // AND clear the resume marker so the next route does NOT auto-resume. A
  // full-page canvas nav never reaches here (the browser unloads the page), so
  // the heartbeat's fresh marker survives and the destination resumes.
  const stop = useCallback(() => {
    clearIdle();
    clearHeartbeat();
    clearHandoff();
    respondingRef.current = false;
    void sessionRef.current?.stop();
    sessionRef.current = null;
  }, [clearIdle, clearHeartbeat]);

  const armIdle = useCallback(() => {
    clearIdle();
    idleTimerRef.current = setTimeout(() => {
      console.log(`${LOG} idle ${IDLE_MS / 1000}s with no speech — auto-stopping`);
      stop();
    }, IDLE_MS);
  }, [clearIdle, stop]);

  const start = useCallback(() => {
    if (sessionRef.current) return;
    respondingRef.current = false;
    let voice = 'marin';
    try {
      voice = localStorage.getItem('o8:realtime-voice') || 'marin';
    } catch {
      /* no localStorage in this context */
    }
    console.log(`${LOG} starting realtime voice (voice=${voice})`);
    sessionRef.current = startRealtimeSession({
      voice,
      onStatus: (s) => setStatus(s),
      onEvent: (e) => {
        const t = typeof e.type === 'string' ? e.type : '';
        // HARD-GATE the idle clock on a responding flag. We must NOT lean on
        // intermediate response.*/transcript-delta events to keep re-arming it:
        // in WebRTC the audio rides the media track and the data channel can go
        // silent for the whole spoken answer, so the timer would fire mid-reply
        // (the 0.1.423 bug). Instead: OFF for the entire model turn
        // (response.created → response.done), then re-armed once when the turn
        // ends. A tool call mints a fresh response.created after response.done,
        // so tool→speak chains stay suspended too.
        if (t === 'response.created') {
          respondingRef.current = true;
          clearIdle();
        } else if (t === 'response.done') {
          respondingRef.current = false;
          armIdle();
        } else if (!respondingRef.current && SPEECH_EVENTS.has(t)) {
          // User activity between turns → keep the line open.
          armIdle();
        }
      },
      onError: (msg) => console.warn(`${LOG} error: ${msg}`),
    });
    // Resume marker: write it now + keep it fresh on a heartbeat, so a full-page
    // canvas nav (which skips React cleanup) always leaves a recent marker for
    // the destination route to auto-resume from.
    writeHandoff();
    clearHeartbeat();
    heartbeatRef.current = setInterval(writeHandoff, HANDOFF_HEARTBEAT_MS);
    // Start the idle clock immediately — a session opened but never spoken to
    // still auto-closes after IDLE_MS.
    armIdle();
  }, [armIdle, clearIdle, clearHeartbeat]);

  const toggle = useCallback(() => {
    if (sessionRef.current) {
      console.log(`${LOG} toggle → off`);
      stop();
    } else {
      console.log(`${LOG} toggle → on`);
      start();
    }
  }, [start, stop]);

  // Right-⌘ double-tap → `o8:realtime-toggle` (emitted from fn_hotkey.rs).
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let alive = true;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('o8:realtime-toggle', () => toggle()))
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch((e) => console.warn(`${LOG} listen failed`, e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [toggle]);

  // On a React-driven unmount, LIGHT teardown only — stop the session + timers
  // but do NOT clear the resume marker (this unmount may be a navigation; the
  // destination route should resume). Intentional ends go through stop(), which
  // clears the marker. (A full-page canvas nav doesn't reach here at all — the
  // browser unloads the document before React runs cleanups, which is exactly
  // why the marker is a localStorage heartbeat, not stamped here.)
  useEffect(() => () => {
    void sessionRef.current?.stop();
    sessionRef.current = null;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
  }, []);

  // Pick the session back up if we just arrived from a live one (the canvas-nav
  // heartbeat marker is recent). Runs once per mount. start() re-arms its own
  // heartbeat, so the marker stays fresh for the next hop.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !isTauri()) return;
    resumedRef.current = true;
    let raw: string | null = null;
    try { raw = localStorage.getItem(HANDOFF_KEY); } catch { /* no localStorage */ }
    if (!raw) return;
    const ts = Number(raw);
    if (Number.isFinite(ts) && Date.now() - ts < HANDOFF_TTL_MS) {
      console.log(`${LOG} resuming voice after canvas-nav handoff`);
      start();
    } else {
      clearHandoff(); // stale marker (old session / crash) — drop it
    }
  }, [start]);

  // Auto-clear the transient error pill after a few seconds.
  useEffect(() => {
    if (status !== 'error') return;
    const t = setTimeout(() => setStatus('idle'), 3500);
    return () => clearTimeout(t);
  }, [status]);

  const connecting = status === 'requesting-mic' || status === 'connecting';
  const visible = connecting || status === 'live' || status === 'error';
  const dotColor = status === 'error' ? '#ef4444' : status === 'live' ? '#34d399' : '#f59e0b';
  const label = status === 'error' ? 'Voice unavailable' : connecting ? 'Connecting…' : 'Voice live';

  // A fixed, full-width, click-through container handles centering so the pill's
  // own framer transform (y/scale) never fights a translateX centering hack.
  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        zIndex: 2147483646,
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {visible && (
          <motion.button
            type="button"
            onClick={() => stop()}
            title="Voice-to-voice is on — double-tap right ⌘ or click to stop"
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 12,
              paddingRight: 14,
              borderRadius: 999,
              border: '1px solid var(--t-border)',
              background: 'var(--t-bg-card)',
              backdropFilter: 'blur(18px) saturate(1.05)',
              WebkitBackdropFilter: 'blur(18px) saturate(1.05)',
              boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
              color: 'var(--t-text)',
              fontSize: 12.5,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              cursor: 'pointer',
            }}
          >
            <motion.span
              animate={status === 'live' ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
              transition={
                status === 'live'
                  ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' }
                  : { duration: 0.2 }
              }
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: dotColor,
                boxShadow: `0 0 8px ${dotColor}`,
                flexShrink: 0,
              }}
            />
            <span>{label}</span>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
