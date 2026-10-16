import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { CodexUpdateRefusal } from '@/lib/setup/codex-cli-update';
import { updateSelectedStableCli } from '@/lib/setup/stable-cli-update';
import { invalidateCliCache } from '@/lib/runtimes/shared/cli-resolver';
import { checkCliUpdates } from '@/lib/setup/cli-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const refresh = params.get('refresh') === '1';
    const runtimeId = params.get('runtime') ?? undefined;
    if (runtimeId && !['codex', 'claude-code', 'grok', 'gemini', 'antigravity'].includes(runtimeId)) return NextResponse.json({ error: 'Unknown CLI.' }, { status: 400 });
    if (refresh) {
      for (const id of runtimeId ? [runtimeId] : ['codex', 'claude-code', 'grok', 'gemini', 'antigravity']) invalidateCliCache(id);
    }
    return NextResponse.json({ tools: await checkCliUpdates(refresh, runtimeId), checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: 'Unable to check CLI updates.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ code: 'operator-required', error: 'Only the operator can install a CLI update.' }, { status: 403 });
  }
  let runtimeId: 'codex' | 'claude-code' | 'grok' = 'codex';
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'runtime')
      || ('runtime' in body && body.runtime !== 'codex' && body.runtime !== 'claude-code' && body.runtime !== 'grok')) {
      return NextResponse.json({ code: 'invalid-request', error: 'This action accepts no package, command, version, or path arguments.' }, { status: 400 });
    }
    if ('runtime' in body && body.runtime === 'claude-code') runtimeId = 'claude-code';
    if ('runtime' in body && body.runtime === 'grok') runtimeId = 'grok';
  } catch {
    return NextResponse.json({ code: 'invalid-request', error: 'Expected an empty object or a supported runtime.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await updateSelectedStableCli(runtimeId));
  } catch (error) {
    const refusal = error instanceof CodexUpdateRefusal ? error : new CodexUpdateRefusal('update-failed', 'Unable to update this CLI.', 503);
    return NextResponse.json({ code: refusal.code, error: refusal.message }, { status: refusal.status });
  }
}
