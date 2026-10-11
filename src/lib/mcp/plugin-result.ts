import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';

import { getDb, laneEvents, sessionOutcomes } from '@/lib/db';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { redactSecrets } from '@/lib/telemetry/scrub';

const READY_STATES = new Set<OrchestratorPacket['status']>(['awaiting_review', 'released', 'archived', 'failed', 'blocked']);
const START_EVENTS = ['open_lane', 'attach_session', 'steered_packet', 'steer_run_admitted'];

function reportUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return '[url omitted]'; }
}

export function pluginResultText(value: string): string {
  return redactSecrets(value.replace(/```[\s\S]*?```/g, '[code omitted]'))
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    // Match complete web URLs first so a label colon can precede a private
    // path without also treating the slashes in https:// as a local path.
    .replace(/https?:\/\/[^\s`"'<>)]*|file:\/+[^\s`"'<>)]*|(?<![\w/])(?:\/[\w.]|[A-Za-z]:[\\/]|~[\\/]|\\\\)[^\s`"'<>)]*/gi,
      (match) => /^https?:\/\//i.test(match) ? reportUrl(match) : '[path omitted]')
    .slice(0, 1_200);
}

export function readPluginCompletion(mission: OrchestratorMissionState, packet: OrchestratorPacket) {
  const unavailable = (reason = 'unavailable') => ({ available: false as const, reason });
  if (!READY_STATES.has(packet.status)) return unavailable('in_progress');
  try {
    const db = getDb();
    const lane = findLatestLaneByPacket(packet.id);
    if (!db || !lane?.sessionKey || !mission.repoPath || lane.repoPath !== mission.repoPath) return unavailable();
    // A warm follow-up can reuse the same session. Its durable admission must
    // invalidate the preceding report even before the packet status changes.
    const latestStart = db.select({ timestamp: laneEvents.timestamp }).from(laneEvents)
      .where(and(eq(laneEvents.laneId, lane.id), or(
        inArray(laneEvents.verb, START_EVENTS),
        and(eq(laneEvents.verb, 'status_change'), sql`CASE WHEN json_valid(${laneEvents.payloadJson})
          THEN json_extract(${laneEvents.payloadJson}, '$.status') IN ('launching', 'running', 'recovering') ELSE 0 END`),
      )))
      .orderBy(desc(laneEvents.timestamp)).limit(1).get();
    const startedMs = Math.max(Date.parse(lane.createdAt), Date.parse(latestStart?.timestamp ?? lane.createdAt));
    const row = db.select({
      summary: sessionOutcomes.summary, outcome: sessionOutcomes.outcome,
      completedAt: sessionOutcomes.completedAt, changedFilesJson: sessionOutcomes.changedFilesJson,
    }).from(sessionOutcomes)
      .where(and(eq(sessionOutcomes.packetId, packet.id), eq(sessionOutcomes.laneId, lane.id),
        eq(sessionOutcomes.sessionKey, lane.sessionKey), eq(sessionOutcomes.repoPath, mission.repoPath)))
      .orderBy(desc(sessionOutcomes.completedAt)).limit(1).get();
    const completedMs = Date.parse(row?.completedAt ?? '');
    if (!row || !Number.isFinite(startedMs) || !Number.isFinite(completedMs)
      || completedMs < startedMs || completedMs > Date.now() || !row.summary.trim() || row.summary.trim() === '(no summary)') return unavailable();
    let changedFileCount: number | null = null;
    try {
      const files: unknown = JSON.parse(row.changedFilesJson);
      if (Array.isArray(files)) changedFileCount = Math.min(files.length, 50);
    } catch { /* A corrupt optional file list does not fabricate evidence. */ }
    return {
      available: true as const, source: 'worker_report' as const,
      summary: pluginResultText(row.summary), outcome: row.outcome,
      completedAt: row.completedAt, changedFileCount,
    };
  } catch {
    return unavailable();
  }
}
