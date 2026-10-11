import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { CodexUpdateRefusal, updateSelectedCodex } from '@/lib/setup/codex-cli-update';
import { checkCliUpdates } from '@/lib/setup/cli-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const refresh = params.get('refresh') === '1';
    const runtimeId = params.get('runtime') === 'codex' ? 'codex' : undefined;
    return NextResponse.json({ tools: await checkCliUpdates(refresh, runtimeId), checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: 'Unable to check CLI updates.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ code: 'operator-required', error: 'Only the operator can install a CLI update.' }, { status: 403 });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      return NextResponse.json({ code: 'invalid-request', error: 'This action accepts no package, command, version, or path arguments.' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ code: 'invalid-request', error: 'Expected an empty JSON object.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateSelectedCodex());
  } catch (error) {
    const refusal = error instanceof CodexUpdateRefusal ? error : new CodexUpdateRefusal('update-failed', 'Unable to update Codex.', 503);
    return NextResponse.json({ code: refusal.code, error: refusal.message }, { status: refusal.status });
  }
}
