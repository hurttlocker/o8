import type { FleetSnapshot } from '@/lib/fleet/types';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';

export async function getRuntimeInventorySnapshot(): Promise<FleetSnapshot> {
  return getOpenClawFleetSnapshot();
}
