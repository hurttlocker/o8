'use client';

/**
 * RealtimeVoiceHost — global voice-to-voice (realtime) toggle + live indicator.
 *
 * Double-tap Right ⌘ (detected in src-tauri/src/fn_hotkey.rs) emits the Tauri
 * event `o8:realtime-toggle`; this host — mounted once in the dashboard — flips
 * the gpt-realtime session on/off, shows a small "voice live" pill up top, and
 * auto-stops after ~20s of no speech so an idle session never burns tokens.
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

/** Auto-stop after this long with no speech (user or model) — token guardrail. */
const IDLE_MS = 20_000;

/** Realtime event types that mean "someone is still talking" → reset idle clock. */
const SPEECH_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
  'response.audio.delta',
  'response.output_audio.delta',
]);

export function RealtimeVoiceHost() {
  const sessionRef = useRef<RealtimeSessionHandle | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('idle');

  const clearIdle = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    clearIdle();
    void sessionRef.current?.stop();
    sessionRef.current = null;
  }, [clearIdle]);

  const armIdle = useCallback(() => {
    clearIdle();
    idleTimerRef.current = setTimeout(() => {
      console.log(`${LOG} idle ${IDLE_MS / 1000}s with no speech — auto-stopping`);
      stop();
    }, IDLE_MS);
  }, [clearIdle, stop]);

  const start = useCallback(() => {
    if (sessionRef.current) return;
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
        if (SPEECH_EVENTS.has(t)) armIdle();
      },
      onError: (msg) => console.warn(`${LOG} error: ${msg}`),
    });
    // Start the idle clock immediately — a session opened but never spoken to
    // still auto-closes after IDLE_MS.
    armIdle();
  }, [armIdle]);

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

  // Tear the session down if the host ever unmounts (hot reload, route change).
  useEffect(() => () => stop(), [stop]);

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
