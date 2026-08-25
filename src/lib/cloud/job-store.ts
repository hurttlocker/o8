import type { LaunchOptions } from '@/lib/runtimes/types';

export type CloudJobStatus = 'pending' | 'leased' | 'completed' | 'parked' | 'cancelled';

export type CloudJobEventType =
  | 'accepted'
  | 'claimed'
  | 'chunk'
  | 'heartbeat'
  | 'completed'
  | 'errored'
  | 'lease_recovered'
  | 'cancelled';

export interface CloudJob {
  id: string;
  teamId: string;
  cursor: number;
  idempotencyKey: string;
  packetId?: string;
  launch: LaunchOptions;
  status: CloudJobStatus;
  enqueuedAt: string;
  claimedAt?: string;
  claimedBy?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
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

export interface EnqueueCloudJobInput {
  id: string;
  teamId: string;
  idempotencyKey: string;
  packetId?: string;
  launch: LaunchOptions;
  maxAttempts?: number;
  nowMs?: number;
}

export interface ClaimCloudJobInput {
  teamId: string;
  cursor: number;
  workerId: string;
  leaseMs: number;
  nowMs?: number;
}

export interface AppendCloudJobEventInput {
  teamId: string;
  jobId: string;
  workerId: string;
  leaseToken: string;
  type: Extract<CloudJobEventType, 'chunk' | 'heartbeat' | 'completed' | 'errored'>;
  payload: unknown;
  leaseMs: number;
  nowMs?: number;
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

export interface CloudJobStore {
  enqueue(input: EnqueueCloudJobInput): CloudJob;
  claimNext(input: ClaimCloudJobInput): CloudJob | null;
  appendEvent(input: AppendCloudJobEventInput): AppendCloudJobEventResult;
  recoverExpiredLeases(teamId: string, nowMs?: number): number;
  cancel(teamId: string, jobId: string, nowMs?: number): CloudJob | undefined;
  get(teamId: string, jobId: string): CloudJob | undefined;
  list(teamId: string, limit?: number): CloudJob[];
  readEvents(teamId: string, jobId: string, sinceId?: number, limit?: number): CloudJobEvent[];
}

export class CloudPacketActiveError extends Error {
  constructor(readonly activeJob: CloudJob) {
    super(`Packet ${activeJob.packetId} already has active cloud job ${activeJob.id}.`);
    this.name = 'CloudPacketActiveError';
  }
}
