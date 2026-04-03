import packageJson from '../../../package.json';
import { ThemeProvider } from '@/lib/theme/context';
import { MobileApprovalsClient } from './mobile-approvals-client';

export const dynamic = 'force-dynamic';

interface PrefetchedApproval {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  source?: 'llm-chat' | 'runtime' | 'test';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
  continuation?: { kind: 'llm-chat' | 'runtime' | 'lane' };
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
  const buildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? '';
  const appVersion = buildRevision
    ? `${packageJson.version} (${buildRevision.slice(0, 7)})`
    : packageJson.version;
  return (
    <ThemeProvider>
      <MobileApprovalsClient initialApprovals={approvals} appVersion={appVersion} />
    </ThemeProvider>
  );
}
