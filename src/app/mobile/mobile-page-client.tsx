'use client';

import dynamic from 'next/dynamic';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

const MobileRemoteShell = dynamic(
  () => import('@/components/mobile-remote-shell').then((m) => ({ default: m.MobileRemoteShell })),
  { ssr: false },
);

export function MobilePageClient({ initialSnapshot }: { initialSnapshot: MobileInboxSnapshot }) {
  return (
    <MobileRemoteShell
      initialSnapshot={initialSnapshot}
      initialTranscript={undefined}
      initialReviewFile={undefined}
      initialOwnedReviewPacket={undefined}
    />
  );
}
