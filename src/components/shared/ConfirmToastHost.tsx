'use client';

/**
 * ConfirmToastHost — the branded replacement for native window.confirm /
 * window.prompt / window.alert (Tier-2 self-consistency pass).
 *
 * A module-level store + imperative API so it's callable from ANYWHERE —
 * components AND plain hooks (e.g. useRepoCardModel) — without prop-drilling or
 * a React context:
 *
 *   const ok = await requestConfirm({ title: 'Clean up branch?', message: '…', danger: true });
 *   const path = await requestPrompt({ title: 'Open folder', placeholder: '/path' });
 *   toast('Unable to clean up branch.', 'error');
 *
 * Mount <ConfirmToastHost/> ONCE per root (desktop dashboard + mobile shell).
 * If it isn't mounted the confirm/prompt promises never resolve, so the mount
 * is load-bearing.
 *
 * Inline styles only, var(--t-*) tokens, lucide-shims icons (repo rules).
 */

import { useEffect, useRef, useState } from 'react';

import { AlertTriangle, AlertCircle, CheckCircle2 } from '@/components/desktop/lucide-shims';

// ── Types ───────────────────────────────────────────────────────────────────

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}
type ToastKind = 'error' | 'info' | 'success';

type Dialog =
  | { id: number; kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

interface ToastItem { id: number; message: string; kind: ToastKind }

// ── Module store ──────────────────────────────────────────────────────────────

let dialogQueue: Dialog[] = [];
let toastList: ToastItem[] = [];
let seq = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Resolve the front-of-queue dialog and advance. */
function settleTop(value: boolean | string | null) {
  const top = dialogQueue[0];
  if (!top) return;
  dialogQueue = dialogQueue.slice(1);
  emit();
  (top.resolve as (v: boolean | string | null) => void)(value);
}

/** Branded confirm. Resolves true/false. Replaces window.confirm. */
export function requestConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    dialogQueue = [...dialogQueue, { id: seq++, kind: 'confirm', opts, resolve }];
    emit();
  });
}

/** Branded single-field prompt. Resolves the string, or null on cancel. Replaces window.prompt. */
export function requestPrompt(opts: PromptOpts): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    dialogQueue = [...dialogQueue, { id: seq++, kind: 'prompt', opts, resolve }];
    emit();
  });
}

/** Branded transient toast. Replaces window.alert (default kind 'error'). */
export function toast(message: string, kind: ToastKind = 'error') {
  const id = seq++;
  toastList = [...toastList, { id, message, kind }].slice(-4);
  emit();
  setTimeout(() => {
    toastList = toastList.filter((t) => t.id !== id);
    emit();
  }, 5200);
}

// ── Host ──────────────────────────────────────────────────────────────────────

export function ConfirmToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const dialog = dialogQueue[0] ?? null;

  return (
    <>
      {dialog ? <DialogCard key={dialog.id} dialog={dialog} /> : null}
      {toastList.length > 0 ? (
        <div
          style={{
            position: 'fixed',
            bottom: 56,
            right: 20,
            zIndex: 100000,
            display: 'flex',
            flexDirection: 'column-reverse',
            gap: 8,
            pointerEvents: 'none',
          }}
        >
          {toastList.map((t) => <ToastRow key={t.id} item={t} />)}
        </div>
      ) : null}
    </>
  );
}

// ── Confirm / prompt card ───────────────────────────────────────────────────

