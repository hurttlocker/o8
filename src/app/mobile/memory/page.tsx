import packageJson from '../../../../package.json';
import { ThemeProvider } from '@/lib/theme/context';
import { MobileApprovalsClient } from '../mobile-approvals-client';

export const dynamic = 'force-dynamic';

export default function MobileMemoryPage() {
  const buildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? '';
  const appVersion = buildRevision
    ? `${packageJson.version} (${buildRevision.slice(0, 7)})`
    : packageJson.version;
  return (
    <ThemeProvider>
      <MobileApprovalsClient initialApprovals={[]} appVersion={appVersion} initialView="memory" />
    </ThemeProvider>
  );
}
