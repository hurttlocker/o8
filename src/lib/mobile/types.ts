import type {
  AgentSummary,
  EventSeverity,
  ReviewChangedFile,
  ReviewIssueSummary,
  ReviewPullRequestSummary,
} from '@/lib/fleet/types';
import type { MobileApprovalCard } from '@/lib/approvals/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorPacketRecovery } from '@/lib/orchestrator/types';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';
import type { CompactionTrigger } from '@/lib/runtimes/compaction-detector';

export type MobileInboxItemKind = 'alert' | 'approval' | 'review' | 'run_watch';
export type MobileAgentStatus = 'queued' | 'running' | 'huddling' | 'awaiting_review' | 'merged' | 'failed';

export type MobileControlActionKind =
  | 'inspect'
  | 'steer'
  | 'send'
  | 'approve'
  | 'request_changes'
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
  agentStatus?: MobileAgentStatus;
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
  inspectOnlyReviews?: number;
  activeRuns: number;
}

export type MobileFleetRuntime = OrchestratorRuntime | 'openclaw' | 'hermes' | 'unknown';
export type MobileFleetStatus =
  | 'queued'
  | 'running'
  | 'huddling'
  | 'paused'
  | 'stopped'
  | 'blocked'
  | 'awaiting_review'
  | 'needs_merge'
  | 'merged'
  | 'failed'
  | 'idle';
export type MobileFleetAction =
  | 'inspect'
  | 'open_terminal'
  | 'open_preview'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'approve'
  | 'request_changes'
  | 'merge';

