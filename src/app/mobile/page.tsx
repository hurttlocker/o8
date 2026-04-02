import { MobilePageClient } from './mobile-page-client';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';

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

export const dynamic = 'force-dynamic';

async function prefetchInbox(): Promise<MobileInboxSnapshot> {
  try {
    const port = process.env.PORT || '3001';
    const res = await fetch(`http://127.0.0.1:${port}/api/mobile/inbox`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      return await res.json() as MobileInboxSnapshot;
    }
  } catch {
    // Prefetch failure falls back to an empty snapshot and the client refresh path.
  }

  return EMPTY_SNAPSHOT;
}

export default async function MobilePage() {
  const snapshot = await prefetchInbox();
  return <MobilePageClient initialSnapshot={snapshot} />;
}
