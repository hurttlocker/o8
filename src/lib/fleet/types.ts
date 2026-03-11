export type AgentStatus =
  | 'idle'
  | 'running'
  | 'blocked'
  | 'waiting'
  | 'reviewing'
  | 'failed';

export type SquadStatus = 'healthy' | 'watching' | 'degraded' | 'blocked';

export type ApprovalStatus = 'none' | 'pending' | 'approved' | 'denied';

export type EventSeverity = 'info' | 'success' | 'warning' | 'critical';

export interface ContextPressure {
  usedPercent: number;
  trend: 'falling' | 'stable' | 'rising';
}

export interface CostSnapshot {
  sessionUsd: number;
  dailyUsd: number;
}

export interface AgentSummary {
  id: string;
  name: string;
  squadId: string;
  runtime: string;
  model: string;
  status: AgentStatus;
  currentTask: string;
  workspace: string;
  branch: string;
  sessionKey: string;
  approvalStatus: ApprovalStatus;
  lastEventAt: string;
  context: ContextPressure;
  cost: CostSnapshot;
  alerts: number;
}

export interface SquadSummary {
  id: string;
  name: string;
  status: SquadStatus;
  throughputLabel: string;
  blockers: number;
  alerts: number;
  budgetUsdToday: number;
  members: string[];
}

export interface ReviewArtifact {
  kind: 'diff' | 'pull_request' | 'doc' | 'screenshot' | 'run_log';
  title: string;
  href?: string;
  state: 'new' | 'reviewing' | 'approved';
}

export interface EventItem {
  id: string;
  agentId?: string;
  squadId?: string;
  severity: EventSeverity;
  title: string;
  detail: string;
  timestamp: string;
}

export interface FleetSnapshot {
  generatedAt: string;
  squads: SquadSummary[];
  agents: AgentSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
}
