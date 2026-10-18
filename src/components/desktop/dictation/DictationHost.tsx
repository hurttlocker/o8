'use client';

/**
 * DictationHost — owns the dictation state machine + the pill overlay.
 *
 * Mounted once at the dashboard level. Exposes a context so any
 * composer mic button can `start()` the same session and any pill
 * anchor ref can be plugged in. The Ctrl+Z global hold listener lives
 * here too (window-focused only — we'll add a Tauri global hotkey in
 * a later phase).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DictationPill } from './DictationPill';
import { useDictation } from './useDictation';
import { isNativeDictationAvailable, useNativeDictation } from './useNativeDictation';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { useSymonEditBridge } from './useSymonEditBridge';
import type { DictationStartOptions } from './types';
import { stopPlaybackForDictation } from '@/lib/tts/dictation-barge-in';

interface ComposerTarget { id: string; node: HTMLTextAreaElement; fill: (text: string) => void }

interface DictationHostContextValue {
  /** True when a dictation session is active. */
  active: boolean;
  /** Begin recording. Idempotent if already active. */
  start: (options: DictationStartOptions, composerId?: string) => Promise<void>;
  /** Stop recording and submit for transcribe + polish. */
  stopAndSubmit: (composerId?: string) => void;
  /** Cancel without submitting. */
  cancel: (composerId?: string) => void;
  /** Snapshot for read-only consumers (mic button uses this for its visual). */
  snapshotState: 'idle' | 'requesting-mic' | 'recording' | 'transcribing' | 'polishing' | 'success' | 'error';
  ownerId: string | null;
  registerComposer: (composer: ComposerTarget) => () => void;
  activateComposer: (id: string) => void;
}

const DictationHostContext = createContext<DictationHostContextValue | null>(null);

export function useDictationHost(): DictationHostContextValue {
  const ctx = useContext(DictationHostContext);
  if (!ctx) throw new Error('useDictationHost must be used within <DictationHost>.');
  return ctx;
}

export function useDictationHostOptional(): DictationHostContextValue | null {
  return useContext(DictationHostContext);
}

interface DictationHostProps {
  children: ReactNode;
}

