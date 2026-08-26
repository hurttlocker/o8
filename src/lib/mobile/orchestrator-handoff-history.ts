import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ChatHistoryMessage } from './orchestrator-thread-projection';

export function createHandoffHistoryMarker(
  handoff: NonNullable<MobileTranscriptEntry['handoff']>,
  timestamp: number,
): ChatHistoryMessage {
  return {
    id: handoff.handoffId,
    role: 'system',
    content: `${handoff.from?.model ?? handoff.from?.backend ?? 'Unknown source'} handed off to ${handoff.to.model ?? handoff.to.backend}.`,
    type: 'handoff',
    handoff,
    timestamp,
  };
}

export function truncateBoundaryWithHandoff(messages: ChatHistoryMessage[], boundary: number): number {
  return messages[boundary - 1]?.type === 'handoff' ? boundary - 1 : boundary;
}
