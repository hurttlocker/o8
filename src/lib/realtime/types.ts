import type { BrowserAttachmentSummary, BrowserInventorySnapshot } from '@/lib/browser/types';
import type { FleetSnapshot, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';

export const REALTIME_PROTOCOL_VERSION = 1 as const;

export type RealtimeStreamKey = 'global' | `session:${string}`;

export type RealtimeHealthState = 'live' | 'warming' | 'stale' | 'degraded';
export type RealtimeDeliveryMode = 'live' | 'replay' | 'bootstrap';

export interface RealtimeHealthDescriptor {
  state: RealtimeHealthState;
  reason?: string;
}

export interface RealtimeSubscription {
  stream: RealtimeStreamKey;
  since?: number;
}

export interface RealtimeMutationRecord {
  mutationId: string;
  source: 'desktop' | 'mobile' | 'server';
  action: string;
  status: 'pending' | 'queued' | 'completed' | 'failed';
  runtime?: string;
  surfaceId?: string;
  sessionKey?: string;
  note?: string;
  optimistic?: boolean;
  createdAt: string;
  settledAt?: string;
}

export interface RuntimeRealtimeSnapshotPayload {
  fleet: FleetSnapshot;
}

export interface ReviewRealtimeSnapshotPayload {
  review: WorkflowReviewSnapshot | null;
  error?: string | null;
}

export interface BrowserRealtimeSnapshotPayload {
  browserInventory: BrowserInventorySnapshot;
  attachedBrowser?: BrowserAttachmentSummary | null;
  error?: string | null;
}

export interface MobileInboxRealtimeSnapshotPayload {
  inbox: MobileInboxSnapshot;
}

export interface SessionHistoryRealtimePayload {
  sessionKey: string;
  entries: MobileTranscriptEntry[];
  replace?: boolean;
}

export type RealtimeEventPayload =
  | RuntimeRealtimeSnapshotPayload
  | ReviewRealtimeSnapshotPayload
  | BrowserRealtimeSnapshotPayload
  | MobileInboxRealtimeSnapshotPayload
  | SessionHistoryRealtimePayload
  | { mutation: RealtimeMutationRecord };

export type RealtimeEventName =
  | 'runtime.snapshot'
  | 'review.snapshot'
  | 'browser.snapshot'
  | 'mobile.inbox.snapshot'
  | 'history.snapshot'
  | 'mutation.record'
  | 'mutation.settled';

export type RealtimeChannel =
  | 'runtime'
  | 'review'
  | 'browser'
  | 'mobile'
  | 'history'
  | 'mutation';

export interface RealtimeEventEnvelope<T extends RealtimeEventPayload = RealtimeEventPayload> {
  protocol: typeof REALTIME_PROTOCOL_VERSION;
  seq: number;
  capturedSeq?: number;
  stream: RealtimeStreamKey;
  channel: RealtimeChannel;
  event: RealtimeEventName;
  ts: string;
  snapshot?: boolean;
  delivery?: RealtimeDeliveryMode;
  entityId?: string;
  health?: RealtimeHealthDescriptor;
  data: T;
}

export interface RealtimeBatchMessage {
  delivery: RealtimeDeliveryMode;
  stream: RealtimeStreamKey;
  events: RealtimeEventEnvelope[];
  latestSeq: number;
  gap?: {
    requestedSince: number;
    earliestAvailable: number;
  };
}

export type RealtimeRefreshTarget = 'global' | 'mobileInbox' | 'sessionHistory';

export interface RealtimeRefreshRequest {
  kind: 'refresh';
  targets: RealtimeRefreshTarget[];
  sessionKeys?: string[];
  fresh?: boolean;
  reason?: string;
}

export interface RealtimeMutationPublishRequest {
  kind: 'mutation';
  mutation: RealtimeMutationRecord;
  refreshTargets?: RealtimeRefreshTarget[];
  sessionKeys?: string[];
  fresh?: boolean;
}

export type RealtimeInternalRequest = RealtimeRefreshRequest | RealtimeMutationPublishRequest;

export interface RealtimeEntityState {
  fleet: FleetSnapshot | null;
  review: WorkflowReviewSnapshot | null;
  reviewError: string | null;
  browserInventory: BrowserInventorySnapshot | null;
  attachedBrowser: BrowserAttachmentSummary | null;
  browserError: string | null;
  mobileInbox: MobileInboxSnapshot | null;
  transcripts: Record<string, MobileTranscriptEntry[]>;
  mutations: Record<string, RealtimeMutationRecord>;
  streamSeq: Partial<Record<RealtimeStreamKey, number>>;
  entitySeq: Record<string, number>;
  connection: {
    transport: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    realtimeState: RealtimeHealthState;
    lastEventAt?: string;
    healthByChannel: Partial<Record<RealtimeChannel, RealtimeHealthDescriptor>>;
  };
}
