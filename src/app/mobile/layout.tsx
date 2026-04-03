import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
    other: {
      'ws-token': getOrCreateWsToken(),
      'apple-mobile-web-app-capable': 'yes',
      'apple-mobile-web-app-status-bar-style': 'black-translucent',
    },
  };
}

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: '100dvh', backgroundColor: '#111111' }}>
      {children}
    </div>
  );
}
