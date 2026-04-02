import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';
import { listApprovals } from '@/lib/approvals/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const sessionKeyFilter = request.nextUrl.searchParams.get('sessionKey') || undefined;

    const [snapshot, pendingAll] = await Promise.all([
      getRuntimeInventorySnapshot({ fleetMode: 'smart', fresh: true }),
      listApprovals({ status: 'pending' }),
    ]);

    // ── Agents ──
    const sessions = snapshot.agents ?? [];
    const filteredSessions = sessionKeyFilter
      ? sessions.filter((s) => s.sessionKey === sessionKeyFilter)
      : sessions;

    const agents = filteredSessions.map((s) => ({
      name: s.name || s.sessionKey,
      repo: s.workspace?.split('/').pop() || 'unknown',
      runtime: s.runtime || 'unknown',
      status: s.status || 'idle',
      branch: s.branch || 'main',
      elapsed: s.lastEventAt || '',
      sessionKey: s.sessionKey,
      task: s.currentTask || null,
    }));

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
    const runningCount = agents.filter((a) => a.status === 'running').length;
    const latestEvent = recentActivity[0];
    const lastDesc = latestEvent
      ? `Last: ${latestEvent.action}${latestEvent.target ? ` ${latestEvent.target}` : ''}`
      : 'No recent activity';
    const summary = `${runningCount} agent${runningCount === 1 ? '' : 's'} running. ${approvals.count} approval${approvals.count === 1 ? '' : 's'} pending. ${lastDesc}`;

    return NextResponse.json(
      { summary, agents, approvals, recentActivity },
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
