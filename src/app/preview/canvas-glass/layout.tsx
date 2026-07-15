import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { DictationHost } from '@/components/desktop/dictation/DictationHost';
import { ApiBearerBootstrap } from '@/components/security/ApiBearerBootstrap';

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
  // DictationHost provides the push-to-talk context the canvas composers'
  // mic buttons plug into — same engine the default IDE composer uses. It
  // also renders the dictation pill overlay anchored to the active composer.
  return <><ApiBearerBootstrap source="meta" /><DictationHost>{children}</DictationHost></>;
}
