import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export function generateMetadata(): Metadata {
  return {
    other: {
      'ws-token': getOrCreateWsToken(),
      'apple-mobile-web-app-capable': 'yes',
      'apple-mobile-web-app-status-bar-style': 'black-translucent',
    },
  };
}

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#111111',
        overflow: 'hidden',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: [
        'nextjs-portal{display:none!important}',
        '[data-nextjs-dialog-overlay]{display:none!important}',
        '::-webkit-scrollbar{width:3px}',
        '::-webkit-scrollbar-track{background:transparent}',
        '::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.12);border-radius:3px}',
        '::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,0.2)}',
      ].join('') }} />
      {children}
    </div>
  );
}