export interface MobileFleetSession {
  id: string;
  sessionKey: string;
  runtime: MobileFleetRuntime;
  runtimeLabel: string;
  runtimeAccent: string;
  status: MobileFleetStatus;
  title: string;
  repo: string;
  repoPath: string;
  branch: string;
  worktreePath?: string | null;
  terminalSessionName?: string | null;
  terminalAvailable?: boolean;
  previewUrl?: string | null;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  approvalId?: string;
  reviewAuthority?: 'approval_gate' | 'inspect_only' | null;
  actions: MobileFleetAction[];
  lastEventAt?: string | null;
  lastActivityAt?: number | null;
  /** Worker-posted implementation plan while status is `huddling`. */
  huddlePlan?: string;
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

export interface MobileReviewUnit {
  id: string;
  sessionKey: string;
  approvalId?: string;
  authority: 'approval_gate' | 'inspect_only';
  status: 'awaiting_review' | 'running' | 'blocked' | 'failed' | 'merged' | 'stale';
  title: string;
  agent: string;
  runtime: string;
  repo: string;
  repoSlug?: string;
  repoPath: string;
  branch: string;
  baseBranch?: string;
  baseSha?: string;
  headSha?: string;
  worktreePath?: string;
  changedFiles: ReviewChangedFile[];
  fileCount: number;
  additions: number;
  deletions: number;
  diffAvailable: boolean;
  previewUrl?: string | null;
  terminalSessionName?: string | null;
  actions: Array<'inspect' | 'comment' | 'approve' | 'request_changes' | 'deny' | 'steer' | 'stop'>;
  staleReason?: string;
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
  fleetSessions: MobileFleetSession[];
  approvals: MobileApprovalCard[];
  reviewUnits: MobileReviewUnit[];
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

/** One titled source the Brain cited in a cortex_ask answer (Fable
 *  transparency card). Mirrors the Citation contract from qa/types.ts —
 *  every citation carries a human-readable `title` (2026-06-11 parity pass). */
export interface BrainFeedCitation {
  kind: string;
  rowId: string;
  title?: string;
  excerpt?: string;
  url?: string | null;
}

/**
 * Parsed cortex_ask tool RESULT — what the Brain fed the orchestrator this
 * turn. Populated by the orchestrator stream's `tool-result` handler (only
 * for cortex_ask calls); drives the Brain→Fable transparency card rendered
 * when the turn's backend is metered.
 */
export interface BrainFeed {
  question: string;
  answer: string;
  citations: BrainFeedCitation[];
  sourcesConsidered: number | null;
  retrievalMs: number | null;
  cacheHit: 'exact' | 'semantic' | null;
  /** Chars of source text the Brain read (composer-visible, ~1500/row cap) —
   *  the "what a raw read would have cost" offload denominator. Null when the
   *  server didn't derive it (cache hits, older servers). */
  consideredChars: number | null;
}

export interface MobileTranscriptToolCall {
  id?: string | null;
  name: string;
  args?: Record<string, unknown>;
  status?: 'calling' | 'running' | 'done' | 'error';
  preview?: string;
  result?: string;
  sideEffectClass?: ToolSideEffectClass;
  launchLink?: MobileTranscriptToolLaunchLink | null;
  /** Orchestrator backend id of the turn that made this call — stamped from
   *  the ws event's `data.backend` by the tool-result handler. Gates the
   *  Brain→Fable transparency card to metered backends. */
  backend?: string;
  /** Structured cortex_ask answer payload — see BrainFeed. */
  brainFeed?: BrainFeed;
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
  /** Monotonic server persistence revision for this message. */
  persistedVersion?: number;
  pinned?: boolean;
  type?: 'message' | 'compaction' | 'command';
  media?: MobileTranscriptMedia[];
  toolCalls?: MobileTranscriptToolCall[];
  timestamp?: number;
  timestampLabel?: string;
  model?: string;
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  costUsd?: number;
  sources?: MobileTranscriptSource[];
  thinking?: string;
  thinkingSteps?: MobileTranscriptThinkingStep[];
  thinkingDurationMs?: number;
  /** True while a reasoning phase is in flight for this entry. Claude 5-family
   *  thinking streams signature-only (content redacted at the API), so this
   *  marker — set on the thinking block start, cleared when the first answer
   *  token or tool call ends reasoning — is what lets the transcript show a
   *  live "Thinking" line even when `thinking` text never arrives. */
  thinkingActive?: boolean;
  claudeCodeEvents?: ClaudeCodeStreamJsonChatEvent[];
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
  /** Structured orchestrator status event (mission complete / merge / heal) — rendered as OrchestratorStatusCard. */
  statusEvent?: import('@/lib/orchestrator/status-events').OrchestratorStatusEventData;
  /**
   * Marks a system entry as an in-chat error notice (delivery failure, stream
   * error) so it renders with the warning tint instead of the neutral system
   * card. Entries persisted before this flag existed fall back to text
   * detection — see `isErrorNoticeText` in `@/lib/transcripts/error-notice`.
   */
  isError?: boolean;
  /**
   * Collide (MoA) pre-roll — the faint, collapsible "two proposals collided"
   * card that precedes the synthesized answer. Present only on Collide turns;
   * rendered as CollideProposalCard instead of the default message body.
   */
  collide?: {
    phase: 'proposing' | 'synthesizing';
    proposers: string[];
    proposals: Array<{ proposer: string; text: string; breach: boolean }>;
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
  action: Extract<MobileControlActionKind, 'send' | 'steer' | 'stop' | 'approve' | 'request_changes' | 'deny' | 'pause' | 'resume' | 'watch' | 'resolve' | 'launch'>;
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
  inProgress?: boolean;
}

// ── Mobile orchestrator surface ──
//
// The mobile Orchestrator tab reads from /api/mobile/orchestrator/threads (a
// thin projection of ~/.o8/chat-history/thoughts-*.json) and subscribes to
// the existing `orchestrator` WS channel. These shapes are deliberately
// minimal — alpha is read-mostly with a single composer.

export type MobileOrchestratorRuntime = OrchestratorRuntime | 'unknown';

/** The orchestrator backend that ran a thread — distinct from the worker `runtime`.
 *  Derived from the single backend-id source so it tracks new backends (hermes/acp). */
export type MobileOrchestratorBackend = OrchestratorBackendId;

export type MobileOrchestratorThreadStatus = 'idle' | 'ready' | 'busy' | 'failed';

export interface MobileOrchestratorThread {
  id: string;
  title: string;
  lastMessageAt: string;
  runtime: MobileOrchestratorRuntime;
  status: MobileOrchestratorThreadStatus;
  messageCount: number;
  /** Stable desktop project identity; null for legacy threads. */
  projectId: string | null;
  repoPath: string | null;
  repoName: string | null;
  repoBranch: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  /** Orchestrator backend, when the thread was tagged; null for legacy threads. */
  backend: MobileOrchestratorBackend | null;
  /** openclaw agent id that ran the thread; null for non-openclaw/untagged. */
  agent: string | null;
  /** Whether the chat-history thread is pinned on the desktop. */
  pinned?: boolean;
}

/**
 * One dispatched agent / packet for the mobile orchestrator pill (the strip
 * above the orchestrator chat listing what the orchestrator has dispatched).
 * Projected by /api/mobile/orchestrator/packets from an OrchestratorPacket +
 * its live lane.
 */
export interface MobileOrchestratorAgent {
  /** Packet id. */
  id: string;
  /** What the agent was dispatched to do (packet title, falling back to summary). */
  title: string;
  runtime: MobileOrchestratorRuntime;
  /** Collapsed packet lifecycle — see mapPacketStatus in the route. */
  status: MobileAgentStatus;
  /** Worker-posted huddle plan, when status === 'huddling'. */
  huddlePlan?: string;
  /** Latest lane/packet event label for additive mobile rendering. */
  lastEventLabel?: string | null;
  /** Preserved work details when an unreleased packet was archived recoverably. */
  recovery?: OrchestratorPacketRecovery | null;
  /** Worktree branch the agent commits to. */
  branch: string;
  /** Diff stats for the agent's worktree (zeros for queued packets). */
  filesChanged: number;
  additions: number;
  deletions: number;
  /** Lane runtime session key when the lane is live, else null. */
  sessionKey: string | null;
}

/**
 * One entry in the mobile fleet activity feed. Projected by
 * /api/mobile/activity from recent git commits across the repos in o8's
 * registry, optionally folded together with orchestrator packet lifecycle
 * events. Newest-first, capped at ~40 entries.
 */
export interface MobileActivityEvent {
  /** Stable id — `commit:<sha>` for commits, `packet:<id>` for packet events. */
  id: string;
  /**
   * Additive provenance for clients that distinguish observed repository work
   * from activity initiated through o8's control plane. Older clients can
   * ignore this field.
   */
  source?: 'git' | 'orchestrator';
  /** Stable tracked-repository id when the event came from the repo registry. */
  repoId?: string;
  /** Full commit SHA when source === 'git'. */
  commitSha?: string;
  /** Git author display name when source === 'git'. */
  author?: string;
  /**
   * Ref through which Git surfaced the commit, e.g. `main`,
   * `agent/mobile-activity`, or `origin/main`.
   */
  observedRef?: string;
  /** Exact aggregate file count reported by Git for this commit. */
  filesChanged?: number;
  /** Exact text-line additions reported by Git; binary files contribute zero. */
  additions?: number;
  /** Exact text-line deletions reported by Git; binary files contribute zero. */
  deletions?: number;
  /** Bounded sample of Git-reported paths touched by this commit. */
  relatedFiles?: string[];
  /** True when relatedFiles omits paths beyond its server-side cap. */
  relatedFilesTruncated?: boolean;
  /**
   *   - `commit`          — a non-merge git commit.
   *   - `merge`           — a git merge commit (>1 parent) or a released packet.
   *   - `dispatched`      — a packet that is launching / running.
   *   - `awaiting_review` — a packet whose work is done and awaiting review.
   *   - `huddle`          — a worker posted its huddle plan and is awaiting alignment.
   *   - `alert`           — a failed / blocked packet.
   */
  kind: 'dispatched' | 'huddle' | 'awaiting_review' | 'merge' | 'commit' | 'alert';
  /** Primary line — commit subject or packet title. */
  title: string;
  /** Secondary line, e.g. `"main · 9393504"` or `"agent/x → main"`. */
  detail?: string;
  /** Optional URL the mobile app can open to inspect/test this work. */
  previewUrl?: string;
  /** Optional review/operator comments displayed in mobile activity details. */
  comments?: string[];
  /** Short repo name, e.g. `"o8"`. */
  repo?: string;
  /** Event time as epoch milliseconds. */
  timestamp: number;
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
