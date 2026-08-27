import { createHash } from 'node:crypto';

import { getSqlite } from '@/lib/db';
import { cancelAutomationFires, persistWatchAutomationFire, type AutomationFire } from './fire-store';
import {
  boundAutomationSourcePayload,
  ingestLaneAutomationSourceEvents,
  listAutomationSourceEvents,
  recordAutomationSourceEvent,
  type AutomationSourceEvent,
  type AutomationSourceKind,
} from './source-events';

const TERMINAL_MANAGED_RUN_EVENTS = new Set(['exit_clean', 'exit_failed', 'killed', 'lost']);

interface WatchRow {
  id: string;
  repo_path: string;
  watch_source_kind: AutomationSourceKind;
  watch_source_id: string | null;
  watch_event_types_json: string;
  watch_literal_filter: string | null;
  watch_quiet_ms: number | null;
  watch_min_interval_ms: number;
  watch_batch_window_ms: number;
  watch_max_fires_per_tick: number;
  watch_expires_at: number | null;
  watch_checkpoint: number;
  watch_last_fire_at: number | null;
}

function parseEventTypes(value: string): Set<string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())));
  } catch {
    return new Set();
  }
}

function batchedSourceEvent(events: AutomationSourceEvent[], batchWindowMs: number): AutomationSourceEvent {
  const first = events[0]!;
  const last = events.at(-1)!;
  if (events.length === 1) return first;
  const fingerprint = createHash('sha256')
    .update(events.map((event) => event.fingerprint).join('\n'))
    .digest('hex');
  return {
    sequence: last.sequence,
    sourceKind: first.sourceKind,
    sourceId: events.every((event) => event.sourceId === first.sourceId) ? first.sourceId : 'multiple',
    repoPath: first.repoPath,
    eventType: 'batch',
    fingerprint: `watch-batch:${fingerprint}`,
    payload: boundAutomationSourcePayload({
      provenance: { sourceKind: first.sourceKind, eventType: 'batch' },
      batchWindowMs,
      eventCount: events.length,
      events: events.map((event) => ({
        sourceId: event.sourceId,
        eventType: event.eventType,
        fingerprint: event.fingerprint,
        occurredAt: event.occurredAt,
        payload: event.payload,
      })),
    }),
    occurredAt: first.occurredAt,
    persistedAt: Math.max(...events.map((event) => event.persistedAt)),
  };
}

function materializeQuietSourceEvents(rows: WatchRow[], nowMs: number): number {
  const sqlite = getSqlite();
  let created = 0;
  for (const watch of rows) {
    if (watch.watch_source_kind !== 'managed_run' || !watch.watch_quiet_ms) continue;
    const clauses = ["source_kind = 'managed_run'"];
    const values: Array<string> = [];
    if (watch.repo_path) {
      clauses.push('repo_path = ?');
      values.push(watch.repo_path);
    }
    if (watch.watch_source_id) {
      clauses.push('source_id = ?');
      values.push(watch.watch_source_id);
    }
    const latestRows = sqlite.prepare(`
      SELECT event.* FROM automation_source_events event
      JOIN (
        SELECT source_id, MAX(sequence) AS sequence
        FROM automation_source_events
        WHERE ${clauses.join(' AND ')}
        GROUP BY source_id
      ) latest ON latest.sequence = event.sequence
    `).all(...values) as Array<{
      sequence: number;
      source_id: string;
      repo_path: string | null;
      event_type: string;
      occurred_at: number;
    }>;
    for (const latest of latestRows) {
      if (TERMINAL_MANAGED_RUN_EVENTS.has(latest.event_type) || latest.event_type === 'quiet') continue;
      if (nowMs - latest.occurred_at < watch.watch_quiet_ms) continue;
      recordAutomationSourceEvent({
        sourceKind: 'managed_run',
        sourceId: latest.source_id,
        repoPath: latest.repo_path,
        eventType: 'quiet',
        fingerprint: `managed-run:${latest.source_id}:quiet:${latest.sequence}:${watch.watch_quiet_ms}`,
        occurredAt: latest.occurred_at + watch.watch_quiet_ms,
        persistedAt: nowMs,
        payload: {
          quietMs: watch.watch_quiet_ms,
          lastSourceEventSequence: latest.sequence,
        },
      });
      created += 1;
    }
  }
  return created;
}

function watchRows(): WatchRow[] {
  return getSqlite().prepare(`
    SELECT id, repo_path, watch_source_kind, watch_source_id, watch_event_types_json,
           watch_literal_filter, watch_quiet_ms, watch_min_interval_ms,
           watch_batch_window_ms, watch_max_fires_per_tick, watch_expires_at, watch_checkpoint,
           watch_last_fire_at
    FROM automations
    WHERE enabled = 1 AND trigger_kind = 'watch' AND watch_source_kind IS NOT NULL
    ORDER BY created_at ASC
  `).all() as WatchRow[];
}