export function DictationHost({ children }: DictationHostProps) {
  // Both engines are mounted unconditionally (rules of hooks). The native
  // path (Apple-Speech sidecar via Tauri `o8_stt_*` + `o8:stt-event`) is the
  // preferred surface when the Tauri bridge is present; otherwise we fall back
  // to the webkitSpeechRecognition + HTTP `/api/dictation` path. Both expose
  // the identical { snapshot, start, stopAndSubmit, cancel } contract and the
  // same DictationSnapshot shape, so push-to-talk behaves the same either way.
  const webDictation = useDictation();
  const nativeDictation = useNativeDictation();
  // Symon's in-place edit lane for text inside o8's own webview (the AX path
  // can't see a WKWebView) — answers o8:edit-capture / o8:edit-apply.
  useSymonEditBridge();

  // Resolve availability after mount — `isNativeDictationAvailable()` reads
  // window.__TAURI__, which is undefined during SSR. Defaulting to false keeps
  // the first server/client render in sync (no hydration mismatch); the effect
  // promotes to the native path once the bridge is confirmed.
  const [nativeAvailable, setNativeAvailable] = useState(false);
  useEffect(() => {
    const available = isNativeDictationAvailable();
    setNativeAvailable(available);
    if (available) {
      console.log('[dictation] native on-device engine active (Apple-Speech sidecar)');
    }
  }, []);

  // In-app delivery for SYSTEM (Fn) dictation while o8 is frontmost
  // (#1542 composer-focus fix): Rust emits `system-fill` instead of posting a
  // synthetic Cmd+V at our own webview (which lost a first-responder race and
  // pasted nowhere — live incident 2026-07-10). Delivery ladder: the
  // sticky-registered composer's fill → insertText at the focused editable →
  // ask Rust for a real synthetic paste as the LAST resort.
  useEffect(() => {
    // Main-window only (canUseTauriEvents) — the same listener mounted in the
    // native browser-view would ACL-crash on emit/listen.
    if (!canUseTauriEvents()) return;
    let disposed = false;
    let unlistenFn: (() => void) | null = null;
    // Insert into a TEXTAREA/INPUT through the React-aware native setter when
    // execCommand declines (WebKit returns false on some controlled inputs) —
    // the same recipe the webview agent uses. Returns whether text landed.
    const insertIntoField = (el: HTMLElement, text: string): boolean => {
      const inserted = document.execCommand('insertText', false, text);
      if (inserted) return true;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const field = el as HTMLTextAreaElement | HTMLInputElement;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) {
          const start = field.selectionStart ?? field.value.length;
          const end = field.selectionEnd ?? start;
          setter.call(field, field.value.slice(0, start) + text + field.value.slice(end));
          field.dispatchEvent(new Event('input', { bubbles: true }));
          try { field.setSelectionRange(start + text.length, start + text.length); } catch { /* type=email etc. */ }
          return true;
        }
      }
      return false;
    };
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<{ type?: string; text?: string; nonce?: number }>('o8:stt-event', (e) => {
          if (e.payload?.type !== 'system-fill') return;
          const text = e.payload.text ?? '';
          if (!text) return;
          // J5PHEN root fix: a nonce-carrying fill gets a delivery RECEIPT —
          // Rust blocks on o8_stt_fill_ack and only an acked insert counts as
          // pasted. When we can't place the text we ack delivered:false and
          // RUST owns the synthetic-paste fallback (single owner — the old
          // JS-side o8_debug_paste fallback would double-paste against it).
          const nonce = typeof e.payload.nonce === 'number' ? e.payload.nonce : null;
          const ack = (delivered: boolean, via: string) => {
            if (nonce === null) return;
            import('@tauri-apps/api/core')
              .then(({ invoke }) => invoke('o8_stt_fill_ack', { nonce, delivered, via }))
              .catch((err) => console.warn('[dictation] fill ack failed', err));
          };
          // Deliver to the field the operator is actually in. A DIFFERENT in-app
          // editable (e.g. the error-report dialog, SXHV68) must win over the
          // sticky-registered orchestrator composer — otherwise its text is
          // hijacked into the composer. The composer only gets the React-aware
          // fill when IT holds focus, or when no editable does (the #1542 case
          // where a synthetic Cmd+V lost the first-responder race).
          const el = document.activeElement as HTMLElement | null;
          const editable = !!el && (
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'INPUT' ||
            el.isContentEditable
          );
          const composerNode = anchorRef.current;
          const focusedIsComposer =
            editable && !!composerNode && (composerNode === el || composerNode.contains(el));
          if (editable && !focusedIsComposer && el) {
            const ok = insertIntoField(el, text);
            ack(ok, ok ? 'focused-editable' : 'focused-editable-refused');
            if (ok || nonce !== null) return;
            // ok=false on a legacy (nonce-less) fill: fall through the ladder.
          }
          if (fillRef.current) {
            fillRef.current(text);
            ack(true, 'composer-fill');
            return;
          }
          if (editable && el) {
            const ok = insertIntoField(el, text);
            ack(ok, ok ? 'focused-editable' : 'focused-editable-refused');
            if (ok || nonce !== null) return;
          }
          // Nowhere in-app to put it. Nonce path: decline and let Rust run the
          // synthetic paste. Legacy path (old shell, no nonce): keep the
          // JS-side fallback that shells before 0.1.613 rely on.
          if (nonce !== null) {
            ack(false, 'no-target');
            return;
          }
          import('@tauri-apps/api/core')
            .then(({ invoke }) => invoke('o8_debug_paste', { text }))
            .catch((err) => console.warn('[dictation] system-fill fallback paste failed', err));
        }),
      )
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;
      })
      .catch((err) => console.warn('[dictation] system-fill listener failed', err));
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, []);

  const engine = nativeAvailable ? nativeDictation : webDictation;
  const { snapshot, start: startInternal, stopAndSubmit: stopInternal, cancel: cancelInternal } = engine;

  const anchorRef = useRef<HTMLElement | null>(null);
  const fillRef = useRef<((text: string) => void) | null>(null);
  // Force a re-render of the pill when the anchor element changes so it
  // recomputes position. The pill component handles its own resize/scroll
  // listening, but the *initial* mount needs a re-render to pick up a
  // late-attaching anchor.
  const [anchorVersion, setAnchorVersion] = useState(0);

  const composers = useRef(new Map<string, ComposerTarget>());
  const activeId = useRef<string | null>(null);
  const recordingTarget = useRef<ComposerTarget | null>(null);
  const starting = useRef(false);
  const [startPending, setStartPending] = useState(false);
  const recordingSequence = useRef(0);
  const keyboardSession = useRef<number | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const cancel = useCallback((id?: string) => {
    if (id && recordingTarget.current?.id !== id) return;
    recordingTarget.current = null;
    keyboardSession.current = null;
    setOwnerId(null);
    cancelInternal();
  }, [cancelInternal]);
  const stopAndSubmit = useCallback((id?: string) => {
    if (id && recordingTarget.current?.id !== id) return;
    if (snapshot.state === 'requesting-mic' || (starting.current && snapshot.state === 'idle')) {
      cancel(id);
      return;
    }
    stopInternal();
  }, [cancel, snapshot.state, stopInternal]);
  const activateComposer = useCallback((id: string) => {
    const target = composers.current.get(id);
    if (!target) return;
    activeId.current = id;
    anchorRef.current = target.node;
    fillRef.current = target.fill;
    setAnchorVersion(value => value + 1);
  }, []);
  const registerComposer = useCallback((target: ComposerTarget) => {
    composers.current.set(target.id, target);
    return () => {
      if (composers.current.get(target.id) !== target) return;
      composers.current.delete(target.id);
      if (recordingTarget.current === target) cancel(target.id);
      if (activeId.current === target.id) {
        activeId.current = null;
        anchorRef.current = null;
        fillRef.current = null;
      }
    };
  }, [cancel]);
  useEffect(() => {
    if (snapshot.state === 'idle' && !starting.current) {
      recordingTarget.current = null;
      setOwnerId(null);
    }
  }, [snapshot.state]);

  // Pin the destination before asking for a microphone. Focus changes only
  // affect the next recording; a closed/replaced draft never receives late text.
  const start = useCallback(async (options: DictationStartOptions, id?: string) => {
    if (starting.current || recordingTarget.current || snapshot.state !== 'idle') return;
    const target = composers.current.get(id ?? activeId.current ?? '');
    if (!target || !target.node.isConnected || target.node.disabled || target.node.readOnly
      || target.node.closest('[inert]')) return;
    recordingSequence.current += 1;
    starting.current = true;
    setStartPending(true);
    recordingTarget.current = target;
    setOwnerId(target.id);
    stopPlaybackForDictation();
    try {
      await startInternal({
        ...options,
        onComplete: text => {
          if (recordingTarget.current !== target || composers.current.get(target.id) !== target || !target.node.isConnected) return;
          if (text) target.fill(text);
          options.onComplete?.(text);
        },
        onAbort: reason => {
          if (recordingTarget.current !== target) return;
          if (reason) window.dispatchEvent(new CustomEvent('o8:dictation-aborted', { detail: { reason } }));
          options.onAbort?.(reason);
        },
      });
    } finally {
      // Native permission/startup may finish after cancellation. Revoke the
      // late engine session before allowing another composer to start.
      if (recordingTarget.current !== target) cancelInternal();
      starting.current = false;
      setStartPending(false);
    }
  }, [cancelInternal, snapshot.state, startInternal]);

  // Ctrl+Z hold-to-talk. Press starts dictation, release stops + submits.
  // On macOS Cmd+Z is native undo for textareas; Ctrl+Z is unbound, so
  // we hijack it without breaking the composer's undo history. Linux
  // and Windows users would lose textarea undo with Ctrl+Z held — we'll
  // make this configurable when those platforms ship. Auto-repeat is
  // filtered via event.repeat.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      // Ctrl+Z only — explicitly NOT Cmd+Z (native undo on macOS).
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if ((event.key || '').toLowerCase() !== 'z') return;
      // If focus is in an input where Ctrl+Z does something native, bail.
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable && (target.dataset?.dictationOptOut === 'true')) return;
      // Block when already recording — release will end this session.
      if (snapshot.state !== 'idle') return;
      event.preventDefault();
      const previousSession = recordingSequence.current;
      // Host's `start` wrapper handles delivery to the active composer
      // — we just need to fire it.
      void start({ surface: 'orchestrator', onComplete: () => {} });
      if (recordingSequence.current !== previousSession) keyboardSession.current = recordingSequence.current;
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (keyboardSession.current === null) return;
      if ((event.key || '').toLowerCase() !== 'z' && !event.ctrlKey) return;
      const session = keyboardSession.current;
      keyboardSession.current = null;
      if (session === recordingSequence.current) stopAndSubmit();
    };
    const handleBlur = () => {
      const session = keyboardSession.current;
      keyboardSession.current = null;
      if (session !== null && session === recordingSequence.current) cancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [cancel, snapshot.state, start, stopAndSubmit]);

  const value = useMemo<DictationHostContextValue>(() => ({
    active: startPending || snapshot.state !== 'idle',
    start,
    stopAndSubmit,
    cancel,
    snapshotState: snapshot.state,
    ownerId,
    registerComposer,
    activateComposer,
  }), [activateComposer, cancel, ownerId, registerComposer, snapshot.state, start, startPending, stopAndSubmit]);

  // Wrap anchorRef into a refobject the pill expects.
  const pillAnchorRef = useMemo(() => {
    void anchorVersion;
    return {
      get current() { return recordingTarget.current?.node ?? anchorRef.current; },
      set current(_v: HTMLElement | null) { /* read-only proxy */ },
    } as React.RefObject<HTMLElement | null>;
  }, [anchorVersion]);

  return (
    <DictationHostContext.Provider value={value}>
      {children}
      <DictationPill
        snapshot={snapshot}
        onCancel={cancel}
        anchorRef={pillAnchorRef}
      />
    </DictationHostContext.Provider>
  );
}
