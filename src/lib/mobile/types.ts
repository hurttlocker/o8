import type {
  AgentSummary,
  EventSeverity,
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
} from '@/lib/fleet/types';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { CompactionTrigger } from '@/lib/runtimes/compaction-detector';

export type MobileInboxItemKind = 'alert' | 'approval' | 'review' | 'run_watch';

export type MobileControlActionKind =
  | 'inspect'
  | 'steer'
  | 'send'
  | 'approve'
  | 'deny'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'watch'
  | 'resolve'
  | 'launch'
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
  approvalId?: string;
  metadata?: Record<string, string>;
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
  /** Last commit message that touched this file (free — from git log) */
  commitSummary?: string;
  /** Commit author */
  commitAuthor?: string;
  /** Relative time of last commit */
  commitAge?: string;
}

export interface MobileInboxSnapshot {
  generatedAt: string;
  mode: 'live' | 'demo' | 'stale';
  sourceLabel: string;
  primarySessionKey?: string;
  note?: string;
  sessions: AgentSummary[];
  approvals: MobileApprovalCard[];
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

/**
 * Tool-call rendering class. The orchestrator chat tile picks a visual
 * weight per tool based on what that tool actually does to the world:
 *
 *   - `read`  — inspection only (Read, Grep, list_* MCP queries, read-only
 *               shell). Renders as a single-line chip, dim color. REPL vibe.
 *   - `write` — mutates state (Edit/Write, dispatch_mission, approve_*,
 *               side-effecting Bash). Renders as a bordered card with an
 *               amber left-accent and, when targeting a file, a
 *               "View in Changes" affordance that pivots the O8 panel.
 *   - `meta`  — ambient status pings (fleet status, health checks). One-line
 *               collapsed summary, even dimmer than reads.
 *
 * When unset, the chat falls back to the legacy unified card rendering.
 * See `src/components/desktop/thoughts/toolClassifier.ts`.
 */
export type ToolSideEffectClass = 'read' | 'write' | 'meta';

export interface MobileTranscriptToolLaunchLink {
  surfaceId: string;
  repoPath?: string | null;
  laneId?: string | null;
  branch?: string | null;
  worktreePath?: string | null;
  label: string;
}

export interface MobileTranscriptToolCall {
  id?: string | null;
  name: string;
  args?: Record<string, unknown>;
  status?: 'calling' | 'running' | 'done';
  preview?: string;
  result?: string;
  sideEffectClass?: ToolSideEffectClass;
  launchLink?: MobileTranscriptToolLaunchLink | null;
}

export interface MobileTranscriptSource {
  title: string;
  url?: string;
  path?: string;
  index?: number;
}

export interface MobileTranscriptThinkingStep {
  type: 'thinking' | 'tool' | 'search' | 'reading' | 'analyzing';
  label: string;
  description?: string;
  status: 'active' | 'complete' | 'pending';
  detail?: string;
}

export interface MobileTranscriptCommandChip {
  label: string;
  tone?: 'blue' | 'amber' | 'emerald' | 'slate' | 'red';
}

export interface BrainAnswerCitation {
  kind: string;
  rowId: string;
  excerpt: string;
  url?: string | null;
}

export interface MobileTranscriptCommand {
  name: string;
  summary: string;
  details?: string[];
  chips?: MobileTranscriptCommandChip[];
  /** Present on /ask command entries — the streamed Brain answer + citations. */
  brainAnswer?: {
    tokens: string;
    citations: BrainAnswerCitation[];
  };
}

// Shared transcript shape used across mobile history and runtime tails.
export interface MobileTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  pinned?: boolean;
  type?: 'message' | 'compaction' | 'command';
  media?: MobileTranscriptMedia[];
  toolCalls?: MobileTranscriptToolCall[];
  timestamp?: number;
  timestampLabel?: string;
  model?: string;
  tokens?: { input: number; output: number };
  costUsd?: number;
  sources?: MobileTranscriptSource[];
  thinking?: string;
  thinkingSteps?: MobileTranscriptThinkingStep[];
  thinkingDurationMs?: number;
  recalledFacts?: number;
  command?: MobileTranscriptCommand;
  compaction?: {
    timestamp: number;
    tokensBefore?: number;
    tokensAfter?: number;
    trigger: CompactionTrigger;
    source?: 'explicit' | 'summary' | 'inferred';
    summary?: string;
  };
}

export interface MobileRuntimeTailGroup {
  id: string;
  title: string;
  mode: 'launch' | 'resume';
  outcome: 'running' | 'finished' | 'interrupted' | 'failed';
  prompt: string;
  startedAt?: string;
  finishedAt?: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: MobileTranscriptEntry[];
}

export interface MobileHistoryResponse {
  sessionKey: string;
  transcript: MobileTranscriptEntry[];
  groups?: MobileRuntimeTailGroup[];
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
  action: Extract<MobileControlActionKind, 'send' | 'steer' | 'stop' | 'approve' | 'deny' | 'pause' | 'resume' | 'watch' | 'resolve' | 'launch'>;
  sessionKey: string;
  clientMutationId?: string;
  approvalId?: string;
  message?: string;
  attachments?: MobileActionAttachment[];
  runId?: string;
  cwd?: string;
}

export interface MobileActionResponse {
  ok: boolean;
  action: MobileActionRequest['action'];
  sessionKey: string;
  clientMutationId?: string;
  approvalId?: string;
  status: 'queued' | 'completed' | 'unavailable' | 'sent' | 'error';
  note: string;
  runId?: string;
  aborted?: boolean;
}

// ── Mobile orchestrator surface ──
//
// The mobile Orchestrator tab reads from /api/mobile/orchestrator/threads (a
// thin projection of ~/.o8/chat-history/thoughts-*.json) and subscribes to
// the existing `orchestrator` WS channel. These shapes are deliberately
// minimal — alpha is read-mostly with a single composer.

export type MobileOrchestratorRuntime = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'unknown';

export type MobileOrchestratorThreadStatus = 'idle' | 'ready' | 'busy';

export interface MobileOrchestratorThread {
  id: string;
  title: string;
  lastMessageAt: string;
  runtime: MobileOrchestratorRuntime;
  status: MobileOrchestratorThreadStatus;
  messageCount: number;
  repoPath: string | null;
  repoName: string | null;
  repoBranch: string | null;
}

export type MobileOrchestratorTranscriptRole = 'user' | 'assistant' | 'tool' | 'system';

export interface MobileOrchestratorTranscriptEntry {
  id: string;
  role: MobileOrchestratorTranscriptRole;
  text: string;
  thinking?: boolean;
  toolName?: string;
  /** Tool entries flip to true when the matching tool-result arrives. */
  toolDone?: boolean;
  /** Short preview of the tool's output (first line, truncated). */
  toolPreview?: string;
  timestamp: number;
  /** User entry waiting for a reconnect/replay (offline send queue). */
  queued?: boolean;
  /** Stable id matching the pending-queue entry — used for retry/discard. */
  queueId?: string;
  /** Queued >= 1h — UI shows Retry / Discard instead of auto-replaying. */
  queueStale?: boolean;
}
