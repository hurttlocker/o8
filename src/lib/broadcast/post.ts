import 'server-only';

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';

export const BROADCAST_TEXT_MAX_LENGTH = 2_000;
const LABEL_MAX_LENGTH = 160;

export type PostedBroadcastKind = 'commentary' | 'conversation';

export interface BroadcastPostInput {
  kind: PostedBroadcastKind;
  actor: string;
  audience?: string | null;
  text: string;
  refs?: {
    laneId?: string | null;
    packetId?: string | null;
  } | null;
}

export interface PostedBroadcastEvent {
  schema: 'o8/broadcast.posted-event/v1';
  id: string;
  kind: PostedBroadcastKind;
  actor: string;
  audience: string | null;
  text: string;
  refs: {
    laneId: string | null;
    packetId: string | null;
  };
  timestamp: string;
}

export class BroadcastPostError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BroadcastPostError';
  }
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BroadcastPostError(`${name} is required.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BroadcastPostError(
      `${name} must be at most ${maxLength.toLocaleString()} characters.`,
      `invalid_${name}`,
      400,
    );
  }
  return normalized;
}

function optionalText(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BroadcastPostError(`${name} must be a string.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > LABEL_MAX_LENGTH) {
    throw new BroadcastPostError(
      `${name} must be at most ${LABEL_MAX_LENGTH} characters.`,
      `invalid_${name}`,
      400,
    );
  }
  return normalized;
}

function normalizeRefs(value: unknown): { laneId: string | null; packetId: string | null } {
  if (value === undefined || value === null) return { laneId: null, packetId: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BroadcastPostError('refs must be an object.', 'invalid_refs', 400);
  }
  const refs = value as Record<string, unknown>;
  return {
    laneId: optionalText(refs.laneId, 'laneId'),
    packetId: optionalText(refs.packetId, 'packetId'),
  };
}

export function appendBroadcastEvent(
  input: BroadcastPostInput,
  options: {
    sqlite?: Database.Database;
    now?: Date;
    metadata?: Record<string, unknown>;
  } = {},
): PostedBroadcastEvent {
  if (input.kind !== 'commentary' && input.kind !== 'conversation') {
    throw new BroadcastPostError(
      'kind must be commentary or conversation.',
      'invalid_kind',
      400,
    );
  }
  const actor = requiredText(input.actor, 'actor', LABEL_MAX_LENGTH);
  const audience = optionalText(input.audience, 'audience');
  const text = requiredText(input.text, 'text', BROADCAST_TEXT_MAX_LENGTH);
  const refs = normalizeRefs(input.refs);
  const timestamp = (options.now ?? new Date()).toISOString();
  const event: PostedBroadcastEvent = {
    schema: 'o8/broadcast.posted-event/v1',
    id: `broadcast-${randomUUID()}`,
    kind: input.kind,
    actor,
    audience,
    text,
    refs,
    timestamp,
  };
  const sqlite = options.sqlite ?? getSqlite();
  ensureV44BroadcastSchema(sqlite);
  sqlite.prepare(`
    INSERT INTO broadcast_events
      (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.kind,
    event.actor,
    event.audience,
    event.text,
    event.refs.laneId,
    event.refs.packetId,
    JSON.stringify(options.metadata ?? {}),
    event.timestamp,
  );
  return event;
}

export function handleBroadcastPost(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): PostedBroadcastEvent {
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    throw new BroadcastPostError(
      'Broadcast posting requires an operator or packet-bound worker credential.',
      'broadcast_post_forbidden',
      403,
    );
  }
  if (principal.role === 'worker' && !principal.packetId) {
    throw new BroadcastPostError(
      'Broadcast posting requires a packet-bound worker credential.',
      'broadcast_packet_worker_required',
      403,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BroadcastPostError('A JSON object is required.', 'invalid_broadcast_post', 400);
  }
  const body = input as Record<string, unknown>;
  const refs = normalizeRefs(body.refs);
  if (principal.role === 'worker') {
    if (refs.packetId && refs.packetId !== principal.packetId) {
      throw new BroadcastPostError(
        'A worker can post only for its bound packet.',
        'worker_packet_mismatch',
        403,
      );
    }
    refs.packetId = principal.packetId;
  }
  return appendBroadcastEvent({
    kind: body.kind as PostedBroadcastKind,
    actor: body.actor as string,
    audience: body.audience as string | null | undefined,
    text: body.text as string,
    refs,
  }, { sqlite });
}
