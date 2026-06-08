'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DictationSnapshot, DictationStartOptions, DictationState } from './types';

const SUCCESS_FLASH_MS = 600;
const ERROR_FLASH_MS = 2500;

/**
 * Native (Apple-Speech sidecar) dictation path — OPT-IN alternate to
 * `useDictation`. It drives the Tauri `o8_stt_*` commands and listens to the
 * `o8:stt-event` window event emitted by the Rust STT engine (lifted from
 * aqua/Symon). The polished result arrives on the `polished` event after the
 * finalize chain (Whisper re-transcribe → Gemini polish) runs in Rust.
 *
 * This does NOT replace the webkitSpeechRecognition + HTTP `/api/dictation`
 * path in `useDictation.ts` — both ship. Callers choose the native path by
 * importing this hook (e.g. behind a settings flag). `isNativeDictationAvailable()`
 * reports whether the Tauri bridge + STT commands are present.
 */

type TauriCore = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

type TauriEvent = {
  listen: <T>(
    event: string,
    handler: (e: { payload: T }) => void,
  ) => Promise<() => void>;
};

function getTauri(): { core: TauriCore; event: TauriEvent } | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    __TAURI__?: { core?: TauriCore; event?: TauriEvent };
  };
  const core = w.__TAURI__?.core;
  const event = w.__TAURI__?.event;
  if (core?.invoke && event?.listen) return { core, event };
  return null;
}

export function isNativeDictationAvailable(): boolean {
  return getTauri() !== null;
}

interface SttEventPayload {
  type:
    | 'ready'
    | 'partial'
    | 'final'
    | 'level'
    | 'audio_file'
    | 'status'
    | 'error'
    | 'complete'
    | 'polished';
  sessionId?: number;
  text?: string;
  level?: number;
  rawText?: string;
  appleText?: string;
  whisperUsed?: boolean;
}

export function useNativeDictation() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>({
    state: 'idle',
    audioLevel: 0,
    durationMs: 0,
    error: null,
    partialTranscript: '',
  });

  const stateRef = useRef<DictationState>('idle');
  const optionsRef = useRef<DictationStartOptions | null>(null);
  const sessionIdRef = useRef<number>(0);
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
      setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
      stateRef.current = 'idle';
    }, ms);
  }, []);

  const goError = useCallback((message: string) => {
    stateRef.current = 'error';
    setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: message, partialTranscript: '' });
    returnToIdleAfter(ERROR_FLASH_MS);
    optionsRef.current?.onAbort?.(message);
  }, [returnToIdleAfter]);

  const handleEvent = useCallback((payload: SttEventPayload) => {
    // Only react to events for the active session (rapid-tap safety).
    if (
      payload.sessionId !== undefined
      && sessionIdRef.current !== 0
      && payload.sessionId !== sessionIdRef.current
    ) {
      return;
    }
    switch (payload.type) {
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
        // Apple's final transcript — move to transcribing while the Rust
        // finalize chain (Whisper → polish) runs. The `polished` event lands next.
        if (stateRef.current === 'recording') {
          setState('transcribing');
        }
        break;
      case 'audio_file':
        if (stateRef.current === 'transcribing') {
          setState('polishing');
        }
        break;
      case 'polished': {
        const options = optionsRef.current;
        const finalText = (payload.text ?? payload.rawText ?? payload.appleText ?? '').trim();
        if (!finalText) {
          setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
          stateRef.current = 'idle';
          options?.onAbort?.('No speech detected.');
          break;
        }
        setState('success', { audioLevel: 0 });
        options?.onComplete(finalText);
        returnToIdleAfter(SUCCESS_FLASH_MS);
        break;
      }
      case 'error':
        if (stateRef.current === 'recording' || stateRef.current === 'transcribing' || stateRef.current === 'polishing') {
          goError(payload.text ?? 'Dictation failed');
        }
        break;
      default:
        break;
    }
  }, [goError, returnToIdleAfter, setState]);

  // Install the o8:stt-event listener once.
  useEffect(() => {
    const tauri = getTauri();
    if (!tauri) return;
    let disposed = false;
    tauri.event
      .listen<SttEventPayload>('o8:stt-event', (e) => handleEvent(e.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenRef.current = unlisten;
      })
      .catch((err) => {
        console.warn('[native-dictation] failed to subscribe to o8:stt-event', err);
      });
    return () => {
      disposed = true;
      if (unlistenRef.current) {
        try { unlistenRef.current(); } catch { /* noop */ }
        unlistenRef.current = null;
      }
    };
  }, [handleEvent]);

  const start = useCallback(async (options: DictationStartOptions) => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    const tauri = getTauri();
    if (!tauri) {
      goError('Native dictation unavailable');
      return;
    }
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    optionsRef.current = options;
    setState('requesting-mic', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    try {
      const sessionId = await tauri.core.invoke<number>('o8_stt_start');
      sessionIdRef.current = sessionId;
      startTimeRef.current = Date.now();
      setState('recording', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[native-dictation] o8_stt_start failed', err);
      goError(msg || 'Could not start dictation');
    }
  }, [goError, setState]);

  const stopAndSubmit = useCallback(async () => {
    if (stateRef.current !== 'recording') return;
    const tauri = getTauri();
    if (!tauri) return;
    // Move to transcribing; the `final`/`audio_file`/`polished` events drive
    // the rest of the state machine.
    setState('transcribing');
    try {
      await tauri.core.invoke('o8_stt_stop');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[native-dictation] o8_stt_stop failed', err);
      goError(msg || 'Could not stop dictation');
    }
  }, [goError, setState]);

  const cancel = useCallback(() => {
    if (stateRef.current === 'idle') return;
    const tauri = getTauri();
    // Bump the session so any in-flight events are ignored.
    sessionIdRef.current += 1;
    if (tauri) {
      tauri.core.invoke('o8_stt_stop').catch(() => { /* noop */ });
    }
    setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    stateRef.current = 'idle';
    optionsRef.current?.onAbort?.(null);
  }, []);

  const setLocale = useCallback(async (locale: string) => {
    const tauri = getTauri();
    if (!tauri) return;
    try {
      await tauri.core.invoke('o8_stt_locale', { locale });
    } catch (err) {
      console.warn('[native-dictation] o8_stt_locale failed', err);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  return { snapshot, start, stopAndSubmit, cancel, setLocale };
}
