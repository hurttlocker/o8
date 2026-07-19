'use client';

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';

export default function NotFound() {
  const router = useRouter();
  const [returning, setReturning] = useState(false);

  const returnToDashboard = () => {
    if (returning) return;
    setReturning(true);
    if (window.history.length > 1) {
      router.back();
      return;
    }
    router.replace('/dashboard');
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--t-bg)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <header
        style={{
          minHeight: 42,
          display: 'flex',
          alignItems: 'center',
          paddingTop: 0,
          paddingRight: 16,
          paddingBottom: 0,
          paddingLeft: 16,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle)',
          color: 'var(--t-text-secondary)',
          WebkitAppRegion: 'drag' as unknown as string,
        } as CSSProperties}
      >
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.02em' }}>o8</span>
      </header>

      <section
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: 32,
          paddingRight: 24,
          paddingBottom: 32,
          paddingLeft: 24,
        }}
      >
        <div
          style={{
            width: 'min(440px, 100%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 14,
            paddingTop: 24,
            paddingRight: 24,
            paddingBottom: 24,
            paddingLeft: 24,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            borderRadius: 16,
            background: 'var(--t-bg-card)',
            boxShadow: 'var(--t-panel-shadow)',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 36,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              borderRadius: 10,
              color: 'var(--t-text-secondary)',
              background: 'var(--t-panel)',
            }}
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18 3 12l6-6" />
              <path d="M3 12h18" />
            </svg>
          </div>
          <div>
            <h1 style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 560, letterSpacing: '-0.025em' }}>
              This page isn’t available
            </h1>
            <p style={{ marginTop: 8, marginRight: 0, marginBottom: 0, marginLeft: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--t-text-muted)' }}>
              The link doesn’t point to an o8 surface. Return to the dashboard to continue in your workspace.
            </p>
          </div>
          <button
            type="button"
            disabled={returning}
            onClick={returnToDashboard}
            style={{
              minHeight: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 0,
              paddingRight: 16,
              paddingBottom: 0,
              paddingLeft: 16,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              borderRadius: 10,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 13,
              fontWeight: 520,
              cursor: returning ? 'default' : 'pointer',
              opacity: returning ? 0.62 : 1,
            }}
          >
            {returning ? 'Returning…' : 'Back to dashboard'}
          </button>
        </div>
      </section>
    </main>
  );
}
