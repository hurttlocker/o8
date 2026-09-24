import { describe, expect, it } from 'vitest';
import type { AgentMessage, AgentPresence } from '@/lib/agents/types';
import { selectPeerMessages } from './useAgentPeerMessages';

const self: AgentPresence = {
  agentId: 'session:codex:one', name: 'Nova', repo: '/repo/one',
  worktreePath: null, runtime: 'codex', sessionKey: 'codex:one',
  laneId: null, packetId: null, lastSeen: new Date().toISOString(),
};

function message(id: string, from: string, to: string, repo = self.repo): AgentMessage {
  return {
    schema: 'o8/agents.message-event/v1', kind: 'message', sequence: 1,
    id, from, to, repo, text: id, refs: { laneId: null, packetId: null },
    delivery: 'poll', deliveryNote: null, timestamp: new Date().toISOString(),
  };
}

describe('agent peer message selection', () => {
  it('includes both directions for the exact repo and codename', () => {
    expect(selectPeerMessages([
      message('received', 'Sage', 'Nova'),
      message('sent', 'Nova', 'Sage'),
      message('other', 'Sage', 'Comet'),
      message('other-repo', 'Sage', 'Nova', '/repo/two'),
    ], self).map((entry) => entry.id)).toEqual(['received', 'sent']);
  });
});
