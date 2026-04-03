import { getOrCreateWsToken } from '@/lib/ws-auth';
import { MobileApprovalsClient } from './mobile-approvals-client';

export const dynamic = 'force-dynamic';

interface PrefetchedApproval {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
}

async function fetchPendingApprovals(): Promise<PrefetchedApproval[]> {
  try {
    const port = process.env.PORT || '3001';
    const res = await fetch(`http://127.0.0.1:${port}/api/panel/approvals?status=pending`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return [];
    const data = await res.json() as { approvals?: PrefetchedApproval[] };
    return data.approvals ?? [];
  } catch {
    return [];
  }
}

export default async function MobilePage() {
  const approvals = await fetchPendingApprovals();
  const wsToken = getOrCreateWsToken();
  return (
    <>
      <meta name="ws-token" content={wsToken} />
      <MobileApprovalsClient initialApprovals={approvals} />
    </>
  );
}
