import { NextRequest, NextResponse } from 'next/server';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import {
  listMobileLiveActivityTokens,
  syncMobileLiveActivities,
} from '@/lib/mobile/live-activity-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SyncBody {
  fresh?: unknown;
}

export async function POST(req: NextRequest) {
  let body: SyncBody = {};
  try {
    const raw = await req.text();
    body = raw.trim() ? JSON.parse(raw) as SyncBody : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const tokenCount = listMobileLiveActivityTokens().length;
    if (tokenCount === 0) {
      return NextResponse.json({
        ok: true,
        tokenCount,
        pushed: 0,
        skipped: 0,
        failed: 0,
        results: [],
      });
    }

    const inbox = await getMobileInboxSnapshot({ fresh: body.fresh === true });
    const result = await syncMobileLiveActivities(inbox);
    return NextResponse.json({ tokenCount, ...result });
  } catch (error) {
    console.error('[mobile/live-activity/sync] failed', error);
    return NextResponse.json({ error: 'Failed to sync Live Activity updates.' }, { status: 500 });
  }
}
