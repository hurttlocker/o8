/**
 * Cloud Runtime Adapter
 *
 * Workers run on customer infra (Kubernetes, VMs, bare metal) and open
 * outbound-only HTTPS to the o8 backend. They long-poll the job queue, pick
 * up dispatched jobs, and stream transcripts + diffs back over POST.
 *
 * This is the o8-side surface that makes the runtime dispatchable. The
 * worker CLI is a separate ship. Resume and diff retrieval stay unavailable
 * until that client can service them.
 *
 * Parallel to `codex.ts` and `claude-code.ts`. Registered under runtime id
 * `cloud` via `src/lib/runtimes/index.ts`.
 *
 * Design choice: the durable job queue is team-scoped so N workers in a
 * pool can share a queue and each tracks its own cursor. This matches the
 * Cursor self-hosted shape (10 workers/user, 50 workers/team).
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
import {
  cancelJob,
  CloudPacketActiveError,
  enqueueCloudJob,
  getJob,
  listJobs,
  readJobEvents,
} from '@/lib/cloud/job-queue';
import { randomUUID } from 'node:crypto';

/**
 * Launch, discovery, transcript replay, and interrupt use the durable job
 * ledger. Resume and diff retrieval remain unavailable.
 */
const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
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

function textFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ['text', 'message', 'output', 'result', 'error', 'reason']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return fallback;
}

function eventText(type: string, payload: unknown): string {
  switch (type) {
    case 'accepted': return 'Cloud job accepted.';
    case 'claimed': return 'Cloud worker claimed the job.';
    case 'chunk': return textFromPayload(payload, 'Cloud worker emitted output.');
    case 'heartbeat': return 'Cloud worker lease renewed.';
    case 'completed': return textFromPayload(payload, 'Cloud job completed.');
    case 'errored': return `Error: ${textFromPayload(payload, 'Cloud worker execution failed.')}`;
    case 'lease_recovered': return 'Cloud worker lease expired; the job returned to the queue.';
    case 'cancelled': return 'Cloud job cancelled.';
    default: return `Cloud job event: ${type}`;
  }
}

export const cloudRuntime: AgentRuntime = {
  id: RUNTIME_ID,
  displayName: 'Cloud Worker',
  capabilities,

  // ── Discovery ──
  //
  // Includes terminal jobs so status remains readable after a restart.
  async discoverSessions(): Promise<RuntimeSession[]> {
    return listJobs(DEFAULT_TEAM_ID).map((job) => ({
      sessionKey: sessionKeyFor(job.id),
      runtimeId: RUNTIME_ID,
      displayName: job.packetId
        ? `Cloud packet ${job.packetId}`
        : `Cloud job ${job.id.slice(0, 8)}`,
      cwd: job.launch.cwd,
      status: job.status === 'leased'
        ? 'running'
        : job.status === 'pending'
          ? 'waiting'
          : job.status === 'completed'
            ? 'completed'
            : 'failed',
      ownership: 'provider',
      sessionCapabilities: {
        canSendInput: false,
        canInterrupt: job.status === 'pending' || job.status === 'leased',
        canReviewDiffs: false,
      },
      lastActivityAt: new Date(job.updatedAt),
      initialTask: job.launch.prompt,
      model: job.launch.model,
    }));
  },

  // ── Transcript ──
  async readTranscript(
    sessionKey: string,
    sinceId?: string,
    limit?: number,
  ): Promise<RuntimeTranscriptEntry[]> {
    const jobId = jobIdFromSessionKey(sessionKey);
    const parsedSince = sinceId ? Number.parseInt(sinceId, 10) : 0;
    return readJobEvents(
      DEFAULT_TEAM_ID,
      jobId,
      Number.isFinite(parsedSince) ? parsedSince : 0,
      limit,
    ).map((event) => ({
      id: String(event.id),
      role: event.type === 'chunk' ? 'assistant' : event.type === 'errored' ? 'tool' : 'system',
      text: eventText(event.type, event.payload),
      timestamp: new Date(event.createdAt),
      type: 'message',
    }));
  },

  // ── Lifecycle ──

  /**
   * Enqueue a job onto the team queue. The next long-poll tick on
   * /api/cloud/worker-poll will hand it to an idle worker.
   *
   * The SQLite insert commits before this method reports success.
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
      if (error instanceof CloudPacketActiveError) {
        return {
          ok: false,
          note: error.message,
          sessionKey: sessionKeyFor(error.activeJob.id),
        };
      }
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
    cancelJob(DEFAULT_TEAM_ID, jobId);
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
