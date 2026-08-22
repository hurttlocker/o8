import 'server-only';

import type Database from 'better-sqlite3';

import { callCodex, type CallCodexOptions } from '@/lib/cortex/qa/llm/codex-adapter';
import { getSqlite } from '@/lib/db';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveBrainCodexRouteSync } from '@/lib/operator/brain-routing';
import { buildBroadcastCommentaryPrompt } from './commentary-prompt';
import { listRecentBroadcastEvents } from './events';
import { appendBroadcastEvent, BROADCAST_TEXT_MAX_LENGTH } from './post';

const DIRECTOR_TICK_MS = 30_000;
const FEED_SLICE_LIMIT = 100;

export interface BroadcastDirectorSettings {
  broadcastCommentary: 'off' | 'interval';
  intervalMinutes: number;
  minNewEvents: number;
  maxPerHour: number;
}

export type BroadcastCommentaryRunner = (
  prompt: string,
  options: Pick<CallCodexOptions, 'model' | 'reasoningEffort'>,
) => Promise<string>;

export interface BroadcastDirectorResult {
  status: 'posted' | 'skipped';
  reason: 'posted' | 'off' | 'in_flight' | 'interval' | 'no_new_events' | 'min_new_events' | 'max_per_hour';
  eventId?: string;
  newEventCount?: number;
}

interface DirectorRunRow {
  created_at: string;
}

let commentaryInFlight = false;
let directorTimer: NodeJS.Timeout | null = null;

export function resolveBroadcastDirectorSettings(): BroadcastDirectorSettings {
  const values = getOperatorDefaultsSync().values;
  return {
    broadcastCommentary: values.broadcastCommentary,
    intervalMinutes: values.broadcastCommentaryIntervalMinutes,
    minNewEvents: values.broadcastCommentaryMinNewEvents,
    maxPerHour: values.broadcastCommentaryMaxPerHour,
  };
}

function lastDirectorRun(sqlite: Database.Database): DirectorRunRow | null {
  return sqlite.prepare(`
    SELECT created_at
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND actor = 'mister'
      AND json_extract(metadata_json, '$.director') = 1
    ORDER BY created_at DESC, sequence DESC
    LIMIT 1
  `).get() as DirectorRunRow | undefined ?? null;
}

export function broadcastGeneratedLinesSince(sqlite: Database.Database, timestamp: string): number {
  const row = sqlite.prepare(`
    SELECT COUNT(*) AS count
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND (
        json_extract(metadata_json, '$.director') = 1
        OR json_extract(metadata_json, '$.hourlyCapped') = 1
      )
      AND created_at >= ?
  `).get(timestamp) as { count: number };
  return row.count;
}

export async function runBroadcastDirectorOnce(options: {
  sqlite?: Database.Database;
  now?: Date;
  settings?: BroadcastDirectorSettings;
  runner?: BroadcastCommentaryRunner;
  model?: string;
  reasoningEffort?: CallCodexOptions['reasoningEffort'];
} = {}): Promise<BroadcastDirectorResult> {
  const settings = options.settings ?? resolveBroadcastDirectorSettings();
  if (settings.broadcastCommentary === 'off') return { status: 'skipped', reason: 'off' };
  if (commentaryInFlight) return { status: 'skipped', reason: 'in_flight' };

  const sqlite = options.sqlite ?? getSqlite();
  ensureV44BroadcastSchema(sqlite);
  const now = options.now ?? new Date();
  const lastRun = lastDirectorRun(sqlite);
  if (lastRun) {
    const intervalMs = settings.intervalMinutes * 60_000;
    if (now.getTime() - Date.parse(lastRun.created_at) < intervalMs) {
      return { status: 'skipped', reason: 'interval' };
    }
  }
  if (broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) >= settings.maxPerHour) {
    return { status: 'skipped', reason: 'max_per_hour' };
  }

  const recent = listRecentBroadcastEvents({ limit: FEED_SLICE_LIMIT }, sqlite).events;
  const newEvents = recent.filter((event) => (
    (!lastRun || event.timestamp > lastRun.created_at)
    && !(event.kind === 'commentary' && event.actor === 'mister')
  ));
  if (newEvents.length === 0) return { status: 'skipped', reason: 'no_new_events', newEventCount: 0 };
  if (newEvents.length < settings.minNewEvents) {
    return { status: 'skipped', reason: 'min_new_events', newEventCount: newEvents.length };
  }

  commentaryInFlight = true;
  try {
    const route = options.model
      ? { model: options.model, reasoningEffort: options.reasoningEffort }
      : resolveBrainCodexRouteSync();
    const runner = options.runner ?? callCodex;
    const output = (await runner(buildBroadcastCommentaryPrompt(newEvents), route)).trim();
    const text = output.replace(/\s+/g, ' ').slice(0, BROADCAST_TEXT_MAX_LENGTH).trim();
    if (!text) throw new Error('Broadcast commentary runner returned no text.');
    if (broadcastGeneratedLinesSince(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) >= settings.maxPerHour) {
      return { status: 'skipped', reason: 'max_per_hour', newEventCount: newEvents.length };
    }
    const event = appendBroadcastEvent({
      kind: 'commentary',
      actor: 'mister',
      text,
    }, {
      sqlite,
      now,
      metadata: {
        director: true,
        model: route.model,
        reasoningEffort: route.reasoningEffort ?? null,
        feedEventCount: newEvents.length,
      },
    });
    return {
      status: 'posted',
      reason: 'posted',
      eventId: event.id,
      newEventCount: newEvents.length,
    };
  } finally {
    commentaryInFlight = false;
  }
}

export function startBroadcastDirectorLoop(): () => void {
  if (directorTimer) return () => undefined;
  const tick = () => {
    void runBroadcastDirectorOnce().catch((error) => {
      console.warn(`[broadcast-director] ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  tick();
  directorTimer = setInterval(tick, DIRECTOR_TICK_MS);
  directorTimer.unref();
  return () => {
    if (directorTimer) clearInterval(directorTimer);
    directorTimer = null;
  };
}
