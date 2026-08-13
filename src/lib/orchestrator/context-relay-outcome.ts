import type { PacketContext } from '@/lib/orchestrator/types';

export function outcomeFromPacketSelfReview(
  selfReview: PacketContext['selfReview'],
): 'succeeded' | 'failed' | 'partial' {
  if (selfReview?.passed === true) {
    if (selfReview.decision === 'finding_ready') {
      const findingComplete = Boolean(selfReview.outcome?.trim())
        && Boolean(selfReview.evidence?.some((entry) => entry.trim()))
        && Boolean(selfReview.residual?.trim());
      return findingComplete ? 'succeeded' : 'partial';
    }
    return 'succeeded';
  }
  if (selfReview?.decision === 'blocked') {
    return 'failed';
  }
  return 'partial';
}
