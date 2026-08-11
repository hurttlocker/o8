import type { Lane } from '@/lib/lane/types';
import { probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';

/**
 * Fleet snapshots can temporarily omit an active owned worker. Before treating
 * that absence as completion, confirm the persisted runtime process is gone.
 */
export async function shouldDeferCompletionForLiveRuntime(lane: Lane): Promise<boolean> {
  return await probeLaneSessionAlive(lane) === true;
}