export function materializeWatchAutomationFires(
  nowMs: number = Date.now(),
  globalFireLimit: number = 64,
): AutomationFire[] {
  ingestLaneAutomationSourceEvents(1_000, nowMs);
  const rows = watchRows();
  materializeQuietSourceEvents(rows, nowMs);
  const sqlite = getSqlite();
  const fires: AutomationFire[] = [];

  for (const watch of rows) {
    if (watch.watch_expires_at != null && watch.watch_expires_at <= nowMs) {
      sqlite.prepare(`
        UPDATE automations
        SET enabled = 0, last_error_message = 'Watch expired.', updated_at = datetime('now')
        WHERE id = ?
      `).run(watch.id);
      cancelAutomationFires(watch.id, 'Watch expired.', nowMs);
      continue;
    }

    const acceptedTypes = parseEventTypes(watch.watch_event_types_json);
    const literal = watch.watch_literal_filter?.trim().toLowerCase() || null;
    const candidates = listAutomationSourceEvents({
      sourceKind: watch.watch_source_kind,
      afterSequence: watch.watch_checkpoint,
      repoPath: watch.repo_path,
      sourceId: watch.watch_source_id,
      limit: 200,
    });
    if (fires.length >= globalFireLimit) {
      if (candidates.length > 0) {
        sqlite.prepare(`
          UPDATE automations
          SET last_error_message = 'Global watch fan-out limit reached; source events remain queued.',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(watch.id);
      }
      continue;
    }
    let checkpoint = watch.watch_checkpoint;
    let lastFireAt = watch.watch_last_fire_at;
    let createdForWatch = 0;
    for (let candidateIndex = 0; candidateIndex < candidates.length;) {
      const event = candidates[candidateIndex];
      const matchesType = acceptedTypes.size === 0 || acceptedTypes.has(event.eventType);
      const matchesLiteral = !literal || JSON.stringify(event.payload).toLowerCase().includes(literal);
      if (!matchesType || !matchesLiteral) {
        checkpoint = event.sequence;
        candidateIndex += 1;
        continue;
      }
      if (watch.watch_batch_window_ms > 0 && nowMs - event.occurredAt < watch.watch_batch_window_ms) break;
      if (lastFireAt != null && nowMs - lastFireAt < watch.watch_min_interval_ms) break;
      if (createdForWatch >= Math.max(1, watch.watch_max_fires_per_tick) || fires.length >= globalFireLimit) {
        sqlite.prepare(`
          UPDATE automations
          SET last_error_message = 'Watch fan-out is rate-limited; matching events remain queued.',
              updated_at = datetime('now')
          WHERE id = ?
        `).run(watch.id);
        break;
      }
      const grouped = [event];
      let groupedThrough = event.sequence;
      candidateIndex += 1;
      if (watch.watch_batch_window_ms > 0) {
        while (candidateIndex < candidates.length && grouped.length < 16) {
          const candidate = candidates[candidateIndex];
          if (candidate.occurredAt > event.occurredAt + watch.watch_batch_window_ms) break;
          groupedThrough = candidate.sequence;
          const candidateMatchesType = acceptedTypes.size === 0 || acceptedTypes.has(candidate.eventType);
          const candidateMatchesLiteral = !literal || JSON.stringify(candidate.payload).toLowerCase().includes(literal);
          if (candidateMatchesType && candidateMatchesLiteral) grouped.push(candidate);
          candidateIndex += 1;
        }
      }
      const sourceEvent = batchedSourceEvent(grouped, watch.watch_batch_window_ms);
      const fire = sqlite.transaction(() => {
        const persisted = persistWatchAutomationFire(watch.id, sourceEvent, nowMs);
        if (!persisted) return undefined;
        sqlite.prepare(`
          UPDATE automations
          SET watch_checkpoint = ?, watch_last_fire_at = ?, last_error_message = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND enabled = 1
        `).run(groupedThrough, nowMs, watch.id);
        return persisted;
      }).immediate();
      if (!fire) break;
      fires.push(fire);
      checkpoint = groupedThrough;
      lastFireAt = nowMs;
      createdForWatch += 1;
    }
    if (checkpoint !== watch.watch_checkpoint) {
      sqlite.prepare(`
        UPDATE automations SET watch_checkpoint = ?, updated_at = datetime('now') WHERE id = ?
      `).run(checkpoint, watch.id);
    }
  }
  return fires;
}
