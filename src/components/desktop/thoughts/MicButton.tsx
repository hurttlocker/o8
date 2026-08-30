'use client';

/**
 * MicButton — push-to-talk dictation button for the composer footer.
 *
 * Honors the user's dictation input-mode setting:
 *   - 'toggle' (default): tap once to start, tap again to stop & submit.
 *   - 'hold':              press and hold to record, release to stop.
 *
 * The keyboard shortcut (Ctrl+Z) always uses hold semantics regardless
 * of this setting — naturally fits the keyboard.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { useDictationHostOptional } from '@/components/desktop/dictation/DictationHost';
import {
  DEFAULT_DICTATION_INPUT_MODE,
  readDictationInputMode,
  subscribeDictationInputMode,
  type DictationInputMode,
} from '@/lib/appearance/dictation-input-mode';

const noopSubscribe = () => () => {};
const defaultSnapshot = (): DictationInputMode => DEFAULT_DICTATION_INPUT_MODE;

function useInputMode(): DictationInputMode {
  return useSyncExternalStore(
    typeof window !== 'undefined' ? subscribeDictationInputMode : noopSubscribe,
    typeof window !== 'undefined' ? readDictationInputMode : defaultSnapshot,
    defaultSnapshot,
  );
}

export function MicButton({ idleColor = 'var(--t-text-muted)' }: { idleColor?: string } = {}) {
  void idleColor;
  const host = useDictationHostOptional();
  const inputMode = useInputMode();

  // Toggle mode — single click drives the state machine.
  const handleClick = useCallback(() => {
    if (!host) return;
    if (inputMode !== 'toggle') return;
    if (host.snapshotState === 'idle') {
      void host.start({
        surface: 'orchestrator',
        onComplete: () => { /* host wrapper routes to active composer */ },
      });
    } else if (host.snapshotState === 'recording') {
      host.stopAndSubmit();
    } else if (host.snapshotState === 'requesting-mic') {
      host.cancel();
    }
    // While transcribing/polishing/success/error, the button is a no-op
    // so the in-flight pipeline finishes uninterrupted. Use the pill ×
    // to abort if needed.
  }, [host, inputMode]);

  // Hold mode — pointer-down starts, pointer-up submits, leave cancels.
  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!host) return;
    if (inputMode !== 'hold') return;
    if (host.snapshotState !== 'idle') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    void host.start({
      surface: 'orchestrator',
      onComplete: () => { /* host wrapper routes to active composer */ },
    });
  }, [host, inputMode]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!host) return;
    if (inputMode !== 'hold') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (host.snapshotState === 'recording') {
      host.stopAndSubmit();
    } else if (host.snapshotState === 'requesting-mic') {
      host.cancel();
    }
  }, [host, inputMode]);

  const handlePointerLeave = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!host) return;
    if (inputMode !== 'hold') return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) return;
    if (host.snapshotState === 'recording') host.cancel();
  }, [host, inputMode]);

  if (!host) return null;

  const recording = host.snapshotState === 'recording';
  const busy = host.snapshotState === 'transcribing' || host.snapshotState === 'polishing';
  const errored = host.snapshotState === 'error';

  const color = errored
    ? '#ef4444'
    : recording
      ? '#ef4444'
      : busy
        ? '#a78bfa'
        : 'var(--t-text-muted)';

  const idleHint = inputMode === 'toggle'
    ? 'Click to dictate — click again to send (Ctrl+Z hold also works)'
    : 'Hold to dictate (or hold Ctrl+Z)';
  const recordingHint = inputMode === 'toggle' ? 'Click to send' : 'Release to send';

  return (
    <button
      type="button"
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerUp}
      title={recording ? recordingHint : busy ? 'Transcribing…' : idleHint}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 0,
        background: recording ? 'rgba(239, 68, 68, 0.12)' : 'transparent',
        color,
        cursor: 'pointer',
        transition: 'color 120ms, background 120ms',
        userSelect: 'none',
      }}
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'block', flexShrink: 0 }}
        aria-hidden="true"
      >
        <rect x="9" y="2" width="6" height="12" rx="3" />
        <path d="M5 10v2a7 7 0 0 0 14 0v-2" />
        <path d="M12 19v3" />
      </svg>
    </button>
  );
}
