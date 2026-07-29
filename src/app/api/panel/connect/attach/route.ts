import { NextResponse } from 'next/server';

import {
  readConnectAttachSetting,
  writeConnectAttachEnabled,
} from '@/lib/connect/attach-settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ok: true, ...readConnectAttachSetting() });
}

export async function POST(request: Request) {
  const current = readConnectAttachSetting();
  if (current.locked) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'env_override',
        message: 'O8_CONNECT_ATTACH controls this setting for the current process.',
      },
      ...current,
    }, { status: 409 });
  }

  const body = await request.json().catch(() => null) as { enabled?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'enabled must be a boolean.',
      },
    }, { status: 400 });
  }

  try {
    return NextResponse.json({
      ok: true,
      ...writeConnectAttachEnabled(body.enabled),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: {
        code: 'settings_write_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }, { status: 500 });
  }
}
