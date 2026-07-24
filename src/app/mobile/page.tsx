import os from 'node:os';
import packageJson from '../../../package.json';
import { ThemeProvider } from '@/lib/theme/context';
import { MobileAccessBoundary } from './mobile-access-boundary';
import { MobileApprovalsClient } from './mobile-approvals-client';

export const dynamic = 'force-dynamic';

function readHostnameLabel(): string {
  try {
    const raw = os.hostname();
    if (!raw) return 'this device';
    const stripped = raw.replace(/\.local$/i, '').trim();
    return stripped || 'this device';
  } catch {
    return 'this device';
  }
}

export default function MobilePage() {
  const buildRevision = process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA
    ?? process.env.GIT_COMMIT_SHA
    ?? '';
  const appVersion = buildRevision
    ? `${packageJson.version} (${buildRevision.slice(0, 7)})`
    : packageJson.version;
  const hostnameLabel = readHostnameLabel();
  return (
    <ThemeProvider>
      <MobileAccessBoundary>
        <MobileApprovalsClient
          initialApprovals={[]}
          appVersion={appVersion}
          hostnameLabel={hostnameLabel}
        />
      </MobileAccessBoundary>
    </ThemeProvider>
  );
}
