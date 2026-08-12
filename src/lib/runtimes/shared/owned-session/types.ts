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
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { SandboxDenial } from './sandbox-denial';

// ── Run / session primitives ─────────────────────────────────────────────────

export type OwnedRunMode = 'launch' | 'resume';

export type OwnedRunOutcome = 'running' | 'finished' | 'interrupted' | 'failed';

export type OwnedReviewDisposition = 'watching' | 'resolved';

export type OwnedSessionState = 'active' | 'archived' | 'missing';

export interface OwnedChildExitOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  classification: 'clean-exit' | 'nonzero-exit' | 'signal-kill';
  stderrTail?: string;
}

export interface OwnedRunRecord {
  /** Failed stop attempts for this run — bounds the orphan-sweep retry. */
  stopAttempts?: number;
  id: string;
  mode: OwnedRunMode;
  prompt: string;
  startedAt: string;
  finishedAt?: string;
  pid: number;
  /** Spawned executable basename, used to reject recycled PIDs before signaling. */
  commandIdentity?: string;
  stdoutPath: string;
  stderrPath: string;
  outcome: OwnedRunOutcome;
  interruptRequestedAt?: string;
  tmuxSession?: string;
  // #4 crash-survival — how this run's process was spawned, so boot re-discovery
  // knows whether to re-bind it (detached survivors keep running through a
  // ws-server/app crash) vs salvage it. 'bridge' = ws-server-owned PTY (dies with
  // ws-server, today's default); 'detached' = setsid+unref child that outlives
  // both node processes, transcript streaming to stdoutPath.
  detachMode?: 'bridge' | 'detached';
  /** True only when this run was wrapped by sandbox-exec. */
  sandboxed?: boolean;
  /** Persisted so refresh/restart cannot re-emit the same denial event. */
  sandboxDenial?: SandboxDenial;
  childExit?: OwnedChildExitOutcome;
}

export interface OwnedSessionRecord {
  surfaceId: string;
  /** Launch receipt correlation, persisted before the external process starts. */
  launchMutationId?: string;
  /** Lane known at spawn time, so an immediate child exit can reach its audit stream. */
  laneId?: string;
  /** Packet that owns this worker credential and every packet-scoped API call. */
  packetId?: string;
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
  /** Requested reasoning effort — applied per-runtime at launch (codex only today). */
  effort?: ThinkingEffort;
  /** Server-only config-home binding captured once at launch. */
  identity?: {
    id: string;
    label: string;
    configHomeRef: string;
  };
  reviewDisposition?: OwnedReviewDisposition;
  reviewDispositionUpdatedAt?: string;
  activeRun?: OwnedRunRecord;
  recentRuns: OwnedRunRecord[];
  autoRetry?: boolean;
  retryCount?: number;
  orphanedAt?: string;
  orphanedReason?: string;
  orphanedCostLine?: string;
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
  clientMutationId?: string;
  laneId?: string;
  packetId?: string;
  model?: string;
  /** Requested reasoning effort — a per-runtime no-op unless the adapter uses it. */
  effort?: ThinkingEffort;
}

export interface OwnedLaunchResponse {
  ok: boolean;
  runtime: string;
  surfaceId: string;
  note: string;
}

export interface OwnedArchiveResponse {
  archived: boolean;
  note: string;
  archivePath?: string;
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
   * Optional env-var augmentation for the spawned CLI child. Returned values
   * are merged on top of the parent process env (overriding existing keys).
   * Used by adapters that need to translate one auth-var alias into another
   * (e.g. gemini CLI in stream-json mode reads GEMINI_API_KEY but the user
   * may only have GOOGLE_GENERATIVE_AI_API_KEY set in their shell). Called
   * lazily at spawn time so env reads stay current.
   */
  extraSpawnEnv?: () => Record<string, string>;

  /** Supported isolated config-home variable for session-pinned identities. */
  isolatedConfigHomeEnv?: string;

  /** Current local config home captured when a packet has no named identity. */
  defaultConfigHome?: () => string;

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
  launchArgs(ctx: {
    cwd: string;
    sessionDir?: string;
    prompt: string;
    model?: string;
    effort?: ThinkingEffort;
  }): string[];

  /** Optional stdin payload for runtimes launched as interactive stream processors. */
  launchStdin?(ctx: { cwd: string; prompt: string; model?: string; effort?: ThinkingEffort }): string | null;

  /**
   * Build argv for a resume run. Return null to signal this runtime cannot
   * thread-resume via CLI — the store will raise a friendly "no resume
   * available" error so callers can route through the dispatcher.
   */
  resumeArgs(ctx: {
    threadId: string;
    sessionDir?: string;
    prompt: string;
    model?: string;
  }): string[] | null;

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

  /**
   * Optional model-fallback hook. Called when a run has just failed and the
   * store is about to auto-retry. Return a new model id to swap the session's
   * model before the retry (and emit a `runtime_fallback` notification), or
   * null to keep the current model. Used by Gemini to cascade from
   * gemini-3-pro-preview → gemini-3.1-pro-preview → gemini-2.5-pro when a
   * model hits its daily quota.
   */
  chooseRetryModel?(ctx: {
    failedRunRaw: string;
    currentModel: string | undefined;
  }): { nextModel: string; reason: string } | null;
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
  getRuntimeTail(surfaceId: string, limit?: number): Promise<{
    surface: RuntimeSurfaceSummary;
    entries: OwnedTailEntry[];
    groups: OwnedTailGroup[];
  }>;
  getReviewPacket(surfaceId: string): Promise<RuntimeReviewPacket>;
  getFleetAdditions(options?: { fresh?: boolean }): Promise<OwnedFleetAdditions>;
  sessionState(surfaceId: string): Promise<OwnedSessionState>;
  archiveSession(surfaceId: string): Promise<OwnedArchiveResponse>;
  /** #1292 — archive owned-session dirs not bound to an active lane (orphans) so
   *  discovery can't re-spawn phantom lanes. Skips active/in-flight sessions. */
  sweepOrphanedSessions(activeSurfaceIds: Set<string>, maxAgeMs: number): Promise<number>;
  getTelemetrySources(surfaceId: string): Promise<{
    threadId?: string;
    model?: string;
    stdoutPaths: string[];
  } | null>;
  getSessionIdentityId(surfaceId: string): Promise<string | null>;
  setReviewDisposition(
    surfaceId: string,
    disposition: OwnedReviewDisposition,
  ): Promise<{ disposition: OwnedReviewDisposition; note: string }>;
  invalidateFleetCache(): void;
}
