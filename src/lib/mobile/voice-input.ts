'use client';

/**
 * useVoiceInput — long-press dictation for mobile composers.
 *
 * Wraps the Web Speech API (window.SpeechRecognition / webkitSpeechRecognition)
 * behind a small, idempotent hook. Designed for press-and-hold on a send
 * button: caller invokes start() on long-press, stop() on release, and
 * reads the transcript when isRecording flips back to false.
 *
 * iOS Safari exposes the API as webkitSpeechRecognition. In standalone PWA
 * mode some builds gate it behind permissions; if construction throws or
 * the API is missing, supported === false and start() is a no-op.
 *
 * Hard 60-second cap so a stuck recording never drains battery.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const MAX_RECORDING_MS = 60_000;

type SpeechRecognitionAlternativeLite = { transcript: string };
type SpeechRecognitionResultLite = {
  0: SpeechRecognitionAlternativeLite;
  isFinal: boolean;
};
type SpeechRecognitionEventLite = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLite>;
};
type SpeechRecognitionErrorEventLite = { error: string };

interface SpeechRecognitionLite {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult: ((event: SpeechRecognitionEventLite) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLite) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLite;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseVoiceInputResult {
  start: () => void;
  stop: () => void;
  /** Final committed transcript chunks joined together for the current session. */
  transcript: string;
  isRecording: boolean;
  supported: boolean;
  error: string | null;
}

export function useVoiceInput(): UseVoiceInputResult {
  const [supported] = useState<boolean>(() => getCtor() !== null);
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionLite | null>(null);
  const finalChunksRef = useRef<string[]>([]);
  const timeoutRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    const rec = recognitionRef.current;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try { rec.abort(); } catch { /* ignore */ }
    }
    recognitionRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const start = useCallback(() => {
    if (!supported) {
      setError('Voice not supported on this device');
      return;
    }
    if (recognitionRef.current) return; // already recording

    const Ctor = getCtor();
    if (!Ctor) {
      setError('Voice not supported on this device');
      return;
    }

    let rec: SpeechRecognitionLite;
    try {
      rec = new Ctor();
    } catch (constructError) {
      console.log('[voice-input] failed to construct recognizer', constructError);
      setError('Microphone unavailable');
      return;
    }

    rec.lang = (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
    rec.continuous = true;
    rec.interimResults = false;

    finalChunksRef.current = [];
    setTranscript('');
    setError(null);

    rec.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) {
          const chunk = result[0]?.transcript ?? '';
          if (chunk) finalChunksRef.current.push(chunk);
        }
      }
      setTranscript(finalChunksRef.current.join(' ').trim());
    };

    rec.onerror = (event) => {
      // 'no-speech' / 'aborted' fire normally on stop — only surface real
      // failures so we don't spam the UI with permission prompts the user
      // already dismissed.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.log('[voice-input] recognition error', event.error);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Microphone permission denied');
      } else {
        setError(event.error || 'Voice input failed');
      }
    };

    rec.onend = () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      recognitionRef.current = null;
      setIsRecording(false);
    };

    try {
      rec.start();
      recognitionRef.current = rec;
      setIsRecording(true);
      timeoutRef.current = window.setTimeout(() => {
        try { rec.stop(); } catch { /* ignore */ }
      }, MAX_RECORDING_MS);
    } catch (startError) {
      console.log('[voice-input] start failed', startError);
      setError('Could not start recording');
      recognitionRef.current = null;
      setIsRecording(false);
    }
  }, [supported]);

  const stop = useCallback(() => {
    const rec = recognitionRef.current;
    if (!rec) return;
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try { rec.stop(); } catch { /* ignore */ }
  }, []);

  return { start, stop, transcript, isRecording, supported, error };
}
