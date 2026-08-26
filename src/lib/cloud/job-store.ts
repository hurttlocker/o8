import type { LaunchOptions } from '@/lib/runtimes/types';

// The cloud names are retained for API compatibility, but this contract is
// the shared durable execution spine used by remote jobs and background work.

export type CloudJobStatus = 'pending' | 'leased' | 'completed' | 'parked' | 'cancelled';

export type CloudJobEventType =
  | 'accepted'
  | 'claimed'
  | 'chunk'
  | 'diff'
  | 'heartbeat'
  | 'completed'
  | 'errored'
  | 'lease_recovered'
  | 'lease_released'
  | 'control_queued'
  | 'control_delivered'
  | 'control_applied'
  | 'follow_up_queued'
  | 'cancelled';

export type CloudJobControlType = 'steer' | 'abort';
export type CloudJobControlStatus = 'pending' | 'delivered' | 'applied' | 'follow_up' | 'superseded';

export interface CloudJob {
  id: string;
  teamId: string;
  cursor: number;
  idempotencyKey: string;
  packetId?: string;
  sessionId: string;
  parentJobId?: string;
  launch: LaunchOptions;
  status: CloudJobStatus;
  enqueuedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  availableAt?: string;
  concurrencyKey?: string;
  concurrencyLimit?: number;
  concurrentCount?: number;
  claimCount: number;
  leaseRecoveryCount: number;
  executionAttempts: number;
  maxAttempts: number;
  lastError?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface CloudJobEvent {
  id: number;
  jobId: string;
  type: CloudJobEventType;
  payload: unknown;
  workerId?: string;
  createdAt: string;
}

export interface CloudJobControl {
  id: string;
  teamId: string;
  jobId: string;
  sequence: number;
  type: CloudJobControlType;
  payload: unknown;
  status: CloudJobControlStatus;
  deliveryToken?: string;
  deliveryExpiresAt?: string;
  deliveryCount: number;
  followUpJobId?: string;
  createdAt: string;
  deliveredAt?: string;
  appliedAt?: string;
  updatedAt: string;
}

export interface CloudJobMetrics {
  jobId: string;
  status: CloudJobStatus;
  queueWaitMs: number | null;
  claimCount: number;
  leaseRecoveryCount: number;
  executionAttempts: number;
  terminalLatencyMs: number | null;
}

export interface EnqueueCloudJobInput {
  id: string;
  teamId: string;
  idempotencyKey: string;
  packetId?: string;
  sessionId?: string;
  parentJobId?: string;
  launch: LaunchOptions;
  maxAttempts?: number;
  availableAtMs?: number;
  concurrencyKey?: string;
  concurrencyLimit?: number;
  nowMs?: number;
}

export interface ClaimCloudJobInput {
  teamId: string;
  cursor: number;
  workerId: string;
  bootId: string;
  leaseMs: number;
  nowMs?: number;
  jobId?: string;
  maxConcurrent?: number;
}

export interface AppendCloudJobEventInput {
  teamId: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  type: Extract<CloudJobEventType, 'chunk' | 'diff' | 'heartbeat' | 'completed' | 'errored'>;
  payload: unknown;
  leaseMs: number;
  nowMs?: number;
  retryDelayMs?: number;
  terminalOnFailure?: boolean;
}

export type AppendCloudJobEventResult =
  | {
      accepted: true;
      eventId: number;
      job: CloudJob;
    }
  | {
      accepted: false;
      reason: 'job_not_found' | 'job_not_leased' | 'lease_mismatch' | 'lease_expired';
      job?: CloudJob;
    };

export type QueueCloudJobControlResult = {
  control: CloudJobControl;
  job: CloudJob;
  followUpJob?: CloudJob;
};

export type ClaimCloudJobControlResult =
  | { accepted: true; control?: CloudJobControl }
  | {
      accepted: false;
      reason: 'job_not_found' | 'job_not_leased' | 'lease_mismatch' | 'lease_expired';
      job?: CloudJob;
    };

export type AcknowledgeCloudJobControlResult =
  | { accepted: true; control: CloudJobControl; job: CloudJob }
  | {
      accepted: false;
      reason: 'job_not_found' | 'job_not_leased' | 'lease_mismatch' | 'lease_expired'
        | 'control_not_found' | 'control_not_delivered' | 'delivery_mismatch';
      job?: CloudJob;
      control?: CloudJobControl;
    };

export interface CloudJobDrainStatus {
  draining: boolean;
  bootId?: string;
  startedAt?: string;
  activeLeases: number;
  pendingJobs: number;
}

export interface CloudJobStore {
  enqueue(input: EnqueueCloudJobInput): CloudJob;
  claimNext(input: ClaimCloudJobInput): CloudJob | null;
  appendEvent(input: AppendCloudJobEventInput): AppendCloudJobEventResult;
  queueControl(input: {
    teamId: string;
    sessionId: string;
    controlId: string;
    type: CloudJobControlType;
    payload: unknown;
    nowMs?: number;
  }): QueueCloudJobControlResult | undefined;
  claimControl(input: {
    teamId: string;
    jobId: string;
    workerId: string;
    leaseToken: string;
    deliveryLeaseMs: number;
    nowMs?: number;
  }): ClaimCloudJobControlResult;
  acknowledgeControl(input: {
    teamId: string;
    jobId: string;
    workerId: string;
    leaseToken: string;
    controlId: string;
    deliveryToken: string;
    nowMs?: number;
  }): AcknowledgeCloudJobControlResult;
  recoverExpiredLeases(teamId: string, nowMs?: number): number;
  beginDrain(teamId: string, bootId: string, nowMs?: number): CloudJobDrainStatus;
  finishDrain(teamId: string, bootId: string, nowMs?: number): CloudJobDrainStatus;
  drainStatus(teamId: string, bootId: string): CloudJobDrainStatus;
  cancel(teamId: string, jobId: string, nowMs?: number): CloudJob | undefined;
  get(teamId: string, jobId: string): CloudJob | undefined;
  getLatestForSession(teamId: string, sessionId: string): CloudJob | undefined;
  list(teamId: string, limit?: number): CloudJob[];
  readEvents(teamId: string, jobId: string, sinceId?: number, limit?: number): CloudJobEvent[];
  readSessionEvents(teamId: string, sessionId: string, sinceId?: number, limit?: number): CloudJobEvent[];
  listControls(teamId: string, jobId: string): CloudJobControl[];
  metrics(teamId: string, jobId: string): CloudJobMetrics | undefined;
}

export class CloudPacketActiveError extends Error {
  constructor(readonly activeJob: CloudJob) {
    super(`Packet ${activeJob.packetId} already has active cloud job ${activeJob.id}.`);
    this.name = 'CloudPacketActiveError';
  }
}
