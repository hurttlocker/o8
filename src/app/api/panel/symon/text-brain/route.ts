export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import {
  isSymonTextBrainMode,
  readSymonTextBrainMode,
  writeSymonTextBrainMode,
} from '@/lib/symon/durable/text-brain-setting';

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json({ ok: true, mode: readSymonTextBrainMode() });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as { mode?: unknown } | null;
  if (!isSymonTextBrainMode(body?.mode)) {
    return NextResponse.json({ ok: false, error: 'invalid_mode' }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, mode: writeSymonTextBrainMode(body.mode) });
  } catch {
    return NextResponse.json({ ok: false, error: 'write_failed' }, { status: 500 });
  }
}
