'use client';

import { useCallback } from 'react';
import { focusSwarmPacket, packetsForOrchestratorThread } from '@/components/desktop/thoughts/chat-panel/SwarmStatusCard';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/** Open the existing worker beside its parent chat. Navigation never dispatches. */
export function useWorkerCardFocus({ packets, threadId, openSession }: {
  packets: OrchestratorPacket[];
  threadId: string | null;
  openSession: (sessionKey: string, direction: 'horizontal' | 'vertical') => void;
}) {
  return useCallback((packet: OrchestratorPacket) => {
    const current = packetsForOrchestratorThread(packets, threadId).find(entry => entry.id === packet.id);
    if (!current) return;
    const sessionKey = current.lane?.sessionKey?.trim();
    if (sessionKey) {
      openSession(sessionKey, 'vertical');
      return;
    }
    // A lane may be published before its session. The existing navigation
    // resolver can find that binding without creating another worker.
    focusSwarmPacket(current);
  }, [openSession, packets, threadId]);
}
