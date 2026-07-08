import { NextRequest, NextResponse } from 'next/server';
import {
  deleteMobileLiveActivityToken,
  upsertMobileLiveActivityToken,
} from '@/lib/mobile/live-activity-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RegisterBody {
  pushToken?: unknown;
  activityId?: unknown;
  bundleId?: unknown;
  environment?: unknown;
  deviceLabel?: unknown;
  /**
   * R3 (o8 Relay v1): the standard APNs remote-notification device token
   * (alert-capable), OPTIONAL. Registered alongside the ActivityKit `pushToken`
   * so the off-network relay can send a generic "approval waiting" alert push.
   */
  remoteNotificationToken?: unknown;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function environment(value: unknown) {
  if (value === 'production' || value === 'sandbox') return value;
  return undefined;
}

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = await req.json() as RegisterBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!nonEmptyString(body.pushToken)) {
    return NextResponse.json({ error: 'pushToken is required.' }, { status: 400 });
  }
  if (!/^[a-fA-F0-9]{32,}$/.test(body.pushToken.trim())) {
    return NextResponse.json({ error: 'pushToken must be an ActivityKit hex token.' }, { status: 400 });
  }
  // The remote-notification token is a hex APNs device token too; reject a
  // malformed one rather than storing garbage the relay would fail to push to.
  let remoteNotificationToken: string | null = null;
  if (nonEmptyString(body.remoteNotificationToken)) {
    const t = body.remoteNotificationToken.trim().toLowerCase();
    if (!/^[a-f0-9]{32,}$/.test(t)) {
      return NextResponse.json({ error: 'remoteNotificationToken must be a hex APNs token.' }, { status: 400 });
    }
    remoteNotificationToken = t;
  }

  try {
    const token = upsertMobileLiveActivityToken({
      pushToken: body.pushToken.trim().toLowerCase(),
      activityId: nonEmptyString(body.activityId) ? body.activityId.trim() : null,
      bundleId: nonEmptyString(body.bundleId) ? body.bundleId.trim() : null,
      environment: environment(body.environment),
      deviceLabel: nonEmptyString(body.deviceLabel) ? body.deviceLabel.trim() : null,
      remoteNotificationToken,
    });
    return NextResponse.json({
      ok: true,
      pushToken: token.pushToken,
      activityId: token.activityId,
      environment: token.environment,
      bundleId: token.bundleId,
    });
  } catch (error) {
    console.error('[mobile/live-activity/register] failed', error);
    return NextResponse.json({ error: 'Failed to register Live Activity token.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let body: { pushToken?: unknown };
  try {
    body = await req.json() as { pushToken?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!nonEmptyString(body.pushToken)) {
    return NextResponse.json({ error: 'pushToken is required.' }, { status: 400 });
  }

  try {
    return NextResponse.json({
      ok: true,
      removed: deleteMobileLiveActivityToken(body.pushToken.trim().toLowerCase()),
    });
  } catch (error) {
    console.error('[mobile/live-activity/register] delete failed', error);
    return NextResponse.json({ error: 'Failed to remove Live Activity token.' }, { status: 500 });
  }
}
