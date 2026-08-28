import 'server-only';

import type Database from 'better-sqlite3';

import type { BroadcastEvent } from './types';

export interface BroadcastAttentionPolicySettings {
  quietHours: 'off' | 'on';
  quietStart: string;
  quietEnd: string;
  attention: boolean;
  approvals: boolean;
  reviews: boolean;
  failures: boolean;
  completions: boolean;
  calendar: boolean;
  timeCheckins: boolean;
}

export type BroadcastAttentionSubscription =
  | 'attention'
  | 'approvals'
  | 'reviews'
  | 'failures'
  | 'completions'
  | 'calendar'
  | 'timeCheckins';

const ATTENTION_STATUSES = new Set([
  'awaiting_input',
  'awaiting_human',
]);

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isBroadcastQuietTime(
  now: Date,
  settings: Pick<BroadcastAttentionPolicySettings, 'quietHours' | 'quietStart' | 'quietEnd'>,
): boolean {
  if (settings.quietHours !== 'on') return false;
  const start = clockMinutes(settings.quietStart);
  const end = clockMinutes(settings.quietEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

export function attentionSubscriptionForEvent(
  event: BroadcastEvent,
): BroadcastAttentionSubscription | null {
  if (event.kind === 'operator_attention') return 'attention';
  if (event.kind === 'calendar_imminent') return 'calendar';
  if (event.kind === 'scheduled_attention') return 'timeCheckins';
  if (event.kind === 'approval') return 'approvals';
  if (event.kind === 'review_verdict') return 'reviews';
  if (event.kind === 'packet_failed' || event.kind === 'spend_cap' || event.kind === 'lease_timeout') {
    return 'failures';
  }
  if (event.kind === 'merge' || event.kind === 'agent_completed') return 'completions';
  return null;
}

export function attentionSubscriptionEnabled(
  event: BroadcastEvent,
  settings: BroadcastAttentionPolicySettings,
): boolean {
  const subscription = attentionSubscriptionForEvent(event);
  return subscription !== null && settings[subscription];
}

function stringPayload(event: BroadcastEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === 'string' && value ? value : null;
}

/**
 * Re-check the small set of attention events whose truth can disappear between
 * ingestion and speech. Historical results such as a merge or review verdict
 * remain truthful facts; pending approvals and waiting lanes must still be
 * pending/waiting at the instant Symon decides to speak.
 */
export function attentionEventIsCurrent(
  event: BroadcastEvent,
  sqlite: Database.Database,
  nowMs: number = Date.now(),
): boolean {
  if (event.kind === 'approval') {
    const approvalId = stringPayload(event, 'approvalId')
      ?? event.id.replace(/^approval:created:/, '');
    const row = sqlite.prepare('SELECT status FROM approvals WHERE id = ?').get(approvalId) as { status?: string } | undefined;
    if (row) return row.status === 'pending';
    if (!event.packetId && !event.laneId) return false;
    const pending = sqlite.prepare(`
      SELECT 1 AS present FROM approvals
      WHERE status = 'pending'
        AND (?1 IS NULL OR packet_id = ?1)
        AND (?2 IS NULL OR lane_id = ?2)
      LIMIT 1
    `).get(event.packetId, event.laneId) as { present?: number } | undefined;
    return pending?.present === 1;
  }
  if (event.kind === 'operator_attention') {
    if (!event.laneId) return false;
    const row = sqlite.prepare('SELECT status FROM lanes WHERE id = ?').get(event.laneId) as { status?: string } | undefined;
    return Boolean(row?.status && ATTENTION_STATUSES.has(row.status));
  }
  if (event.kind === 'calendar_imminent') {
    const startEpochMs = event.payload.startEpochMs;
    return typeof startEpochMs === 'number'
      && Number.isSafeInteger(startEpochMs)
      && startEpochMs > nowMs;
  }
  return true;
}
