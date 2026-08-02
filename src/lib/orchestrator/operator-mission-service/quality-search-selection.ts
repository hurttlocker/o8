import { collectQualitySearchCandidateEvidence } from '@/lib/orchestrator/quality-search-evidence';
import {
  selectQualitySearchCandidate,
  type QualitySearchSelectionReceipt,
} from '@/lib/orchestrator/quality-search';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

interface QualitySearchTerminalResult {
  merged: false;
  note: string;
  reason: 'quality_search_repair' | 'quality_search_hold';
  qualitySearch: QualitySearchSelectionReceipt;
}

export type QualitySearchComparisonResolution = {
  enabled: false;
  winner: OrchestratorPacket;
  receipt: null;
  terminalResult: null;
} | {
  enabled: true;
  winner: OrchestratorPacket;
  receipt: QualitySearchSelectionReceipt;
  terminalResult: QualitySearchTerminalResult | null;
};

export function attachQualitySearchReceipt(
  packet: OrchestratorPacket,
  receipt: QualitySearchSelectionReceipt | null,
): void {
  if (receipt && packet.qualitySearch) packet.qualitySearch.receipt = receipt;
}

export async function ensureComparisonWinnerReview(qualitySearch: boolean, packetId: string): Promise<void> {
  if (qualitySearch) return;
  const { submitPacketReview } = await import('./review');
  try {
    await submitPacketReview({ packetId, findings: [], approved: true });
  } catch (error) {
    console.error('[comparison-pick] winner review record failed:', error);
  }
}

function isQualitySearchGroup(packets: OrchestratorPacket[]): boolean {
  return packets.length === 2 && packets.every((packet) => (
    packet.qualitySearch?.version === 1
    && (packet.qualitySearch.role === 'minimal_complete' || packet.qualitySearch.role === 'robustness_complete')
  ));
}

export async function resolveQualitySearchComparison(input: {
  comparisonPackets: OrchestratorPacket[];
  comparisonGroupId: string;
  requestedWinner: OrchestratorPacket;
}): Promise<QualitySearchComparisonResolution> {
  if (!isQualitySearchGroup(input.comparisonPackets)) {
    return { enabled: false, winner: input.requestedWinner, receipt: null, terminalResult: null };
  }

  const candidates = await Promise.all(input.comparisonPackets.map(collectQualitySearchCandidateEvidence));
  const repairAttempts = Math.max(...input.comparisonPackets.map((packet) => packet.qualitySearch?.repairAttempts ?? 0));
  const selection = selectQualitySearchCandidate({ candidates, repairAttempts });
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  await withLockedState(async (current) => {
    for (const packet of current.packets) {
      if (packet.comparisonGroupId !== input.comparisonGroupId || !packet.qualitySearch) continue;
      packet.qualitySearch.receipt = selection.receipt;
      if (selection.outcome === 'repair') packet.qualitySearch.repairAttempts = 1;
    }
  });

  if (selection.outcome === 'repair' && selection.repairPacketId) {
    const repairEvidence = candidates.find((candidate) => candidate.packetId === selection.repairPacketId);
    const blockers = repairEvidence?.failedChecks.length
      ? repairEvidence.failedChecks.join(', ')
      : 'contract or review evidence did not clear';
    const { rerunWithFeedback } = await import('./rerun-with-feedback');
    const repair = await rerunWithFeedback({
      packetId: selection.repairPacketId,
      feedback: [
        'Targeted quality-search repair. Keep the sealed task contract and the assigned candidate role unchanged.',
        `Address only the evidence that failed: ${blockers}.`,
        'Re-run the contract-specific production-path verification. Do not broaden scope or add speculative architecture.',
      ].join('\n'),
    });
    return {
      enabled: true,
      winner: input.requestedWinner,
      receipt: selection.receipt,
      terminalResult: {
        merged: false,
        note: `${selection.receipt.reason} ${repair.note}`,
        reason: 'quality_search_repair',
        qualitySearch: selection.receipt,
      },
    };
  }
  if (selection.outcome !== 'selected' || !selection.selectedPacketId) {
    return {
      enabled: true,
      winner: input.requestedWinner,
      receipt: selection.receipt,
      terminalResult: {
        merged: false,
        note: selection.receipt.reason,
        reason: 'quality_search_hold',
        qualitySearch: selection.receipt,
      },
    };
  }
  const winner = input.comparisonPackets.find((packet) => packet.id === selection.selectedPacketId);
  if (!winner) {
    throw new Error(`Quality-search selection referenced missing packet ${selection.selectedPacketId}.`);
  }
  return { enabled: true, winner, receipt: selection.receipt, terminalResult: null };
}
