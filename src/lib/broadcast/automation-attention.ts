import 'server-only';

import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { BROADCAST_TEXT_MAX_LENGTH } from './post';

export type AutomationAttentionResult = {
  status: 'recorded' | 'duplicate' | 'ignored';
  eventId: string | null;
  reason: string | null;
};

export class AutomationAttentionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AutomationAttentionError';
  }
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AutomationAttentionError('text is required.', 'invalid_text', 400);
  }
  const normalized = value.trim();
  if (normalized.length > BROADCAST_TEXT_MAX_LENGTH) {
    throw new AutomationAttentionError(
      `text must be at most ${BROADCAST_TEXT_MAX_LENGTH.toLocaleString()} characters.`,
      'invalid_text',
      400,
    );
  }
  return normalized;
}

function stableEventId(packetId: string): string {
  return `automation-attention-${createHash('sha256').update(packetId).digest('hex')}`;
}

export function recordAutomationAttention(
  input: unknown,
  principal: RequestPrincipalContext,
  options: {
    sqlite?: Database.Database;
    now?: Date;
    policy?: {
      broadcastVoice: 'off' | 'on';
      broadcastVoiceTimeCheckins: boolean;
    };
  } = {},
): AutomationAttentionResult {
  if (principal.role !== 'worker' || !principal.packetId) {
    throw new AutomationAttentionError(
      'Scheduled Symon attention requires a packet-bound automation worker.',
      'automation_attention_forbidden',
      403,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AutomationAttentionError('A JSON object is required.', 'invalid_automation_attention', 400);
  }
  const text = requiredText((input as Record<string, unknown>).text);
  const sqlite = options.sqlite ?? getSqlite();
  const lane = sqlite.prepare(`
    SELECT id, label FROM lanes
    WHERE packet_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(principal.packetId) as { id: string; label: string } | undefined;
  if (!lane || !lane.label.startsWith('[automation] ')) {
    throw new AutomationAttentionError(
      'Only a durable o8 automation lane can schedule a Symon attention line.',
      'automation_lane_required',
      403,
    );
  }

  const policy = options.policy ?? getOperatorDefaultsSync().values;
  if (policy.broadcastVoice !== 'on' || !policy.broadcastVoiceTimeCheckins) {
    return { status: 'ignored', eventId: null, reason: 'scheduled_attention_disabled' };
  }

  ensureV45BroadcastFocusSchema(sqlite);
  const eventId = stableEventId(principal.packetId);
  if (sqlite.prepare('SELECT 1 AS present FROM broadcast_events WHERE id = ?').get(eventId)) {
    return { status: 'duplicate', eventId, reason: null };
  }
  const now = options.now ?? new Date();
  const inserted = sqlite.prepare(`
    INSERT OR IGNORE INTO broadcast_events
      (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
    VALUES (?, 'commentary', 'symon', NULL, ?, ?, ?, ?, ?)
  `).run(
    eventId,
    text,
    lane.id,
    principal.packetId,
    JSON.stringify({
      attentionKind: 'scheduled_attention',
      speechSuppressed: true,
      automationText: text,
      automationLabel: lane.label.slice('[automation] '.length),
    }),
    now.toISOString(),
  ).changes === 1;
  return { status: inserted ? 'recorded' : 'duplicate', eventId, reason: null };
}
