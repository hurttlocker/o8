import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/agents/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { composeWorkspaceTranscriptWithPeers } from './WorkspaceTranscript';

function peer(sequence: number, timestamp: string): AgentMessage {
  return {
    schema: 'o8/agents.message-event/v1', kind: 'message', sequence,
    id: `message-${sequence}`, from: 'Nova', to: 'Sage', repo: '/repo',
    text: `Message ${sequence}`, refs: { laneId: null, packetId: null },
    delivery: 'poll', deliveryNote: null, timestamp,
  };
}

describe('split transcript agent exchanges', () => {
  it('places peer messages between agent turns by timestamp', () => {
    const entries: MobileTranscriptEntry[] = [
      { id: 'turn-1', role: 'assistant', text: 'Beginning', timestamp: 1_000 },
      { id: 'turn-2', role: 'assistant', text: 'Finished', timestamp: 3_000 },
    ];
    const items = composeWorkspaceTranscriptWithPeers(entries, [peer(1, new Date(2_000).toISOString())]);
    expect(items.map((item) => item.key)).toEqual(['turn-1', 'peer:message-1', 'turn-2']);
  });

  it('keeps a packet header ahead of timestamped turns', () => {
    const entries: MobileTranscriptEntry[] = [
      { id: 'turn-1', role: 'user', text: 'Review packet instructions', timestamp: 1_000 },
      { id: 'turn-2', role: 'assistant', text: 'Finished', timestamp: 3_000 },
    ];
    const items = composeWorkspaceTranscriptWithPeers(entries, [peer(1, new Date(2_000).toISOString())], {
      enabled: true,
      title: 'Review the contract',
    });
    expect(items.map((item) => item.key)).toEqual(['turn-1', 'peer:message-1', 'turn-2']);
    expect(items[0]?.kind).toBe('packet-header');
  });

  it('shows only the latest eight peer messages in the split view', () => {
    const messages = Array.from({ length: 10 }, (_, index) => peer(index + 1, new Date(index * 1_000).toISOString()));
    const items = composeWorkspaceTranscriptWithPeers([], messages.reverse());
    expect(items[0]).toEqual({ kind: 'earlier-peers', key: 'earlier-peers', count: 2 });
    expect(items.slice(1).map((item) => item.key)).toEqual(Array.from({ length: 8 }, (_, index) => `peer:message-${index + 3}`));
  });
});
