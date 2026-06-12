import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';

// Same ws-token injection as the dashboard layout — the canvas mounts real
// terminals over the desktop WebSocket, which requires the token in a meta
// tag (useDesktopWebSocket reads it from there).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function generateMetadata(): Metadata {
  return {
    other: {
      'ws-token': getOrCreateWsToken(),
    },
  };
}

export default function CanvasGlassLayout({ children }: { children: ReactNode }) {
  return children;
}
