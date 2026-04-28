'use client';

/**
 * usePressToDictate — shared long-press-to-dictate gesture for mobile
 * composer send buttons. Both the Orchestrator composer and the Assistant
 * ComposerBar wear this hook around the existing send button.
 *
 * Returns the spreadable pointer handlers, the recording state, the
 * latest committed transcript (so the caller can route it into its own
 * composer state), and a `claimSuppressedClick()` helper the caller uses
 * inside its onClick to swallow the synthetic click that follows a
 * long-press release (otherwise the button would also fire send).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoiceInput } from './voice-input';

const LONG_PRESS_MS = 350;

export interface PressToDictate {
  isRecording: boolean;
  supported: boolean;
  /** Last committed transcript chunk for the current session. */
  transcript: string;
  /** Auto-dismissing error/info string for an inline tooltip. */
  tooltip: string | null;
  /** Spread onto the send button. */
  pointerHandlers: {
    onPointerDown: () => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onPointerCancel: () => void;
  };
  /**
   * Call inside the button's onClick BEFORE doing anything else.
   * Returns true when the click should be suppressed (it's the synthetic
   * click that fires after a long-press release).
   */
  claimSuppressedClick: () => boolean;
  /**
   * Manually surface a tooltip (e.g. when the user taps an unsupported
   * device's send button on an empty composer — show "Voice not supported").
   */
  flashTooltip: (message: string) => void;
}

export function usePressToDictate(): PressToDictate {
  const voice = useVoiceInput();
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const longPressFiredRef = useRef(false);
  const [tooltip, setTooltip] = useState<string | null>(null);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback(() => {
    suppressClickRef.current = false;
    if (!voice.supported) return;
    longPressFiredRef.current = false;
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      voice.start();
    }, LONG_PRESS_MS);
  }, [voice, clearLongPressTimer]);

  const onPointerEnd = useCallback(() => {
    clearLongPressTimer();
    if (longPressFiredRef.current) {
      suppressClickRef.current = true;
      longPressFiredRef.current = false;
      voice.stop();
    }
  }, [voice, clearLongPressTimer]);

  const claimSuppressedClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return true;
    }
    return false;
  }, []);

  const flashTooltip = useCallback((message: string) => {
    setTooltip(message);
    window.setTimeout(() => {
      setTooltip((current) => (current === message ? null : current));
    }, 1800);
  }, []);

  // Surface real recognition errors as a brief tooltip.
  useEffect(() => {
    if (!voice.error) return;
    setTooltip(voice.error);
    const handle = window.setTimeout(() => setTooltip(null), 2400);
    return () => window.clearTimeout(handle);
  }, [voice.error]);

  return {
    isRecording: voice.isRecording,
    supported: voice.supported,
    transcript: voice.transcript,
    tooltip,
    pointerHandlers: {
      onPointerDown,
      onPointerUp: onPointerEnd,
      onPointerLeave: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    claimSuppressedClick,
    flashTooltip,
  };
}
