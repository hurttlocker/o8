'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DictationSnapshot, DictationStartOptions, DictationState } from './types';

const SUCCESS_FLASH_MS = 600;
const ERROR_FLASH_MS = 2500;

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext
    || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    || null
  );
}

// Webkit-prefixed SpeechRecognition is the only implementation in
// Chromium / WKWebView today. We narrow to the bits we use; full type
// upstream lives in the DOM lib but isn't always picked up.
type WebSpeechRecognitionLike = {
  start: () => void;
  stop: () => void;
  abort: () => void;
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>; resultIndex: number }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function getSpeechRecognition(): (new () => WebSpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => WebSpeechRecognitionLike;
    webkitSpeechRecognition?: new () => WebSpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useDictation() {
  const [snapshot, setSnapshot] = useState<DictationSnapshot>({
    state: 'idle',
    audioLevel: 0,
    durationMs: 0,
    error: null,
    partialTranscript: '',
  });

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const optionsRef = useRef<DictationStartOptions | null>(null);
  const recordingIdRef = useRef(0);
  const stateRef = useRef<DictationState>('idle');
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speechRecognitionRef = useRef<WebSpeechRecognitionLike | null>(null);
  const partialFinalRef = useRef<string>('');

  const setState = useCallback((next: DictationState, patch?: Partial<DictationSnapshot>) => {
    stateRef.current = next;
    setSnapshot((prev) => ({ ...prev, ...patch, state: next }));
  }, []);

  const cleanup = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* noop */ }
    }
    recorderRef.current = null;
    const stream = mediaStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
    }
    mediaStreamRef.current = null;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== 'closed') {
      ctx.close().catch(() => { /* noop */ });
    }
    audioCtxRef.current = null;
    analyserRef.current = null;
    chunksRef.current = [];
    const recognizer = speechRecognitionRef.current;
    if (recognizer) {
      try { recognizer.abort(); } catch { /* noop */ }
      recognizer.onresult = null;
      recognizer.onerror = null;
      recognizer.onend = null;
    }
    speechRecognitionRef.current = null;
    partialFinalRef.current = '';
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
    cleanup();
    stateRef.current = 'error';
    setSnapshot({ state: 'error', audioLevel: 0, durationMs: 0, error: message, partialTranscript: '' });
    returnToIdleAfter(ERROR_FLASH_MS);
    optionsRef.current?.onAbort?.(message);
  }, [cleanup, returnToIdleAfter]);

  const runRafLoop = useCallback((recordingId: number) => {
    const buffer = new Uint8Array(analyserRef.current?.fftSize ?? 256);
    const tick = () => {
      if (recordingId !== recordingIdRef.current) return;
      const analyser = analyserRef.current;
      if (!analyser) return;
      analyser.getByteTimeDomainData(buffer);
      let sumSq = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buffer.length);
      const level = Math.min(1, rms * 1.6);
      const duration = Date.now() - startTimeRef.current;
      setSnapshot((prev) => {
        if (prev.state === 'idle') return prev;
        return { ...prev, audioLevel: level, durationMs: duration };
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(async (options: DictationStartOptions) => {
    if (stateRef.current !== 'idle' && stateRef.current !== 'error') return;
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    optionsRef.current = options;
    const recordingId = ++recordingIdRef.current;
    partialFinalRef.current = '';
    setState('requesting-mic', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const friendly = name === 'NotAllowedError'
        ? 'Mic permission denied. Allow microphone access in browser settings.'
        : name === 'NotFoundError'
          ? 'No microphone detected.'
          : err instanceof Error ? err.message : 'Microphone unavailable';
      console.warn('[dictation] getUserMedia failed:', name, err);
      goError(friendly);
      return;
    }
    if (recordingId !== recordingIdRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStreamRef.current = stream;

    const AudioCtor = getAudioContextCtor();
    if (!AudioCtor) {
      goError('Audio API unavailable');
      return;
    }
    const audioCtx = new AudioCtor();
    audioCtxRef.current = audioCtx;
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    analyserRef.current = analyser;

    const mime = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Recorder unavailable';
      goError(msg);
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start();

    startTimeRef.current = Date.now();
    setState('recording', { audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    runRafLoop(recordingId);

    // Best-effort live partials via the browser's SpeechRecognition API.
    // Fires alongside the MediaRecorder so the user sees their words in
    // the pill while we're still capturing audio for the canonical
    // Whisper pass. Failures are silent — the pill falls back to just
    // the waveform without a partial transcript.
    const SpeechCtor = getSpeechRecognition();
    if (SpeechCtor) {
      try {
        const recognizer = new SpeechCtor();
        recognizer.continuous = true;
        recognizer.interimResults = true;
        recognizer.lang = 'en-US';
        recognizer.onresult = (event) => {
          if (recordingId !== recordingIdRef.current) return;
          let interim = '';
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            const alt = result[0];
            if (!alt) continue;
            if (result.isFinal) {
              partialFinalRef.current = `${partialFinalRef.current}${partialFinalRef.current ? ' ' : ''}${alt.transcript.trim()}`.trim();
            } else {
              interim = `${interim}${interim ? ' ' : ''}${alt.transcript.trim()}`.trim();
            }
          }
          const combined = `${partialFinalRef.current}${partialFinalRef.current && interim ? ' ' : ''}${interim}`.trim();
          setSnapshot((prev) => (prev.state === 'recording' && prev.partialTranscript !== combined
            ? { ...prev, partialTranscript: combined }
            : prev));
        };
        recognizer.onerror = (event) => {
          // 'no-speech' / 'aborted' / 'audio-capture' are non-fatal — the
          // pill just stops getting partials. Log for diagnostics.
          if (event.error !== 'aborted' && event.error !== 'no-speech') {
            console.warn('[dictation] speech-recognition error:', event.error);
          }
        };
        recognizer.onend = () => {
          // Auto-restart if still recording (the recognizer can stop
          // itself after long silence even with continuous=true).
          if (stateRef.current === 'recording' && speechRecognitionRef.current === recognizer) {
            try { recognizer.start(); } catch { /* already started or stopped */ }
          }
        };
        recognizer.start();
        speechRecognitionRef.current = recognizer;
      } catch (err) {
        console.warn('[dictation] failed to start speech recognition:', err);
      }
    }
  }, [goError, runRafLoop, setState]);

  const stopAndSubmit = useCallback(async () => {
    if (stateRef.current !== 'recording') return;
    const options = optionsRef.current;
    const recorder = recorderRef.current;
    const recordingId = recordingIdRef.current;
    if (!options || !recorder) {
      cleanup();
      return;
    }

    const blob: Blob = await new Promise((resolve) => {
      const onStop = () => {
        recorder.removeEventListener('stop', onStop);
        const mime = recorder.mimeType || 'audio/webm';
        resolve(new Blob(chunksRef.current, { type: mime }));
      };
      recorder.addEventListener('stop', onStop);
      try { recorder.stop(); } catch { onStop(); }
    });

    if (recordingId !== recordingIdRef.current) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    mediaStreamRef.current?.getTracks().forEach((t) => { try { t.stop(); } catch { /* noop */ } });
    mediaStreamRef.current = null;

    setState('transcribing');

    try {
      const fd = new FormData();
      fd.append('audio', blob, 'dictation.webm');
      const transcribeResp = await fetch('/api/dictation/transcribe', { method: 'POST', body: fd });
      if (!transcribeResp.ok) {
        // Surface the server's friendly error (e.g. missing OPENROUTER_API_KEY).
        let detail = `HTTP ${transcribeResp.status}`;
        try {
          const errJson = (await transcribeResp.json()) as { error?: string };
          if (errJson.error) detail = errJson.error;
        } catch { /* ignore */ }
        throw new Error(detail);
      }
      const transcribeJson = (await transcribeResp.json()) as { text?: string };
      const rawTranscript = (transcribeJson.text ?? '').trim();
      if (!rawTranscript) {
        cleanup();
        setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
        stateRef.current = 'idle';
        options.onAbort?.('No speech detected.');
        return;
      }

      setState('polishing');
      let polishedText = rawTranscript;
      try {
        const polishResp = await fetch('/api/dictation/polish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transcript: rawTranscript,
            surface: options.surface ?? 'general',
            context: options.context ?? {},
          }),
        });
        if (!polishResp.ok) throw new Error(`Polish failed (${polishResp.status})`);
        const polishJson = (await polishResp.json()) as { text?: string };
        polishedText = (polishJson.text ?? '').trim() || rawTranscript;
      } catch (err) {
        console.warn('[dictation] polish failed, falling back to raw transcript', err);
        polishedText = rawTranscript;
      }

      cleanup();
      setState('success', { audioLevel: 0 });
      options.onComplete(polishedText);
      returnToIdleAfter(SUCCESS_FLASH_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Dictation failed';
      goError(msg);
    }
  }, [cleanup, goError, returnToIdleAfter, setState]);

  const cancel = useCallback(() => {
    if (stateRef.current === 'idle') return;
    recordingIdRef.current += 1;
    cleanup();
    setSnapshot({ state: 'idle', audioLevel: 0, durationMs: 0, error: null, partialTranscript: '' });
    stateRef.current = 'idle';
    optionsRef.current?.onAbort?.(null);
  }, [cleanup]);

  useEffect(() => {
    return () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      cleanup();
    };
  }, [cleanup]);

  return { snapshot, start, stopAndSubmit, cancel };
}
