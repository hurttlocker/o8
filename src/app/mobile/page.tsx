import { MobileRemoteShell } from '@/components/mobile-remote-shell';
import { getMobileInboxSnapshot } from '@/lib/mobile/openclaw';

export const dynamic = 'force-dynamic';

export default async function MobilePage() {
  const initialSnapshot = await getMobileInboxSnapshot();

  return <MobileRemoteShell initialSnapshot={initialSnapshot} />;
}
