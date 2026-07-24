'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { mobileFontFamily } from './mobile-approvals-shared';

type MobileAccessState = 'checking' | 'paired' | 'unpaired';

export function MobileAccessBoundary({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MobileAccessState>('checking');

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setState(getMobileWsToken() ? 'paired' : 'unpaired');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'paired') return children;

  return (
    <main
      style={{
        minHeight: '100dvh',
        backgroundColor: 'var(--t-panel-solid)',
        color: 'var(--t-text)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 'max(env(safe-area-inset-top, 0px), 24px)',
        paddingRight: 24,
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 24px)',
        paddingLeft: 24,
        fontFamily: mobileFontFamily(),
        textAlign: 'center',
      }}
    >
      <div style={{ width: '100%', maxWidth: 360 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 800,
            letterSpacing: '-0.02em',
            marginBottom: 10,
          }}
        >
          {state === 'checking' ? 'Checking pairing…' : 'Pair this browser with o8'}
        </div>
        <div
          style={{
            color: 'var(--t-text-muted)',
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          {state === 'checking'
            ? 'Confirming access to the local operator.'
            : 'Open Settings > Mobile in the o8 desktop app, choose Copy browser pairing link, then open it on this device.'}
        </div>
      </div>
    </main>
  );
}
