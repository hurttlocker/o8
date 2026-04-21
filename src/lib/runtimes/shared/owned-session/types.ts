/**
 * Public types for the owned-session primitive.
 *
 * These are consumed by runtime adapters (Codex today; Gemini, opencode next)
 * that wrap `createOwnedSessionStore` from `./store`.
 */

import type {
  AgentSummary,
  EventItem,
  ReviewArtifact,
  RuntimeReviewCommandEvidence,
  SquadSummary,
} from '@/lib/fleet/types';

// ── Run / session primitives ─────────────────────────────────────────────────

export type OwnedRunMode = 'launch' | 'resume';

export type OwnedRunOutcome = 'running' | 'finished' | 'interrupted' | 'failed';

export type OwnedReviewDisposition = 'watching' | 'resolved';

export interface OwnedRunRecord {
  id: string;
  mode: OwnedRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  pid: number;
  stdoutPath: string;
  stderrPath: string;
  outcome: OwnedRunOutcome;
  interruptRequestedAt?: string;
  tmuxSession?: string;
}

export interface OwnedSessionRecord {
  surfaceId: string;
  sessionDir: string;
  cwd: string;
  repoPath: string;
  repoSlug?: string;
  branch?: string;
  head?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  latestPrompt: string;
  latestSummary: string;
  model?: string;
  reviewDisposition?: OwnedReviewDisposition;
  reviewDispositionUpdatedAt?: string;
  activeRun?: OwnedRunRecord;
  recentRuns: OwnedRunRecord[];
  autoRetry?: boolean;
  retryCount?: number;
}

// ── Tail entries / groups ────────────────────────────────────────────────────

export interface OwnedTailEntry {
  id: string;
  kind: 'message' | 'event' | 'tool' | 'tool-output';
  label: string;
  text: string;
  timestamp?: string;
  timestampLabel?: string;
}

export interface OwnedTailGroup {
  id: string;
  title: string;
  mode: OwnedRunMode;
  outcome: OwnedRunOutcome;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  startedAtLabel?: string;
  finishedAtLabel?: string;
  summary: string;
  entries: OwnedTailEntry[];
}

export interface ParsedRunLog {
  threadId?: string;
  entries: OwnedTailEntry[];
  outcome: OwnedRunOutcome;
  completedTurn: boolean;
}

export interface OwnedRunEvidence {
  assistantSummary?: string;
  commands: RuntimeReviewCommandEvidence[];
}

// ── Fleet additions ──────────────────────────────────────────────────────────

export interface OwnedFleetAdditions {
  agents: AgentSummary[];
  squads: SquadSummary[];
  events: EventItem[];
  artifacts: ReviewArtifact[];
  sourceLabel?: string;
  note?: string;
  ownedThreadIds: string[];
}

/** Backwards-compat alias — Codex originally exported this name. */
export type OwnedCodexFleetAdditions = OwnedFleetAdditions;

// ── Public launch I/O ────────────────────────────────────────────────────────

export interface OwnedLaunchRequest {
  cwd: string;
  prompt: string;
  model?: string;
}

export interface OwnedLaunchResponse {
  ok: boolean;
  runtime: string;
  surfaceId: string;
  note: string;
}

// ── Adapter contract ─────────────────────────────────────────────────────────

/**
 * Per-runtime adapter passed to `createOwnedSessionStore`. Contains everything
 * that must vary between Codex, Gemini, opencode, etc.
 */
export interface OwnedRuntimeAdapter {
  /** Internal id: 'codex' | 'gemini' | 'opencode'. */
  runtimeId: string;

  /**
   * Prefix for surface ids. Codex uses 'codex-owned:' and must not change
   * (existing sessions on disk depend on it). New runtimes pick their own
   * prefix, e.g. 'gemini-owned:'.
   */
  surfaceIdPrefix: string;

  /** Env var name whose value overrides the root session dir. */
  rootEnvVar: string;

  /** Absolute path used when `rootEnvVar` is unset. */
  rootDefault: string;

  /** CLI binary name used by the shared cli-resolver. */
  binaryName: string;

  /** Env-var override for the CLI binary (e.g. `'O8_CODEX_BIN'`). */
  binaryEnvOverride: string;

  /** Additional env-var overrides for the CLI binary. */
  binaryExtraEnvOverrides?: string[];

  /**
   * Human-readable label used in fleet metadata. Codex: 'Owned Codex'.
   * Interpolated into source labels, current-task copy, etc.
   */
  humanLabel: string;

  /** Short name used in squad/agent labels. Codex: `'Codex'`. */
  squadShortName: string;

  /** Session-id prefix. Codex uses `'codex-owned-'`. */
  sessionIdPrefix?: string;

  /** Default model when the launcher omits it. */
  defaultModel?: string;

  /** Build argv for a fresh (launch) run. */
  launchArgs(ctx: { cwd: string; prompt: string; model?: string }): string[];

  /**
   * Build argv for a resume run. Return null to signal this runtime cannot
   * thread-resume via CLI — the store will raise a friendly "no resume
   * available" error so callers can route through the dispatcher.
   */
  resumeArgs(ctx: { threadId: string; prompt: string; model?: string }): string[] | null;

  /** Parse a run's stdout into normalized entries + outcome + discovered thread id. */
  parseRunLog(raw: string, run: OwnedRunRecord): ParsedRunLog;

  /**
   * Extract command/tool evidence + an assistant summary for the review packet.
   * When omitted, the review packet still builds but without structured
   * command evidence.
   */
  parseRunEvidence?(raw: string, run: OwnedRunRecord, resolvedOutcome: OwnedRunOutcome): OwnedRunEvidence;

  /** Stderr patterns ignored when deciding run outcome. */
  stderrNoise?: RegExp[];

  /** Optional run summarizer. Default uses the latest prompt. */
  summarizeRun?(parsed: ParsedRunLog, run: OwnedRunRecord): string;

  /** Delay before auto-retrying a fresh failure. Default `5000ms`. */
  retryDelayMs?: number;

  /** Tail group copy for a launch turn. Default `'Launch turn'`. */
  launchGroupLabel?: string;

  /** Tail group copy for a resume turn. Default `'Resume turn'`. */
  resumeGroupLabel?: string;
}

// ── Store contract ───────────────────────────────────────────────────────────

import type { RuntimeReviewPacket, RuntimeSurfaceSummary } from '@/lib/fleet/types';

/**
 * Store contract returned from `createOwnedSessionStore`. Every method keeps
 * the same behavioural contract the Codex implementation had — the adapter
 * only changes what's runtime-specific (argv, parser, noise).
 */
export interface OwnedSessionStore {
  readonly runtimeId: string;
  readonly surfaceIdPrefix: string;

  launch(request: OwnedLaunchRequest): Promise<OwnedLaunchResponse>;
  resume(surfaceId: string, prompt: string): Promise<{ ok: boolean; note: string }>;
  interrupt(surfaceId: string): Promise<{ interrupted: boolean; note: string }>;
  getRuntimeTail(surfaceId: string): Promise<{
    surface: RuntimeSurfaceSummary;
    entries: OwnedTailEntry[];
    groups: OwnedTailGroup[];
  }>;
  getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket>;
  getFleetAdditions(options?: { fresh?: boolean }): Promise<OwnedFleetAdditions>;
  getTelemetrySources(surfaceId: string): Promise<{ threadId?: string; stdoutPaths: string[] } | null>;
  setReviewDisposition(
    surfaceId: string,
    disposition: OwnedReviewDisposition,
  ): Promise<{ disposition: OwnedReviewDisposition; note: string }>;
  invalidateFleetCache(): void;
}
