import type { AgentSummary, EventSeverity } from '@/lib/fleet/types';

export type MobileInboxItemKind = 'alert' | 'approval' | 'review' | 'run_watch';

export type MobileControlActionKind =
  | 'inspect'
  | 'steer'
  | 'approve'
  | 'deny'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'open_review'
  | 'open_desktop';

export interface MobileControlAction {
  kind: MobileControlActionKind;
  label: string;
  sessionKey?: string;
  href?: string;
  destructive?: boolean;
  available: boolean;
  reasonUnavailable?: string;
}

export interface MobileInboxItem {
  id: string;
  kind: MobileInboxItemKind;
  severity: EventSeverity;
  title: string;
  detail: string;
  sessionKey?: string;
  timestampLabel?: string;
  actions: MobileControlAction[];
}

export interface MobileInboxSummary {
  alerts: number;
  approvals: number;
  reviewItems: number;
  activeRuns: number;
}

export interface MobileInboxSnapshot {
  generatedAt: string;
  mode: 'live' | 'demo';
  sourceLabel: string;
  primarySessionKey?: string;
  note?: string;
  sessions: AgentSummary[];
  items: MobileInboxItem[];
  summary: MobileInboxSummary;
}

export interface MobileTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  timestamp?: number;
  timestampLabel?: string;
}

export interface MobileHistoryResponse {
  sessionKey: string;
  transcript: MobileTranscriptEntry[];
}

export interface MobileActionRequest {
  action: Extract<MobileControlActionKind, 'steer' | 'stop' | 'approve' | 'deny' | 'pause' | 'resume'>;
  sessionKey: string;
  message?: string;
  runId?: string;
}

export interface MobileActionResponse {
  ok: boolean;
  action: MobileActionRequest['action'];
  sessionKey: string;
  status: 'queued' | 'completed' | 'unavailable';
  note: string;
  runId?: string;
  aborted?: boolean;
}
