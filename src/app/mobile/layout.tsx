import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  // Only embed the ws-token for loopback page loads (desktop webview, dev).
  // Serving it in HTML to any LAN browser hands out the master credential —
  // LAN clients get the token from the pairing QR / #tk= link instead
  // (see getMobileWsToken in @/lib/mobile/ws-token-client).
  const h = await headers();
  const isLocal = headersIndicateLoopback((name) => h.get(name));
  return {
    other: {
      ...(isLocal ? { 'ws-token': getOrCreateWsToken() } : {}),
      'apple-mobile-web-app-capable': 'yes',
      'apple-mobile-web-app-status-bar-style': 'black-translucent',
    },
  };
}

export default function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ApiBearerBootstrap source="mobile" />
      <style dangerouslySetInnerHTML={{ __html: 'html,body,#__next{margin:0;padding:0;width:100%;height:100%;min-height:100dvh;overflow:hidden;background:#111111;overscroll-behavior:none}nextjs-portal,[data-nextjs-dialog-overlay]{display:none!important}' }} />
      <div
        style={{
          width: '100%',
          height: '100dvh',
          minHeight: '100dvh',
          maxHeight: '100dvh',
          overflow: 'hidden',
          position: 'relative',
          background: '#111111',
        }}
      >
        {children}
      </div>
    </>
  );
}
