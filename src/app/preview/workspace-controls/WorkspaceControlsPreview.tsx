'use client';
import { useState } from 'react';
import { DesktopSignInDialog } from '@/components/auth/DesktopSignInDialog';
import { ThemeProvider } from '@/lib/theme/context';

/** Development-only signed-out presentation, without ending the real session. */
export function WorkspaceControlsPreview() {
  const [open, setOpen] = useState(true);
  return <ThemeProvider>
    <div style={{ minHeight: '100vh', padding: 32, boxSizing: 'border-box', background: 'var(--t-canvas-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
      <h1 style={{ fontSize: 18, fontWeight: 400 }}>Account entry</h1>
      <p style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Development preview of the native signed-out dialog. Your current account stays signed in.</p>
      <button type="button" onClick={() => setOpen(true)} style={{ paddingTop: 8, paddingBottom: 8, paddingLeft: 14, paddingRight: 14, border: '1px solid var(--t-border)', borderRadius: 10, color: 'var(--t-accent)', background: 'var(--t-input-bg)', cursor: 'pointer' }}>Show sign-in dialog</button>
      {open ? <DesktopSignInDialog onClose={() => setOpen(false)} /> : null}
    </div>
  </ThemeProvider>;
}
