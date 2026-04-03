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
    <>
      <style dangerouslySetInnerHTML={{ __html: 'html,body,#__next{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#111111}nextjs-portal,[data-nextjs-dialog-overlay]{display:none!important}' }} />
      <div
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <MobileAuroraBg />
        {children}
      </div>
    </>
  );
}
