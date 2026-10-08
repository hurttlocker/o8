import { setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { persistCapturedCompletionHandoff } from '@/lib/orchestrator/completion-handoff';
import { outcomeFromPacketSelfReview } from '@/lib/orchestrator/context-relay-outcome';
import type { PacketContext } from '@/lib/orchestrator/types';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import type { createCompletionTurnGuard } from './completion-turn';

/** Publish under the same fresh owner guard as the accepted silent-exit transition. */
export async function acceptSilentExitCompletion(lane: Lane, commitSubject: string,
  status: 'reviewing' | 'completed', label: string, guard: ReturnType<typeof createCompletionTurnGuard>, expectedHead?: string | null): Promise<void> {
  let context: PacketContext | null = null;
  if (lane.packetId && lane.sessionKey) {
    try {
      context = await guard.wait(async () => {
        const { capturePacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
        guard.check();
        return capturePacketCompletionContext(lane.packetId!, lane.sessionKey!, { fallbackSummary: commitSubject });
      });
    } catch (error) {
      guard.check();
      // Managed registered completions must refuse unsafe capture. Preserve the
      // existing summary fallback for legacy/transient lanes without that owner.
      if (lane.ownership === 'managed' && await guard.wait(() => findRepoByLocalPath(lane.repoPath))) throw error;
      console.warn(`[silent-exit] Failed to capture completion context for lane ${lane.id}:`, error);
    }
  }
  await withLockedState(async (mission) => {
    guard.check();
    if (expectedHead && context?.headSha && context.headSha !== expectedHead) {
      throw new Error('Silent-exit source changed after merge ancestry acceptance.');
    }
    if (context) await persistCapturedCompletionHandoff(context,
      status === 'completed' ? 'already_merged' : outcomeFromPacketSelfReview(context.selfReview), guard.check, status);
    guard.check();
    const summary = context?.selfReview?.outcome?.trim() || context?.summary.trim() || commitSubject;
    const packet = mission.packets.find((candidate) => candidate.id === lane.packetId);
    if (packet && summary) packet.completionSummary = summary.slice(0, 1_200);
    setLaneStatus(lane.id, status, 'system', label);
  });
}
