import { MobileRemoteShell } from '@/components/mobile-remote-shell';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';

export const dynamic = 'force-dynamic';

export default async function MobilePage() {
  const initialSnapshot = await getOpenClawFleetSnapshot();

  return <MobileRemoteShell initialSnapshot={initialSnapshot} />;
}