function DialogCard({ dialog }: { dialog: Dialog }) {
  const isPrompt = dialog.kind === 'prompt';
  const promptOpts = isPrompt ? (dialog.opts as PromptOpts) : null;
  const [value, setValue] = useState(promptOpts?.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isPrompt) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [isPrompt]);

  const accept = () => settleTop(isPrompt ? value : true);
  const cancel = () => settleTop(isPrompt ? null : false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && !isPrompt) { e.preventDefault(); accept(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrompt, value]);

  const danger = !isPrompt && (dialog.opts as ConfirmOpts).danger === true;
  const confirmLabel = dialog.opts.confirmLabel ?? (isPrompt ? 'OK' : danger ? 'Confirm' : 'Continue');
  const cancelLabel = (isPrompt ? undefined : (dialog.opts as ConfirmOpts).cancelLabel) ?? 'Cancel';

  return (
    <div
      onMouseDown={cancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100001,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '14vh',
        background: 'rgba(15, 23, 42, 0.18)',
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        fontFamily: 'var(--font-sans-system)',
      } as React.CSSProperties}
    >
      <div
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, calc(100vw - 40px))',
          borderRadius: 16,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-panel-border)',
          boxShadow: '0 28px 70px rgba(0,0,0,0.22), 0 8px 24px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.18)',
          backdropFilter: 'blur(40px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(40px) saturate(1.6)',
          paddingTop: 18,
          paddingBottom: 16,
          paddingLeft: 18,
          paddingRight: 18,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          {danger ? (
            <span style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: 9, display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', marginTop: 1,
            }}>
              <AlertTriangle size={16} strokeWidth={2.2} />
            </span>
          ) : null}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--t-text)', lineHeight: 1.35 }}>
              {dialog.opts.title}
            </div>
            {dialog.opts.message ? (
              <div style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text-secondary)', lineHeight: 1.5, marginTop: 6, whiteSpace: 'pre-line' }}>
                {dialog.opts.message}
              </div>
            ) : null}

            {isPrompt ? (
              <input
                ref={inputRef}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); accept(); } }}
                placeholder={promptOpts?.placeholder}
                spellCheck={false}
                style={{
                  width: '100%',
                  marginTop: 12,
                  paddingTop: 9,
                  paddingBottom: 9,
                  paddingLeft: 11,
                  paddingRight: 11,
                  borderRadius: 10,
                  border: '1px solid var(--t-input-border)',
                  background: 'var(--t-input-bg)',
                  color: 'var(--t-text)',
                  fontSize: 13,
                  fontFamily: 'var(--font-mono, ui-monospace), monospace',
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button
            type="button"
            onClick={cancel}
            style={{
              paddingTop: 8, paddingBottom: 8, paddingLeft: 14, paddingRight: 14,
              borderRadius: 10, border: '1px solid var(--t-divider)', background: 'transparent',
              color: 'var(--t-text-secondary)', fontSize: 12.5, fontWeight: 400, cursor: 'pointer',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={accept}
            style={{
              paddingTop: 8, paddingBottom: 8, paddingLeft: 16, paddingRight: 16,
              borderRadius: 10, border: 'none', cursor: 'pointer',
              background: danger ? '#ef4444' : 'var(--t-accent, #2563eb)',
              color: '#ffffff', fontSize: 12.5, fontWeight: 500,
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Toast row ───────────────────────────────────────────────────────────────

const TOAST_ICON: Record<ToastKind, typeof AlertTriangle> = {
  error: AlertTriangle,
  info: AlertCircle,
  success: CheckCircle2,
};
const TOAST_TINT: Record<ToastKind, string> = {
  error: '#ef4444',
  info: '#2563eb',
  success: '#16a34a',
};

function ToastRow({ item }: { item: ToastItem }) {
  const Icon = TOAST_ICON[item.kind];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: 320,
        paddingTop: 11,
        paddingBottom: 11,
        paddingLeft: 13,
        paddingRight: 11,
        borderRadius: 13,
        background: 'var(--t-panel)',
        border: '1px solid var(--t-panel-border)',
        boxShadow: '0 18px 44px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.16)',
        backdropFilter: 'blur(28px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
        pointerEvents: 'auto',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <Icon size={16} strokeWidth={2.2} style={{ color: TOAST_TINT[item.kind], flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)', lineHeight: 1.4, whiteSpace: 'pre-line' }}>
        {item.message}
      </div>
    </div>
  );
}
