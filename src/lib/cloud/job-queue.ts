/**
 * Cloud runtime — in-memory job queue (issue #514 v0 scaffolding)
 *
 * Workers connect to the o8 backend over outbound-only HTTPS and long-poll
 * this queue for the next job. Each worker tracks its own cursor so N workers
 * can ride the same team queue without dropping jobs.
 *
 * This is deliberately in-memory for v0. Persistence lands in the follow-up
 * that promotes the config-file model to SQLite. See #514 follow-up note.
 */
import type { LaunchOptions } from '@/lib/runtimes/types';

/**
 * A cloud job is the server-side view of one `launch()` call that has been
 * accepted but not yet picked up by a worker (or is still streaming back).
 */
export interface CloudJob {
  id: string;
  teamId: string;
  /** Monotonic cursor assigned at enqueue time. Workers use this to resume. */
  cursor: number;
  launch: LaunchOptions;
  enqueuedAt: string;
  /** When a worker actually started processing the job. */
  claimedAt?: string;
  claimedBy?: string;
  /** Final status — populated from /api/cloud/worker-stream 'completed'/'errored'. */
  status: 'pending' | 'claimed' | 'completed' | 'errored' | 'cancelled';
}

interface TeamQueueState {
  nextCursor: number;
  jobs: CloudJob[];
  waiters: Array<(job: CloudJob | null) => void>;
}

const teamQueues = new Map<string, TeamQueueState>();

function getOrCreateTeam(teamId: string): TeamQueueState {
  let state = teamQueues.get(teamId);
  if (!state) {
    state = { nextCursor: 1, jobs: [], waiters: [] };
    teamQueues.set(teamId, state);
  }
  return state;
}

/**
 * Enqueue a job and wake up any waiting long-poll connections.
 * Returns the CloudJob handle — caller holds the id to reference later.
 */
export function enqueueCloudJob(teamId: string, jobId: string, launch: LaunchOptions): CloudJob {
  const state = getOrCreateTeam(teamId);
  const job: CloudJob = {
    id: jobId,
    teamId,
    cursor: state.nextCursor,
    launch,
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
  };
  state.nextCursor += 1;
  state.jobs.push(job);

  // Hand the job to the first waiter that hasn't already been resolved.
  while (state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    if (waiter) {
      waiter(job);
      job.status = 'claimed';
      job.claimedAt = new Date().toISOString();
      break;
    }
  }

  return job;
}

/**
 * Claim the next pending job for a team at or after the worker's cursor.
 * Returns `null` if nothing is pending.
 */
export function claimNextJob(teamId: string, cursor: number, workerId: string): CloudJob | null {
  const state = teamQueues.get(teamId);
  if (!state) return null;

  const pending = state.jobs.find((j) => j.status === 'pending' && j.cursor >= cursor);
  if (!pending) return null;

  pending.status = 'claimed';
  pending.claimedAt = new Date().toISOString();
  pending.claimedBy = workerId;
  return pending;
}

/**
 * Register a long-poll waiter. Resolves either when a new job arrives for the
 * team or when the timeout fires (handler will then return 204).
 *
 * The returned disposer lets the route handler cancel the wait cleanly if the
 * client disconnects.
 */
export function waitForJob(
  teamId: string,
  timeoutMs: number,
): { promise: Promise<CloudJob | null>; cancel: () => void } {
  const state = getOrCreateTeam(teamId);
  let settled = false;
  let resolveFn: (job: CloudJob | null) => void = () => {};

  const promise = new Promise<CloudJob | null>((resolve) => {
    resolveFn = (job) => {
      if (settled) return;
      settled = true;
      resolve(job);
    };
    state.waiters.push(resolveFn);

    setTimeout(() => {
      if (settled) return;
      // Remove ourselves from the waiter list so we don't pin memory.
      const idx = state.waiters.indexOf(resolveFn);
      if (idx >= 0) state.waiters.splice(idx, 1);
      resolveFn(null);
    }, timeoutMs);
  });

  return {
    promise,
    cancel: () => {
      if (settled) return;
      const idx = state.waiters.indexOf(resolveFn);
      if (idx >= 0) state.waiters.splice(idx, 1);
      resolveFn(null);
    },
  };
}

/**
 * Get a job by id (for status/stream/interrupt lookups).
 */
export function getJob(teamId: string, jobId: string): CloudJob | undefined {
  return teamQueues.get(teamId)?.jobs.find((j) => j.id === jobId);
}

/**
 * Mark a job as completed, errored, or cancelled. Idempotent for terminal
 * states — once a job is terminal it cannot regress.
 */
export function setJobStatus(
  teamId: string,
  jobId: string,
  status: 'completed' | 'errored' | 'cancelled',
): CloudJob | undefined {
  const job = getJob(teamId, jobId);
  if (!job) return undefined;
  if (job.status === 'completed' || job.status === 'errored' || job.status === 'cancelled') {
    return job;
  }
  job.status = status;
  return job;
}

/**
 * Test-only reset. Not exported through a public path, but the job queue
 * keeps module-level state and tests will need a door eventually.
 */
export function __resetCloudQueueForTests() {
  teamQueues.clear();
}
