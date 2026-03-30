import type { BrowserSurfaceSummary } from '@/lib/browser/types';

/**
 * Universal Agent Runtime Contract
 *
 * Every coding agent runtime (Codex, Claude Code, Aider, etc.) implements
 * this interface. The UI talks to the registry, never to a specific runtime.
 *
 * Adding a new agent = one file implementing AgentRuntime.
 */

export type RuntimeId = 'codex' | 'claude-code' | (string & {});

// ── Capabilities ──

/**
 * What a runtime can do. UI uses this to show/hide controls.
 * All default to false — a runtime opts IN to capabilities.
 */
export interface RuntimeCapabilities {
  /** Can discover existing sessions on disk/network */
  discover: boolean;
  /** Can read session transcript/history */
  readTranscript: boolean;
  /** Can launch a new session with a prompt */
  launch: boolean;
  /** Can send follow-up messages to an existing session */
  resume: boolean;
  /** Can interrupt/stop a running session */
  interrupt: boolean;
  /** Can provide changed files / diff context */
  reviewDiffs: boolean;
  /** Can provide cost/token telemetry */
  costTelemetry: boolean;
  /** Supports real-time streaming of output */
  streaming: boolean;
}

// ── Session ──

export type RuntimeSessionStatus = 'running' | 'idle' | 'waiting' | 'reviewing' | 'failed';
export type RuntimeSessionOwnership = 'discovered' | 'owned' | 'provider';

/**
 * Normalized session shape. Every runtime maps its internal format to this.
 */
export interface RuntimeSession {
  /** Unique key for this session across all runtimes */
  sessionKey: string;
  /** Runtime that owns this session */
  runtimeId: RuntimeId;
  /** Human-readable name (e.g., "cortex-ide • main") */
  displayName: string;
  /** Working directory */
  cwd: string;
  /** Git branch if known */
  branch?: string;
  /** Git commit SHA if known */
  headSha?: string;
  /** Repository slug if known (e.g., '') */
  repoSlug?: string;
  /** Current status */
  status: RuntimeSessionStatus;
  /** Ownership model */
  ownership: RuntimeSessionOwnership;
  /** What can be done with this session right now */
  sessionCapabilities: {
    canSendInput: boolean;
    canInterrupt: boolean;
    canReviewDiffs: boolean;
  };
  /** When this session was last active */
  lastActivityAt: Date;
  /** The initial task/prompt */
  initialTask?: string;
  /** Model being used */
  model?: string;
  /** Lifecycle state for owned sessions */
  lifecycle?: {
    availability: 'awaiting-thread' | 'running' | 'ready-for-resume';
    lastOutcome?: 'finished' | 'interrupted' | 'failed';
    lastRunMode?: 'launch' | 'resume';
    lastRunStartedAt?: string;
    lastRunFinishedAt?: string;
    summary?: string;
  };
  /** Process ID if running locally */
  pid?: number;
  /** Context window usage percentage (0-100) */
  contextUsedPercent?: number;
  /** tmux session name for interactive terminal attachment */
  tmuxSession?: string;
  /** Attached or mirrored browser lane, if the runtime exposes one */
  browserSurface?: BrowserSurfaceSummary;
}

// ── Transcript ──

export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Normalized transcript entry. Every runtime maps its log format to this.
 */
export interface RuntimeTranscriptEntry {
  id: string;
  role: TranscriptRole;
  text: string;
  timestamp: Date;
  /** Tool name if role=tool */
  toolName?: string;
  /** File path if the entry involves a file */
  filePath?: string;
}

// ── Review ──

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/**
 * Changed file from a session's work.
 */
export interface RuntimeChangedFile {
  path: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  originalPath?: string;
}

// ── Actions ──

/**
 * Result of a launch/resume/interrupt action.
 */
export interface RuntimeActionResult {
  ok: boolean;
  note: string;
  sessionKey?: string;
}

/**
 * Options for launching a new session.
 */
export interface LaunchOptions {
  cwd: string;
  prompt: string;
  model?: string;
  worktreeFlag?: string;
  worktreePath?: string;
}

// ── Telemetry ──

export interface RuntimeTelemetry {
  totalTokens?: number;
  remainingTokens?: number;
  estimatedCostUsd?: number;
}

// ── THE CONTRACT ──

/**
 * Every agent runtime implements this interface.
 *
 * Simple runtimes can implement only discover + readTranscript.
 * Complex ones implement all methods.
 * The `capabilities` property tells the UI what's available.
 */
export interface AgentRuntime {
  /** Unique runtime identifier */
  readonly id: RuntimeId;
  /** Display name for UI */
  readonly displayName: string;
  /** What this runtime supports */
  readonly capabilities: RuntimeCapabilities;

  // ── Discovery ──

  /**
   * Find all sessions this runtime knows about.
   * Called on initial load and periodic refresh.
   */
  discoverSessions(): Promise<RuntimeSession[]>;

  // ── Transcript ──

  /**
   * Read transcript entries for a session.
   * @param sessionKey - The session to read
   * @param sinceId - Only return entries after this ID (for incremental fetch)
   * @param limit - Max entries to return
   */
  readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]>;

  // ── Lifecycle ──

  /**
   * Launch a new session with a prompt.
   */
  launch(opts: LaunchOptions): Promise<RuntimeActionResult>;

  /**
   * Send a follow-up message to an existing session.
   */
  resume(sessionKey: string, message: string): Promise<RuntimeActionResult>;

  /**
   * Interrupt/stop a running session.
   */
  interrupt(sessionKey: string): Promise<RuntimeActionResult>;

  // ── Review ──

  /**
   * Get changed files from a session's work.
   */
  getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]>;

  // ── Telemetry (optional) ──

  /**
   * Get cost/usage data for a session. Optional — return undefined if not supported.
   */
  getTelemetry?(sessionKey: string): Promise<RuntimeTelemetry | undefined>;
}
