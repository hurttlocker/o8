'use client';

/**
 * /dictation-pill — the SCREEN-LEVEL dock pill (system-wide Symon fold P3).
 *
 * This route is the body of a SECOND, always-on-top, transparent Tauri window
 * labeled `dock` (NEVER `main` — see the label-discipline note in
 * `docs/symon-systemwide-fold.md`). The Rust side creates that window after the
 * bundled Next server is confirmed up, navigates it here, and applies the
 * top-center / level-25 / clearColor / nonactivating recipe. This page only
 * has to:
 *
 *   1. Subscribe to `o8:stt-event` (same payload shape as `useNativeDictation`)
 *      and reduce it into a `DictationSnapshot`.
 *   2. Filter to SYSTEM-origin sessions only (`origin === 'system'`), so the
 *      global-Fn pill never mirrors an in-window mic session and vice-versa.
 *      The broadcast `o8:stt-event` reaches BOTH windows — the discriminator is
 *      what keeps them from double-rendering.
 *   3. Render the SAME pill VISUALS as the in-window HUD via the shared
 *      `DictationPillView`, CENTERED in the window (the WINDOW provides the
 *      position — no `createPortal`, no fixed-bottom anchor).
 *
 * The dock window is ALWAYS-ON: Rust creates it visible at boot and never hides
 * it on the normal flow. This route therefore ALWAYS paints — at minimum the
 * compact Symon idle capsule (`persistentIdle`) — and MORPHS idle → recording
 * (`system-start`) → polishing → success → idle. A discarded Fn brush or a
 * start error emits `system-idle` to morph back to the idle capsule.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';
import { DictationPillView } from '@/components/desktop/dictation/DictationPill';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';

export const dynamic = 'force-dynamic';

const SUCCESS_FLASH_MS = 900;
const ERROR_FLASH_MS = 2500;

const IDLE_SNAPSHOT: DictationSnapshot = {
  state: 'idle',
  audioLevel: 0,
  durationMs: 0,
  error: null,
  partialTranscript: '',
};

interface SttEventPayload {
  type:
    | 'ready'
    | 'system-start'
    | 'system-idle'
    | 'partial'
    | 'final'
    | 'level'
    | 'audio_file'
    | 'status'
    | 'error'
    | 'complete'
    | 'polished'
    | 'system-pasted';
  /** Origin discriminator (system-wide Symon fold P3 review HIGH). Only the
   * dock window reacts to `system`; the in-window pill reacts to the rest. */
  origin?: 'system' | 'in-window';
  sessionId?: number;
  text?: string;
  level?: number;
  chars?: number;
}

export default function DictationPillPage() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(IDLE_SNAPSHOT);

  const stateRef = useRef<DictationState>('idle');
  const startTimeRef = useRef<number>(0);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const setState = useCallback((next: DictationState, patch?: Partial<DictationSnapshot>) => {
    stateRef.current = next;
    setSnapshot((prev) => ({ ...prev, ...patch, state: next }));
  }, []);

  const returnToIdleAfter = useCallback((ms: number) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => {
      flashTimerRef.current = null;
      stateRef.current = 'idle';
      setSnapshot(IDLE_SNAPSHOT);
    }, ms);
  }, []);

  const beginRecording = useCallback(() => {
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    startTimeRef.current = Date.now();
    stateRef.current = 'recording';
    setSnapshot({ state: 'recording', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
  }, []);

  const handleEvent = useCallback((payload: SttEventPayload) => {
    // ── Origin discriminator ──
    // Only react to SYSTEM-origin sessions. `o8:stt-event` is broadcast to all
    // windows; the in-window DictationHost handles `in-window` (and unmarked
    // legacy) sessions. `system-pasted` is system by construction even if the
    // origin field is absent, so we accept it unconditionally.
    if (payload.type !== 'system-pasted' && payload.origin !== 'system') {
      return;
    }

    switch (payload.type) {
      case 'system-start':
        beginRecording();
        break;
      case 'system-idle':
        // Brush discarded / start error — morph the always-on dock back to its
        // idle capsule (the window is never hidden). Clear any pending flash.
        if (flashTimerRef.current) {
          clearTimeout(flashTimerRef.current);
          flashTimerRef.current = null;
        }
        stateRef.current = 'idle';
        setSnapshot(IDLE_SNAPSHOT);
        break;
      case 'ready':
        // Fn-down can race the daemon's `ready`; treat it as a start signal if
        // we somehow missed `system-start` (defensive — system-start is primary).
        if (stateRef.current === 'idle') beginRecording();
        break;
      case 'level':
        if (stateRef.current === 'recording' && typeof payload.level === 'number') {
          const level = Math.min(1, payload.level);
          const duration = Date.now() - startTimeRef.current;
          setSnapshot((prev) => (prev.state === 'recording'
            ? { ...prev, audioLevel: level, durationMs: duration }
            : prev));
        }
        break;
      case 'partial':
        if (stateRef.current === 'recording' && typeof payload.text === 'string') {
          setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== payload.text
            ? { ...prev, partialTranscript: payload.text ?? '' }
            : prev));
        }
        break;
      case 'final':
        if (stateRef.current === 'recording') setState('transcribing');
        break;
      case 'audio_file':
        if (stateRef.current === 'transcribing') setState('polishing');
        break;
      case 'system-pasted':
        // Paste landed in the focused app — brief "Pasted" flash, then idle.
        setState('success', { audioLevel: 0 });
        returnToIdleAfter(SUCCESS_FLASH_MS);
        break;
      case 'error':
        if (
          stateRef.current === 'recording'
          || stateRef.current === 'transcribing'
          || stateRef.current === 'polishing'
        ) {
          stateRef.current = 'error';
          setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: payload.text ?? 'Dictation failed', partialTranscript: '' });
          returnToIdleAfter(ERROR_FLASH_MS);
        }
        break;
      default:
        break;
    }
  }, [beginRecording, returnToIdleAfter, setState]);

  // Subscribe to the broadcast STT event stream.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    import('@tauri-apps/api/event')
      .then(({ listen }) => listen<SttEventPayload>('o8:stt-event', (e) => handleEvent(e.payload)))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
      })
      .catch((err) => {
        console.warn('[dock-pill] failed to subscribe to o8:stt-event', err);
      });
    return () => {
      disposed = true;
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch { /* noop */ }
        unlistenRef.current = null;
      }
    };
  }, [handleEvent]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // The dock window is transparent at the OS level (clearColor + setOpaque
  // false). The page's html/body must NOT paint a background or the window
  // shows a solid rectangle instead of just the pill. globals.css / the root
  // layout set #1C1C1E; override to transparent for this surface only.
  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: 10,
        background: 'transparent',
        // The React layer keeps the dead-zone tight: the wrapper ignores
        // pointer events, only the pill itself (hideCancel = no buttons) sits
        // on top. set_ignore_cursor_events stays FALSE on the Rust side.
        pointerEvents: 'none',
      }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <DictationPillView snapshot={snapshot} onCancel={() => {}} hideCancel persistentIdle />
      </div>
    </div>
  );
}
