import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { listApprovals, listUnsettledApprovalContinuations } from '@/lib/approvals/store';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { buildOperatorStatusAgents, summarizeOperatorStatus } from '@/lib/orchestrator/operator-status-model';
import { readTranscriptActivityBySession } from '@/lib/orchestrator/operator-mission-service/mission-status-transcript';
import { listTerminalReviewQueueEvidence } from '@/lib/terminal-status/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface OperatorActivityCandidate {
  action: string;
  target: string;
  timestamp: string;
  laneId: string | null;
  packetId: string | null;
  sessionKey: string;
}

// Sources are mixed formats — `lane.lastEventAt` (Date#toISOString, always
// `.mmmZ`) and transcript `lastTranscriptAt` (provider-controlled, may come
// through as `+00:00`). `localeCompare` on the raw string only agrees with
// real chronological order when both sides share the same offset/fraction
// shape, so two entries at the same moment written differently can sort
// backwards (#2047). Compare parsed epoch milliseconds instead; a timestamp
// that fails to parse sorts as oldest so a bad value never jumps the queue.
function timestampEpochOrOldest(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function relativeActivityAge(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return 'just now';
  const ageMs = Math.max(0, Date.now() - parsed);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ageMs < minute) return 'just now';
  if (ageMs < hour) return `${Math.max(1, Math.round(ageMs / minute))}m ago`;
  if (ageMs < day) return `${Math.max(1, Math.round(ageMs / hour))}h ago`;
  return `${Math.max(1, Math.round(ageMs / day))}d ago`;
}

export async function GET(request: NextRequest) {
  try {
    const sessionKeyFilter = request.nextUrl.searchParams.get('sessionKey') || undefined;

    const snapshot = await getRuntimeInventorySnapshot({ fresh: true });
    const pendingApprovals = listApprovals({ status: 'pending' });
    const pendingAll = [
      ...pendingApprovals,
      ...listUnsettledApprovalContinuations(),
    ];

    // ── Agents ──
    const sessions = snapshot.agents ?? [];
    const lanes = listLanes();
    const laneEventsByLaneId = new Map(
      lanes.map((lane) => [lane.id, getLaneEvents(lane.id, 200)]),
    );
    const agents = buildOperatorStatusAgents(sessions, lanes, sessionKeyFilter, {
      laneEventsByLaneId,
      approvals: pendingApprovals,
      reviewQueue: listTerminalReviewQueueEvidence(),
    });
    const laneBySessionKey = new Map(
      lanes
        .filter((lane) => lane.sessionKey)
        .map((lane) => [lane.sessionKey as string, lane]),
    );
    const transcriptActivityBySession = await readTranscriptActivityBySession(
      agents
        .filter((agent) => laneBySessionKey.has(agent.sessionKey))
        .map((agent) => agent.sessionKey),
    );
    const spendCapHits = lanes.flatMap((lane) => getLaneEvents(lane.id, 200)
      .filter((event) => event.verb === 'spend_cap_hit')
      .map((event) => ({
        ...event.payload,
        laneId: lane.id,
        packetId: typeof event.payload.packetId === 'string' && event.payload.packetId.trim()
          ? event.payload.packetId
          : lane.packetId,
        timestamp: event.timestamp,
      })))
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 10);

    // ── Approvals ──
    const pending = sessionKeyFilter
      ? pendingAll.filter((a) => a.sessionKey === sessionKeyFilter)
      : pendingAll;

    const approvals = {
      count: pending.length,
      items: pending.slice(0, 5).map((a) => ({
        id: a.id,
        title: a.title,
        risk: a.risk || 'medium',
        tool: a.toolName || '',
        agent: a.sessionKey || '',
        created: a.createdAt,
      })),
    };

    // ── Timeline ──
    // Keep runtime transcript activity and durable lane lifecycle activity as
    // separate candidates. A steer writes both in close succession; collapsing
    // to only the newest timestamp would hide the transcript signal that proves
    // the worker is still advancing.
    const activityCandidates: OperatorActivityCandidate[] = agents.flatMap((agent) => {
      const lane = laneBySessionKey.get(agent.sessionKey);
      const target = lane?.label || agent.name;
      const candidates: OperatorActivityCandidate[] = [];
      const lastTranscriptAt = transcriptActivityBySession.get(agent.sessionKey)?.lastTranscriptAt;
      if (lastTranscriptAt) {
        candidates.push({
          action: 'transcript_activity',
          target,
          timestamp: lastTranscriptAt,
          laneId: lane?.id ?? null,
          packetId: lane?.packetId ?? null,
          sessionKey: agent.sessionKey,
        });
      }
      const laneActivityAt = lane?.lastEventAt || lane?.updatedAt;
      if (lane && laneActivityAt) {
        candidates.push({
          action: lane.lastEventLabel || lane.status,
          target,
          timestamp: laneActivityAt,
          laneId: lane.id,
          packetId: lane.packetId,
          sessionKey: agent.sessionKey,
        });
      } else if (agent.observedAt) {
        candidates.push({
          action: agent.status,
          target,
          timestamp: agent.observedAt,
          laneId: null,
          packetId: null,
          sessionKey: agent.sessionKey,
        });
      }
      return candidates;
    });
    const recentActivity = activityCandidates
      .filter((candidate) => Number.isFinite(Date.parse(candidate.timestamp)))
      .sort((left, right) => timestampEpochOrOldest(right.timestamp) - timestampEpochOrOldest(left.timestamp))
      .slice(0, 5)
      .map((candidate) => ({
        ...candidate,
        timeAgo: relativeActivityAge(candidate.timestamp),
      }));

    // ── Summary ──
    const summary = summarizeOperatorStatus({
      agents,
      approvalCount: approvals.count,
      recentActivity,
    });

    return NextResponse.json(
      { summary, agents, approvals, recentActivity, spendCapHits },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[operator-status]', message);
    return NextResponse.json(
      { error: 'Failed to build operator status', detail: message },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
