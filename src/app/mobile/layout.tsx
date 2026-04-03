import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { MobileAuroraBg } from './mobile-aurora-bg';

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
        inset: 0,
        height: '100dvh',
        backgroundColor: 'var(--t-canvas-bg, #111111)',
        overflow: 'hidden',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: [
        'nextjs-portal{display:none!important}',
        '[data-nextjs-dialog-overlay]{display:none!important}',
        '::-webkit-scrollbar{width:3px}',
        '::-webkit-scrollbar-track{background:transparent}',
        '::-webkit-scrollbar-thumb{background:var(--t-divider-strong, rgba(255,255,255,0.12));border-radius:3px}',
        '::-webkit-scrollbar-thumb:hover{background:var(--t-border, rgba(255,255,255,0.2))}',
      ].join('') }} />
      <MobileAuroraBg />
      {children}
    </div>
  );
}
