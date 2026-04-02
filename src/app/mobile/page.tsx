'use client';

import dynamic from 'next/dynamic';

// Client-only shell — no server-side bootstrap. Loads instantly, hydrates via WS.
const MobileRemoteShell = dynamic(
  () => import('@/components/mobile-remote-shell').then((m) => ({ default: m.MobileRemoteShell })),
  { ssr: false },
);

export default function MobilePage() {
  return (
    <MobileRemoteShell
      initialSnapshot={undefined as never}
      initialTranscript={undefined}
      initialReviewFile={undefined}
      initialOwnedReviewPacket={undefined}
    />
  );
}
