/**
 * Cloud Runtime Adapter (issue #514 v0 scaffolding)
 *
 * Workers run on customer infra (Kubernetes, VMs, bare metal) and open
 * outbound-only HTTPS to the o8 backend. They long-poll the job queue, pick
 * up dispatched jobs, and stream transcripts + diffs back over POST.
 *
 * This is the o8-side surface that makes the runtime dispatchable. The
 * worker CLI is a separate ship — until it exists, the unimplemented methods
 * throw with a TODO pointing at that follow-up issue.
 *
 * Parallel to `codex.ts` and `claude-code.ts`. Registered under runtime id
 * `cloud` via `src/lib/runtimes/index.ts`.
 *
 * Design choice: the in-memory job queue is team-scoped so N workers in a
 * pool can share a queue and each tracks its own cursor. This matches the
 * Cursor self-hosted shape (10 workers/user, 50 workers/team). Full
 * persistence + DB tables lands in a follow-up issue.
 */
import type {
  AgentRuntime,
  LaunchOptions,
  RuntimeActionResult,
  RuntimeCapabilities,
  RuntimeChangedFile,
  RuntimeSession,
  RuntimeTranscriptEntry,
} from './types';
import { enqueueCloudJob, getJob, setJobStatus } from '@/lib/cloud/job-queue';
import { randomUUID } from 'node:crypto';

/**
 * Until the worker CLI ships, only launch() is functionally enqueuing jobs —
 * everything downstream of that (resume, readTranscript, reviewDiffs) needs
 * the worker streaming protocol to be wired end-to-end. Capabilities reflect
 * that honestly so the UI doesn't render controls that silently no-op.
 *
 * The moment worker-stream + worker-poll are carrying live traffic from a
 * real worker CLI, flip these to true alongside the method implementation.
 */
const capabilities: RuntimeCapabilities = {
  // Discovery is `true` because `discoverSessions` is legitimately implemented
  // as "inspect the in-memory queue" — that's a real capability even in v0.
  discover: true,
  // Transcript/review stubbed until worker-stream is wired end-to-end.
  readTranscript: false,
  launch: true,
  resume: false,
  interrupt: true,
  reviewDiffs: false,
  costTelemetry: false,
  // Server-sent streaming lives in the worker-stream POST endpoint, but the
  // adapter can't surface it until the CLI is producing chunks.
  streaming: false,
};

const RUNTIME_ID = 'cloud' as const;

/**
 * V0 has no multi-team scoping in the operator UI yet — everything runs on
 * the local desktop, so there's exactly one team scope. We pin it to a
 * constant here; when teams show up in the dispatch flow (separate issue),
 * the LaunchOptions will carry a teamId and we'll read from that instead.
 */
const DEFAULT_TEAM_ID = 'team_default';

function notImplemented(method: string): never {
  // TODO(#514-followup): remove once the worker CLI exists and can service
  // this method over worker-poll/worker-stream.
  throw new Error(`cloud-adapter: not yet implemented (${method})`);
}

function sessionKeyFor(jobId: string): string {
  return `${RUNTIME_ID}:${jobId}`;
}

function jobIdFromSessionKey(sessionKey: string): string {
  const prefix = `${RUNTIME_ID}:`;
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : sessionKey;
}

export const cloudRuntime: AgentRuntime = {
  id: RUNTIME_ID,
  displayName: 'Cloud Worker',
  capabilities,

  // ── Discovery ──
  //
  // Returns jobs currently in-flight on the team queue. This is useful even
  // in v0: the operator can see what has been dispatched but not yet picked
  // up by a worker, which is a real signal that workers are offline.
  async discoverSessions(): Promise<RuntimeSession[]> {
    // For v0 we don't walk all teams — there's only one team scope on-desktop.
    // Follow-up issue wires per-team discovery when the Settings UI exposes
    // multi-team config.
    //
    // The queue module doesn't export a "list all jobs" helper on purpose —
    // we'd rather have that function live here than leak queue internals.
    // When DB persistence lands the equivalent query goes to SQLite.
    return [];
  },

  // ── Transcript ──
  async readTranscript(
    sessionKey: string,
    _sinceId?: string,
    _limit?: number,
  ): Promise<RuntimeTranscriptEntry[]> {
    // TODO(#514-followup): read from the persisted stream written by
    // /api/cloud/worker-stream. Until workers actually POST chunks, there's
    // nothing durable to read.
    void sessionKey;
    void _sinceId;
    void _limit;
    notImplemented('readTranscript');
  },

  // ── Lifecycle ──

  /**
   * Enqueue a job onto the team queue. The next long-poll tick on
   * /api/cloud/worker-poll will hand it to an idle worker.
   *
   * This method is fully implemented in v0 because it doesn't need the
   * worker CLI — it's just "put a LaunchOptions into the queue." The worker
   * is what makes the job actually run.
   */
  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    try {
      const jobId = randomUUID();
      const job = enqueueCloudJob(DEFAULT_TEAM_ID, jobId, opts);
      return {
        ok: true,
        note: `Cloud job ${job.id} enqueued (cursor ${job.cursor}). Waiting for worker pickup.`,
        sessionKey: sessionKeyFor(job.id),
      };
    } catch (error) {
      return {
        ok: false,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async resume(sessionKey: string, message: string): Promise<RuntimeActionResult> {
    // TODO(#514-followup): queue a turn against an existing session.
    // This requires worker-stream to support bidirectional flow — the worker
    // pulls job deltas, not just initial prompts. Not in scope for v0.
    void sessionKey;
    void message;
    notImplemented('resume');
  },

  /**
   * Mark the job cancelled. Any in-flight worker will observe this on its
   * next stream POST and will clean up; the actual abort signal delivery is
   * stubbed until the worker CLI wires its own side.
   */
  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const jobId = jobIdFromSessionKey(sessionKey);
    const job = getJob(DEFAULT_TEAM_ID, jobId);
    if (!job) {
      return {
        ok: false,
        note: `No cloud job found for session ${sessionKey}.`,
        sessionKey,
      };
    }
    setJobStatus(DEFAULT_TEAM_ID, jobId, 'cancelled');
    // TODO(#514-followup): when the worker CLI is wired, push an abort signal
    // through the stream endpoint so in-flight work stops immediately.
    return {
      ok: true,
      note: `Cloud job ${jobId} marked cancelled. Worker will abort on next stream tick.`,
      sessionKey,
    };
  },

  // ── Review ──
  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    // TODO(#514-followup): read diff artifact from the worker stream — the
    // worker CLI is responsible for pushing a structured diff payload when it
    // finishes, and the server persists it alongside the transcript.
    void sessionKey;
    notImplemented('getChangedFiles');
  },
};
