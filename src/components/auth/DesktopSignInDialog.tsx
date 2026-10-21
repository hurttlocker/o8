'use client';

import { useEffect, useRef, useState } from 'react';
import { FloatingDialog } from '@/components/desktop/FloatingDialog';
import { RamsButton } from '@/components/desktop/settings/shared';
import { startDesktopSignIn } from '@/lib/auth/start-desktop-sign-in';
import { getDesktopAuthError, subscribeDesktopAuthError, type DesktopAuthError } from '@/lib/auth/desktop-auth-error';

/** The native session must return through the existing single-use browser handoff. */
export function DesktopSignInDialog({ onClose }: { onClose: () => void }) {
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<DesktopAuthError | null>(null);
  useEffect(() => subscribeDesktopAuthError(() => setError(getDesktopAuthError())), []);
  const glass = typeof document !== 'undefined' && (document.documentElement.dataset.surface === 'glass' || document.documentElement.dataset.workspaceGlass === 'true');
  return <FloatingDialog title="Sign in to o8" glass={glass} onClose={onClose}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 400, letterSpacing: '-0.2px' }}>Sign in to o8</h2>
      <button type="button" aria-label="Close sign-in" onClick={onClose} style={{ border: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', width: 28, height: 28, fontSize: 20 }}>×</button>
    </div>
    <p style={{ marginTop: 10, marginBottom: 22, color: 'var(--t-text-secondary)', fontSize: 13, fontWeight: 300, lineHeight: 1.55 }}>Continue securely in your browser. Choose any sign-in method available on your o8 account, then return here.</p>
    <RamsButton variant="primary" width="100%" busy={busy} onClick={() => {
      if (busyRef.current) return;
      busyRef.current = true; setError(null); setWaiting(true); setBusy(true);
      void startDesktopSignIn().finally(() => { busyRef.current = false; setBusy(false); });
    }}>{busy ? 'Opening sign-in…' : waiting && !error ? 'Reopen sign-in in browser' : 'Continue in browser'}</RamsButton>
    {error ? <p role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{error.message}</p> : waiting ? <p role="status" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Waiting for sign-in. o8 will connect automatically when you finish in the browser.</p> : null}
    <p style={{ marginTop: 20, marginBottom: 0, paddingTop: 16, borderTop: '1px solid var(--t-divider-subtle)', color: 'var(--t-text-muted)', fontSize: 10.5, fontWeight: 300, lineHeight: 1.5 }}>Secured by Clerk. Your plan is checked after sign-in. You can keep using your local workspace without an account.</p>
  </FloatingDialog>;
}
