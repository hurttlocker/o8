import { Suspense } from 'react';
import { MobileRemoteShell } from '@/components/mobile-remote-shell';
import { ShimmerCard } from '@/components/mobile/ShimmerCard';
import { createMobileShellSnapshot, getMobileBootstrap } from '@/lib/render/bootstrap';

export const dynamic = 'force-dynamic';

function MobileRouteFallback() {
  const shell = createMobileShellSnapshot();

  return (
    <div className="mobile-wrap">
      <div className="announcement-bar">
        <span className="status-pill status-warning">shell-only</span>
        <span className="status-pill status-warning">warming</span>
        <span className="muted">{shell.note}</span>
      </div>
      <ShimmerCard />
      <ShimmerCard />
      <ShimmerCard />
    </div>
  );
}

async function MobileBootstrapView() {
  // budgetMs: 200 — don't block server render on slow runtime discovery.
  // Client hydrates the full session list via WebSocket after paint.
  const bootstrap = await getMobileBootstrap({ fresh: false, budgetMs: 200 });

  return (
    <>
      <div
        hidden
        data-cortex-bootstrap-marker="page"
        data-cortex-bootstrap-source={bootstrap.source}
        data-cortex-bootstrap-state={bootstrap.state}
        data-cortex-bootstrap-refreshed-at={bootstrap.refreshedAt ?? ''}
      />
      <MobileRemoteShell
        initialSnapshot={bootstrap.snapshot}
        initialTranscript={undefined}
        initialReviewFile={undefined}
        initialOwnedReviewPacket={undefined}
      />
    </>
  );
}

export default function MobilePage() {
  return (
    <Suspense fallback={<MobileRouteFallback />}>
      <MobileBootstrapView />
    </Suspense>
  );
}
