'use client';

import { useState } from 'react';

import { X } from './lucide-shims';
import { clearDesktopAuthError, type DesktopAuthError } from '@/lib/auth/desktop-auth-error';

const FONT = 'var(--font-sans-system)';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';

export function SignInErrorCard({ authError }: { authError: DesktopAuthError }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <div
      role="status"
      style={{
        display: 'grid',
        gap: 7,
        margin: '1px 0 2px',
        padding: '9px 8px',
        borderRadius: 12,
        border: '1px solid var(--t-danger-border, var(--t-panel-border))',
        background: 'var(--t-danger-bg, var(--t-bg-card))',
        color: TEXT,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          aria-expanded={detailsOpen}
          style={{
            flex: 1,
            minHeight: 44,
            border: 0,
            padding: 0,
            background: 'transparent',
            color: TEXT,
            cursor: 'pointer',
            display: 'grid',
            gap: 2,
            textAlign: 'left',
            fontFamily: FONT,
          }}
        >
          <span style={{ fontSize: 12.5, lineHeight: 1.25, fontWeight: 420, letterSpacing: 0 }}>
            Sign-in didn&apos;t complete — try again
          </span>
          <span style={{ color: MUTED, fontSize: 10.5, lineHeight: 1.25, fontWeight: 300, letterSpacing: 0 }}>
            {detailsOpen ? 'Hide reason' : 'Show reason'}
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss sign-in error"
          onClick={clearDesktopAuthError}
          style={{
            width: 44,
            height: 44,
            border: 0,
            borderRadius: 10,
            background: 'transparent',
            color: MUTED,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>
      {detailsOpen ? (
        <div
          style={{
            color: MUTED,
            fontSize: 11,
            lineHeight: 1.35,
            overflowWrap: 'anywhere',
          }}
        >
          {authError.message}
        </div>
      ) : null}
    </div>
  );
}
