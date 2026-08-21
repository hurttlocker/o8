export const BROADCAST_EVENT_KINDS = [
  'session_launched',
  'progress',
  'brain_consulted',
  'lease_acquired',
  'lease_released',
  'lease_timeout',
  'review_verdict',
  'merge',
  'approval',
  'agent_completed',
  'message',
  'commentary',
  'conversation',
  'focus',
] as const;

export type BroadcastEventKind = (typeof BROADCAST_EVENT_KINDS)[number];

export interface BroadcastEvent {
  schema: 'o8/broadcast.event/v1';
  id: string;
  source: 'lane' | 'lease' | 'approval' | 'broadcast';
  kind: BroadcastEventKind;
  laneId: string | null;
  packetId: string | null;
  repo: string | null;
  actor: string;
  title: string;
  detail: string | null;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface BroadcastEventPage {
  schema: 'o8/broadcast.events/v1';
  events: BroadcastEvent[];
  cursor: string | null;
  hasMore: boolean;
}

export interface BroadcastLaneSnapshot {
  id: string;
  packetId: string | null;
  repo: string;
  label: string;
  runtime: string;
  status: string;
  lastEventAt: string | null;
  lastEventLabel: string | null;
}

export interface BroadcastPacketSnapshot {
  id: string;
  title: string;
  status: string;
  queueState: string;
  releaseState: string;
  laneId: string | null;
}

export interface BroadcastAgentSnapshot {
  laneId: string;
  packetId: string | null;
  label: string;
  repo: string;
  runtime: string;
  status: string;
  startedAt: string;
}

export interface BroadcastApprovalSnapshot {
  id: string;
  laneId: string | null;
  packetId: string | null;
  title: string;
  risk: string;
  createdAt: string;
}

export interface BroadcastFocusSnapshot {
  title: string;
  goal: string | null;
  issue: number | null;
  startedAt: string;
}

export interface BroadcastSnapshot {
  schema: 'o8/broadcast.snapshot/v1';
  generatedAt: string;
  lanes: BroadcastLaneSnapshot[];
  packets: BroadcastPacketSnapshot[];
  activeAgents: BroadcastAgentSnapshot[];
  pendingApprovals: {
    count: number;
    items: BroadcastApprovalSnapshot[];
  };
  focus: BroadcastFocusSnapshot | null;
  recentEvents: BroadcastEvent[];
  cursor: string | null;
}
