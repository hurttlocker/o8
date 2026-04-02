'use client';

import dynamic from 'next/dynamic';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

// Client-only shell — no server-side bootstrap. Loads instantly, hydrates via WS.
const MobileRemoteShell = dynamic(
  () => import('@/components/mobile-remote-shell').then((m) => ({ default: m.MobileRemoteShell })),
  { ssr: false },
);

const EMPTY_SNAPSHOT: MobileInboxSnapshot = {
  generatedAt: new Date().toISOString(),
  mode: 'stale',
  sourceLabel: 'client-shell',
  note: 'Connecting...',
  sessions: [],
  approvals: [],
  items: [],
  summary: { alerts: 0, approvals: 0, reviewItems: 0, activeRuns: 0 },
};

export default function MobilePage() {
  return (
    <MobileRemoteShell
      initialSnapshot={EMPTY_SNAPSHOT}
      initialTranscript={undefined}
      initialReviewFile={undefined}
      initialOwnedReviewPacket={undefined}
    />
  );
}
