import type { Lane } from '@/lib/lane/types';
import type { MergePacketResult } from './types';
import {
  withWorkspaceMaterializedMutation,
  WorkspaceMutationUnavailableError,
} from '@/lib/workspace/mutation-materialization-guard';

/** Hold durable materialization truth through the entire packet merge publication. */
export async function withPacketMergeWorkspace(
  lane: Lane,
  operation: () => Promise<MergePacketResult>,
): Promise<MergePacketResult> {
  try {
    return await withWorkspaceMaterializedMutation(lane, operation);
  } catch (error) {
    if (error instanceof WorkspaceMutationUnavailableError) {
      return { merged: false, note: error.message, reason: error.code };
    }
    throw error;
  }
}
