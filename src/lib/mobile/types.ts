import type {
  AgentSummary,
  EventSeverity,
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
} from '@/lib/fleet/types';

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

export interface MobileReviewFocus {
  repoSlug: string;
  branch: string;
  desktopHref: string;
  pullRequest?: ReviewPullRequestSummary;
  issues: ReviewIssueSummary[];
  changedFiles: ReviewChangedFile[];
  diffStat?: string;
}

export interface MobileReviewFileDetail {
  path: string;
  status: ReviewChangedFile['status'];
  additions?: number | null;
  deletions?: number | null;
  originalPath?: string;
  currentPath?: string;
  note: string;
  preview: string;
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
  review?: MobileReviewFocus;
}

export type MobileTranscriptMediaKind = 'image' | 'pdf' | 'file';

export interface MobileTranscriptMedia {
  kind: MobileTranscriptMediaKind;
  path: string;
  name: string;
  mimeType?: string;
}

export interface MobileTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  media?: MobileTranscriptMedia[];
  timestamp?: number;
  timestampLabel?: string;
}

export interface MobileHistoryResponse {
  sessionKey: string;
  transcript: MobileTranscriptEntry[];
}

export interface MobileReviewFileResponse {
  file: MobileReviewFileDetail;
}

export interface MobileActionAttachment {
  type?: string;
  mimeType: string;
  fileName: string;
  content: string;
}

export interface MobileActionRequest {
  action: Extract<MobileControlActionKind, 'steer' | 'stop' | 'approve' | 'deny' | 'pause' | 'resume'>;
  sessionKey: string;
  message?: string;
  attachments?: MobileActionAttachment[];
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
