import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { listApprovals, listUnsettledApprovalContinuations } from '@/lib/approvals/store';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { buildOperatorStatusAgents, summarizeOperatorStatus } from '@/lib/orchestrator/operator-status-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessionKeyFilter = request.nextUrl.searchParams.get('sessionKey') || undefined;

    const [snapshot, pendingAll] = await Promise.all([
      getRuntimeInventorySnapshot({ fresh: true }),
      [
        ...listApprovals({ status: 'pending' }),
        ...listUnsettledApprovalContinuations(),
      ],
    ]);

    // ── Agents ──
    const sessions = snapshot.agents ?? [];
    const lanes = listLanes();
    const agents = buildOperatorStatusAgents(sessions, lanes, sessionKeyFilter);
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
    const events: Array<Record<string, unknown>> = [];

    const recentActivity = events.slice(0, 5).map((e) => ({
      action: (e.action as string) || (e.type as string) || '',
      target: (e.title as string) || (e.target as string) || '',
      timeAgo: (e.age as string) || (e.timeAgo as string) || '',
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
