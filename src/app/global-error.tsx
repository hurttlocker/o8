'use client';

import { useEffect } from 'react';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    document.documentElement.setAttribute('data-o8-mount-error', '1');
    console.error('[boot-gate] dashboard mount crashed: ' + (error?.stack || error?.message || String(error)));
  }, [error]);

  return (
    <html lang="en" style={{ background: 'var(--t-bg, #1c1c1e)' }}>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: 'var(--t-bg-gradient, var(--t-bg, #1c1c1e))',
          color: 'var(--t-text, #0f172a)',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <main
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <section
            style={{
              width: 'min(440px, 100%)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              padding: 18,
              borderRadius: 18,
              border: '1px solid var(--t-divider-subtle, #d8dee9)',
              background: 'var(--t-bg-card, var(--t-panel, #f8fafc))',
            }}
          >
            <strong style={{ fontSize: 16, lineHeight: 1.35, color: 'var(--t-text-strong, var(--t-text, #0f172a))' }}>
              o8 failed to mount
            </strong>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--t-text-muted, #64748b)' }}>
              The app caught a client-side render error before the dashboard could finish booting.
            </p>
            <button
              type="button"
              onClick={() => {
                document.documentElement.removeAttribute('data-o8-mount-error');
                reset();
              }}
              style={{
                alignSelf: 'flex-start',
                minHeight: 36,
                paddingTop: 0,
                paddingRight: 14,
                paddingBottom: 0,
                paddingLeft: 14,
                borderRadius: 10,
                border: '1px solid var(--t-divider-subtle, #cbd5e1)',
                background: 'var(--t-input-bg, var(--t-panel, #ffffff))',
                color: 'var(--t-text, #0f172a)',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 13,
                fontWeight: 650,
                cursor: 'pointer',
              }}
            >
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
