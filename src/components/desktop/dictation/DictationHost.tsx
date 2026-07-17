'use client';

/**
 * DictationHost — owns the dictation state machine + the pill overlay.
 *
 * Mounted once at the dashboard level. Exposes a context so any
 * composer mic button can `start()` the same session and any pill
 * anchor ref can be plugged in. The Ctrl+M global hold listener lives
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
import { isTauri, canUseTauriEvents } from '@/lib/tauri/bridge';
import { useSymonEditBridge } from './useSymonEditBridge';
import type { DictationStartOptions } from './types';

interface DictationHostContextValue {
  /** True when a dictation session is active. */
  active: boolean;
  /** Begin recording. Idempotent if already active. */
  start: (options: DictationStartOptions) => Promise<void>;
  /** Stop recording and submit for transcribe + polish. */
  stopAndSubmit: () => void;
  /** Cancel without submitting. */
  cancel: () => void;
  /** Snapshot for read-only consumers (mic button uses this for its visual). */
  snapshotState: 'idle' | 'requesting-mic' | 'recording' | 'transcribing' | 'polishing' | 'success' | 'error';
  /**
   * Register the active composer. Pill anchors to `node`; polished
   * transcript is delivered via `fill`. Sticky — blurring the
   * composer (e.g. clicking the mic button) does NOT unregister.
   * Another composer focusing replaces this registration. Call with
   * null to unregister explicitly (e.g. on unmount).
   */
  setActiveComposer: (composer: { node: HTMLElement; fill: (text: string) => void } | null) => void;
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
  const { snapshot, start: startInternal, stopAndSubmit, cancel } = engine;

  const anchorRef = useRef<HTMLElement | null>(null);
  const fillRef = useRef<((text: string) => void) | null>(null);
  // Force a re-render of the pill when the anchor element changes so it
  // recomputes position. The pill component handles its own resize/scroll
  // listening, but the *initial* mount needs a re-render to pick up a
  // late-attaching anchor.
  const [anchorVersion, setAnchorVersion] = useState(0);

  const setActiveComposer = useCallback((composer: { node: HTMLElement; fill: (text: string) => void } | null) => {
    if (composer) {
      anchorRef.current = composer.node;
      fillRef.current = composer.fill;
    } else {
      anchorRef.current = null;
      fillRef.current = null;
    }
    setAnchorVersion((v) => v + 1);
  }, []);

  // Wrap `start` so the host always routes onComplete through the
  // active composer's fill callback. Callers (mic button, Ctrl+Z
  // shortcut) only need to pass surface/context — the host owns the
  // delivery path.
  const start = useCallback((options: DictationStartOptions) => {
    return startInternal({
      ...options,
      onComplete: (text) => {
        if (text && fillRef.current) {
          fillRef.current(text);
        } else if (text) {
          // Fallback: no composer registered yet. Surface a one-shot
          // event so a late-mounting consumer could still grab it.
          window.dispatchEvent(new CustomEvent('o8:dictation-complete', { detail: { text } }));
        }
        options.onComplete?.(text);
      },
      onAbort: (reason) => {
        if (reason) {
          window.dispatchEvent(new CustomEvent('o8:dictation-aborted', { detail: { reason } }));
        }
        options.onAbort?.(reason);
      },
    });
  }, [startInternal]);

  // Ctrl+Z hold-to-talk. Press starts dictation, release stops + submits.
  // On macOS Cmd+Z is native undo for textareas; Ctrl+Z is unbound, so
  // we hijack it without breaking the composer's undo history. Linux
  // and Windows users would lose textarea undo with Ctrl+Z held — we'll
  // make this configurable when those platforms ship. Auto-repeat is
  // filtered via event.repeat.
  useEffect(() => {
    let pressed = false;
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
      pressed = true;
      // Host's `start` wrapper handles delivery to the active composer
      // — we just need to fire it.
      void start({ surface: 'orchestrator', onComplete: () => {} });
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!pressed) return;
      if ((event.key || '').toLowerCase() !== 'z' && !event.ctrlKey) return;
      pressed = false;
      stopAndSubmit();
    };
    const handleBlur = () => {
      if (pressed) {
        pressed = false;
        cancel();
      }
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
    active: snapshot.state !== 'idle',
    start,
    stopAndSubmit,
    cancel,
    snapshotState: snapshot.state,
    setActiveComposer,
  }), [cancel, setActiveComposer, snapshot.state, start, stopAndSubmit]);

  // Wrap anchorRef into a refobject the pill expects.
  const pillAnchorRef = useMemo(() => ({
    get current() { return anchorRef.current; },
    set current(_v: HTMLElement | null) { /* read-only proxy */ },
  } as React.RefObject<HTMLElement | null>), [anchorVersion]);

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
