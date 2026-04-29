import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listDismissedFingerprints, recordDismissedSuggestion } from '@/lib/projects/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  try {
    const fingerprints = listDismissedFingerprints();
    return NextResponse.json({ fingerprints }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list dismissed suggestions.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface DismissBody {
  fingerprint?: unknown;
  reason?: unknown;
}

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  let body: DismissBody;
  try {
    body = (await req.json()) as DismissBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.trim() : '';
  if (!fingerprint) {
    return NextResponse.json({ error: 'fingerprint is required.' }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;

  try {
    recordDismissedSuggestion(fingerprint, reason);
    return NextResponse.json({ ok: true }, { status: 201, headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to record dismissal.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
