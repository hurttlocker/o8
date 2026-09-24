export interface AgentPresence {
  agentId: string;
  name: string;
  repo: string;
  worktreePath: string | null;
  runtime: string;
  sessionKey: string | null;
  laneId: string | null;
  packetId: string | null;
  lastSeen: string;
}

export interface AgentMessageRefs {
  laneId: string | null;
  packetId: string | null;
}

export interface AgentConversationReceipt {
  id: string;
  replyToId: string | null;
  turnIndex: number;
  turnLimit: number;
  remainingTurns: number;
  status: 'open' | 'closed';
  closedReason: string | null;
  lastMessageId: string;
}

export interface AgentMessage {
  schema: 'o8/agents.message-event/v1';
  kind: 'message';
  sequence: number;
  id: string;
  from: string;
  to: string;
  repo: string;
  text: string;
  refs: AgentMessageRefs;
  /** Missing on older, unthreaded messages. */
  conversation?: AgentConversationReceipt | null;
  delivery: 'native' | 'poll' | 'failed';
  deliveryNote: string | null;
  timestamp: string;
}
