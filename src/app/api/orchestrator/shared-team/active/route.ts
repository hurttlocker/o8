import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { readActiveSharedCheckoutTeam } from '@/lib/orchestrator/shared-checkout-team';
import { findOwnedLaunchByMutationId, readOwnedSessionDisplay } from '@/lib/runtimes/shared/owned-session-index';
import { readSharedTeamsForThread } from '@/lib/orchestrator/shared-team-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const repoPath = request.nextUrl.searchParams.get('repoPath')?.trim();
  if (!repoPath || !repoPath.startsWith('/') || repoPath.length > 4_096) {
    return NextResponse.json({ error: 'A valid repoPath is required.' }, { status: 400 });
  }
  try {
    const threadId = request.nextUrl.searchParams.get('threadId');
    if (threadId !== null) {
      if (!/^thoughts-[A-Za-z0-9_-]{1,80}$/.test(threadId)) {
        return NextResponse.json({ error: 'A valid threadId is required.' }, { status: 400 });
      }
      const teams = await readSharedTeamsForThread(repoPath, threadId);
      const members = new Map(teams.flatMap(team => team.members.filter(member => member.surfaceId)
        .map(member => [member.surfaceId!, member] as const)));
      const workers = await Promise.all([...members.values()].map(async member => {
        const session = await readOwnedSessionDisplay(member.surfaceId!);
        return { sessionKey: member.surfaceId!, name: member.taskName, runtime: member.runtime,
          status: session?.status ?? 'unknown' };
      }));
      return NextResponse.json({ threadId, workers }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const team = readActiveSharedCheckoutTeam(repoPath);
    const members = team ? await Promise.all(team.members.filter((member) => member.surfaceId)
      .map(async ({ surfaceId, runtime: workerRuntime, taskName, state, clientMutationId }) => {
        const launch = await findOwnedLaunchByMutationId(clientMutationId);
        return { surfaceId, runtime: workerRuntime, taskName, state,
          outcome: launch?.surfaceId === surfaceId ? launch.outcome : 'unknown' };
      })) : [];
    return NextResponse.json({
      team: team ? {
        repoPath: team.path,
        parentThreadId: team.parentThreadId,
        members,
      } : null,
    });
  } catch {
    return NextResponse.json({ error: 'Unable to read the active Fast team.' }, { status: 500 });
  }
}
