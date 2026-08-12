'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';

type TransformAction = 'import' | 'checkpoint' | 'fork' | 'rewind';

interface TransformMutationBody {
  action: TransformAction;
  runtimeId: string;
  sessionKey: string;
  checkpointId?: string;
  expectedCatalogVersion: number;
  clientMutationId: string;
}

interface TransformState {
  capabilities: Record<TransformAction, { supported: boolean; reason?: string }>;
  catalogVersion: number;
  pendingTransform: {
    phase: 'provider_started';
    manualResolutionRequired: boolean;
  } | null;
  catalogSession: { ownership: string; provenance: string } | null;
  checkpoints: Array<{ id: string; createdAt: string }>;
}

interface SessionTransformMenuProps {
  runtimeId: string;
  sessionKey: string;
}

function transformUrl(runtimeId: string, sessionKey: string) {
  const params = new URLSearchParams({ runtimeId, sessionKey });
  return `/api/runtime/session-transform?${params.toString()}`;
}

function actionLabel(action: TransformAction) {
  if (action === 'import') return 'Add to o8';
  if (action === 'checkpoint') return 'Save checkpoint';
  if (action === 'fork') return 'Fork from checkpoint';
  return 'Continue from checkpoint';
}

export async function submitSessionTransform(
  body: TransformMutationBody,
  request: typeof fetch = fetch,
) {
  const serializedBody = JSON.stringify(body);
  const { response, payload } = await fetchCorrelatedActionReceipt<{
    ok?: boolean;
    note?: string;
    error?: string;
    inProgress?: boolean;
    status?: string;
  }>('/api/runtime/session-transform', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: serializedBody,
  }, { fetch: request });
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error ?? `Unable to ${body.action} session.`);
  }
  return payload;
}

export function SessionTransformMenu({ runtimeId, sessionKey }: SessionTransformMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<TransformState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<TransformAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [position, setPosition] = useState({ top: 0, right: 0 });

  const load = useCallback(async () => {
    const response = await fetch(transformUrl(runtimeId, sessionKey), { cache: 'no-store' });
    const payload = await response.json().catch(() => null) as (TransformState & { error?: string }) | null;
    if (!response.ok || !payload) throw new Error(payload?.error ?? 'Unable to read session controls.');
    setState(payload);
    return payload;
  }, [runtimeId, sessionKey]);

  useEffect(() => {
    let active = true;
    void load().catch(() => {
      if (active) setState(null);
    });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const run = useCallback(async (action: TransformAction) => {
    if (!state || busy) return;
    const checkpointId = action === 'fork' || action === 'rewind'
      ? state.checkpoints.at(-1)?.id
      : undefined;
    if ((action === 'fork' || action === 'rewind') && !checkpointId) {
      setMessage('Save a checkpoint first.');
      return;
    }
    setBusy(action);
    setMessage(null);
    try {
      const payload = await submitSessionTransform({
        action,
        runtimeId,
        sessionKey,
        checkpointId,
        expectedCatalogVersion: state.catalogVersion,
        clientMutationId: crypto.randomUUID(),
      });
      setMessage(payload?.note ?? `${actionLabel(action)} complete.`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `Unable to ${action} session.`);
    } finally {
      setBusy(null);
    }
  }, [busy, load, runtimeId, sessionKey, state]);

  const supported = state
    ? Object.values(state.capabilities).some((capability) => capability.supported)
    : false;
  if (!supported) return null;

  const actions: TransformAction[] = state?.catalogSession
    ? ['checkpoint', 'fork', 'rewind']
    : ['import'];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Session history controls"
        title="Session history"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setPosition({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
          setOpen((current) => !current);
        }}
        style={{
          width: 32,
          height: 32,
          borderRadius: 9,
          borderWidth: 0,
          background: open ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-secondary)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
          style={{
            position: 'fixed',
            top: position.top,
            right: position.right,
            width: 252,
            paddingTop: 6,
            paddingRight: 6,
            paddingBottom: 6,
            paddingLeft: 6,
            borderRadius: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            background: 'var(--t-bg-card)',
            boxShadow: 'var(--t-glass-shadow, 0 18px 38px rgba(15, 23, 42, 0.18))',
            zIndex: 260,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div style={{ paddingTop: 7, paddingRight: 10, paddingBottom: 6, paddingLeft: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>Session history</div>
            <div style={{ marginTop: 2, fontSize: 10.5, lineHeight: 1.35, color: 'var(--t-text-secondary)' }}>
              {state?.catalogSession
                ? state.pendingTransform
                  ? 'Provider outcome is unresolved. Inspect it before using session controls again.'
                  : `${state.catalogSession.ownership} ownership · ${state.checkpoints.length} checkpoint${state.checkpoints.length === 1 ? '' : 's'}`
                : 'Add this provider session without changing ownership.'}
            </div>
          </div>
          {actions.map((action) => {
            const unavailable = Boolean(state?.pendingTransform)
              || !state?.capabilities[action].supported
              || ((action === 'fork' || action === 'rewind') && state.checkpoints.length === 0);
            return (
              <button
                key={action}
                type="button"
                role="menuitem"
                disabled={unavailable || busy !== null}
                onClick={() => void run(action)}
                style={{
                  width: '100%',
                  minHeight: 44,
                  paddingTop: 8,
                  paddingRight: 10,
                  paddingBottom: 8,
                  paddingLeft: 10,
                  borderRadius: 10,
                  borderWidth: 0,
                  background: 'transparent',
                  color: unavailable ? 'var(--t-text-faint)' : 'var(--t-text)',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  cursor: unavailable ? 'not-allowed' : 'pointer',
                }}
                onMouseEnter={(event) => { if (!unavailable) event.currentTarget.style.background = 'var(--t-panel)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                {busy === action ? 'Working…' : actionLabel(action)}
              </button>
            );
          })}
          {message ? (
            <div role="status" style={{ paddingTop: 7, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-divider-subtle)', color: 'var(--t-text-secondary)', fontSize: 10.5, lineHeight: 1.4 }}>
              {message}
            </div>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
