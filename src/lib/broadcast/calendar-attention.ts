import 'server-only';

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';

const MAX_EVENT_ID_LENGTH = 500;
const MAX_TITLE_LENGTH = 240;
const MAX_CALENDAR_LENGTH = 160;
const MAX_LOCAL_TIME_LENGTH = 64;

export type CalendarAttentionResult = {
  status: 'recorded' | 'duplicate' | 'ignored';
  eventId: string | null;
  reason: string | null;
};

export class CalendarAttentionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CalendarAttentionError';
  }
}

function requiredString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new CalendarAttentionError(`${name} is required.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new CalendarAttentionError(`${name} is too long.`, `invalid_${name}`, 400);
  }
  return normalized;
}

function requiredEpoch(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new CalendarAttentionError(`${name} must be epoch milliseconds.`, `invalid_${name}`, 400);
  }
  return Number(value);
}

function stableEventId(calendarEventId: string, startEpochMs: number): string {
  const digest = createHash('sha256')
    .update(calendarEventId)
    .update('\0')
    .update(String(startEpochMs))
    .digest('hex');
  return `calendar-attention-${digest}`;
}

export function recordCalendarAttention(
  input: unknown,
  principal: RequestPrincipalContext,
  options: {
    sqlite?: Database.Database;
    nowMs?: number;
    policy?: {
      broadcastVoice: 'off' | 'on';
      broadcastVoiceCalendar: boolean;
      broadcastVoiceCalendarLeadMinutes: number;
    };
  } = {},
): CalendarAttentionResult {
  if (principal.role !== 'operator') {
    throw new CalendarAttentionError(
      'Calendar attention ingestion requires an operator credential.',
      'calendar_attention_forbidden',
      403,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CalendarAttentionError('A JSON object is required.', 'invalid_calendar_attention', 400);
  }
  const body = input as Record<string, unknown>;
  const calendarEventId = requiredString(body.eventId, 'eventId', MAX_EVENT_ID_LENGTH);
  const title = requiredString(body.title, 'title', MAX_TITLE_LENGTH);
  const calendar = requiredString(body.calendar, 'calendar', MAX_CALENDAR_LENGTH);
  const startLocal = requiredString(body.startLocal, 'startLocal', MAX_LOCAL_TIME_LENGTH);
  const endLocal = requiredString(body.endLocal, 'endLocal', MAX_LOCAL_TIME_LENGTH);
  const startEpochMs = requiredEpoch(body.startEpochMs, 'startEpochMs');
  const endEpochMs = requiredEpoch(body.endEpochMs, 'endEpochMs');
  if (endEpochMs <= startEpochMs) {
    throw new CalendarAttentionError('endEpochMs must follow startEpochMs.', 'invalid_endEpochMs', 400);
  }
  if (typeof body.allDay !== 'boolean') {
    throw new CalendarAttentionError('allDay must be boolean.', 'invalid_allDay', 400);
  }

  const nowMs = options.nowMs ?? Date.now();
  const values = options.policy ?? getOperatorDefaultsSync().values;
  if (values.broadcastVoice !== 'on' || !values.broadcastVoiceCalendar) {
    return { status: 'ignored', eventId: null, reason: 'calendar_attention_disabled' };
  }
  if (body.allDay) {
    return { status: 'ignored', eventId: null, reason: 'all_day_event' };
  }
  const leadMinutes = values.broadcastVoiceCalendarLeadMinutes;
  if (startEpochMs <= nowMs || startEpochMs > nowMs + leadMinutes * 60_000) {
    return { status: 'ignored', eventId: null, reason: 'outside_lead_window' };
  }
  const minutesUntilStart = Math.max(1, Math.ceil((startEpochMs - nowMs) / 60_000));

  const sqlite = options.sqlite ?? getSqlite();
  ensureV45BroadcastFocusSchema(sqlite);
  const eventId = stableEventId(calendarEventId, startEpochMs);
  const result = sqlite.prepare(`
    INSERT OR IGNORE INTO broadcast_events
      (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
    VALUES (?, 'commentary', 'symon', NULL, ?, NULL, NULL, ?, ?)
  `).run(
    eventId,
    title,
    JSON.stringify({
      attentionKind: 'calendar_imminent',
      speechSuppressed: true,
      calendarEventId,
      calendarTitle: title,
      calendar,
      startEpochMs,
      endEpochMs,
      startLocal,
      endLocal,
      configuredLeadMinutes: leadMinutes,
      minutesUntilStart,
      allDay: false,
    }),
    new Date(nowMs).toISOString(),
  );
  return {
    status: result.changes === 1 ? 'recorded' : 'duplicate',
    eventId,
    reason: null,
  };
}
