'use client';

/**
 * useSymonEditBridge — the o8-side half of Symon's in-place edit lane for
 * text living inside o8's OWN webview. The native AX path is blind here (a
 * WKWebView exposes neither AXSelectedText nor a reliable synthetic Cmd+C —
 * the same wall the Ctrl+Shift+S speak-selection path hit), so the Rust edit lane
 * round-trips through this listener instead:
 *
 *   `o8:edit-capture` → report the live selection / focused editable via
 *   `agent_edit_capture_result`.
 *   `o8:edit-apply` { mode, text } → replace the selection or the whole
 *   focused editable and ack via `agent_edit_apply_result`.
 *
 * React-controlled textareas/inputs get the native value setter + an input
 * event (the established #1105 pattern); contenteditable hosts (CodeMirror's
 * .cm-content included) get execCommand insertText so the edit flows through
 * the editor's own beforeinput pipeline.
 */
import { useEffect } from 'react';
import { canUseTauriEvents } from '@/lib/tauri/bridge';

type CapturePayload = { requestId: string };
type ApplyPayload = { requestId: string; mode: 'selection' | 'field'; text: string };

const TEXTY_INPUT_TYPES = ['text', 'search', 'url', 'email', 'tel', ''];

function focusedEditable(): HTMLTextAreaElement | HTMLInputElement | HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) {
    return TEXTY_INPUT_TYPES.includes(el.type || 'text') ? el : null;
  }
  return el.isContentEditable ? el : null;
}

function readState(): { selection: string | null; fieldValue: string | null; fieldEditable: boolean } {
  const el = focusedEditable();
  // window.getSelection covers contenteditable + static text; textarea/input
  // selections live on the element instead.
  let selection = window.getSelection()?.toString() ?? '';
  if (!selection && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
    const { selectionStart, selectionEnd, value } = el;
    if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
      selection = value.slice(selectionStart, selectionEnd);
    }
  }
  let fieldValue: string | null = null;
  let fieldEditable = false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    fieldValue = el.value;
    fieldEditable = !el.readOnly && !el.disabled;
  } else if (el?.isContentEditable) {
    fieldValue = el.innerText;
    fieldEditable = true;
  }
  return { selection: selection || null, fieldValue, fieldEditable };
}

function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function applyEdit(mode: 'selection' | 'field', text: string): { ok: boolean; error?: string } {
  const el = focusedEditable();

  if (mode === 'selection') {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const { selectionStart, selectionEnd, value } = el;
      if (selectionStart == null || selectionEnd == null || selectionEnd <= selectionStart) {
        return { ok: false, error: 'the selection is gone — ask the user to re-select' };
      }
      setNativeValue(el, value.slice(0, selectionStart) + text + value.slice(selectionEnd));
      const caret = selectionStart + text.length;
      el.setSelectionRange(caret, caret);
      return { ok: true };
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      return { ok: false, error: 'the selection is gone — ask the user to re-select' };
    }
    const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!anchor?.closest?.('[contenteditable="true"], [contenteditable=""]')) {
      return { ok: false, error: 'that text is read-only here — it can be edited where it was written' };
    }
    return document.execCommand('insertText', false, text)
      ? { ok: true }
      : { ok: false, error: 'the editor refused the edit' };
  }

  // field mode — replace the whole focused editable
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return { ok: false, error: 'the field is read-only' };
    setNativeValue(el, text);
    return { ok: true };
  }
  if (el?.isContentEditable) {
    window.getSelection()?.selectAllChildren(el);
    return document.execCommand('insertText', false, text)
      ? { ok: true }
      : { ok: false, error: 'the editor refused the edit' };
  }
  return { ok: false, error: 'no editable field is focused' };
}

export function useSymonEditBridge(): void {
  useEffect(() => {
    // Main-window only — these listeners in the native browser-view would
    // ACL-crash (see canUseTauriEvents).
    if (!canUseTauriEvents()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([import('@tauri-apps/api/event'), import('@tauri-apps/api/core')])
      .then(([{ listen }, { invoke }]) =>
        Promise.all([
          listen<CapturePayload>('o8:edit-capture', (e) => {
            const state = readState();
            void invoke('agent_edit_capture_result', { requestId: e.payload.requestId, state });
          }),
          listen<ApplyPayload>('o8:edit-apply', (e) => {
            const result = applyEdit(e.payload.mode, e.payload.text);
            void invoke('agent_edit_apply_result', { requestId: e.payload.requestId, result });
          }),
        ]),
      )
      .then((uns) => {
        if (disposed) uns.forEach((un) => un());
        else unlisteners.push(...uns);
      })
      .catch(() => {
        /* outside Tauri / event plugin unavailable */
      });
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
