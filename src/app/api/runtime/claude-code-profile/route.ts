import { NextRequest, NextResponse } from 'next/server';

import {
  readClaudeCodeWorkerProfileSync,
  resolveClaudeCodeWorkerGatewayKey,
  selectedClaudeCodeWorkerModelSync,
  writeClaudeCodeWorkerProfile,
} from '@/lib/claude-code/worker-profile';
import { getCodexSubscriptionProxyStatus } from '@/lib/claude-code/codex-subscription-proxy';
import {
  isClaudeCodeModelSource,
  normalizeClaudeCodeGatewayModel,
  normalizeClaudeCodeRepoSkillAllowlist,
} from '@/lib/claude-code/worker-profile-types';
import { invalidateRuntimeAuthCache } from '@/lib/runtimes/shared/auth-detect';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function responseBody() {
  const profile = readClaudeCodeWorkerProfileSync();
  const codexProxy = await getCodexSubscriptionProxyStatus();
  return {
    ok: true,
    profile,
    effectiveModel: selectedClaudeCodeWorkerModelSync(),
    openrouterConfigured: Boolean(await resolveClaudeCodeWorkerGatewayKey()),
    codexProxy,
    billing: profile.source === 'openrouter'
      ? 'api'
      : profile.source === 'codex-subscription'
        ? 'codex-subscription'
        : 'provider-account',
    codexSubscriptionSupported: true,
    codexSubscriptionReason: 'An unofficial localhost compatibility proxy can route Claude Code through Codex OAuth. Usage counts against the connected Codex subscription quota.',
  };
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  return NextResponse.json(await responseBody(), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isClaudeCodeModelSource(body.source)) {
    return NextResponse.json({ ok: false, error: 'source must be "native", "openrouter", or "codex-subscription".' }, { status: 400 });
  }
  const model = normalizeClaudeCodeGatewayModel(body.model);
  if (body.model !== null && body.model !== undefined && body.model !== '' && !model) {
    return NextResponse.json({ ok: false, error: 'model must be a provider-qualified model id.' }, { status: 400 });
  }
  const codexModel = normalizeClaudeCodeGatewayModel(body.codexModel);
  if (body.codexModel !== null && body.codexModel !== undefined && body.codexModel !== '' && !codexModel) {
    return NextResponse.json({ ok: false, error: 'codexModel must be a valid model id.' }, { status: 400 });
  }
  const repoSkillAllowlist = normalizeClaudeCodeRepoSkillAllowlist(body.repoSkillAllowlist);
  if (body.source === 'openrouter' && !await resolveClaudeCodeWorkerGatewayKey()) {
    return NextResponse.json({
      ok: false,
      error: 'Configure an API key in Settings > Models > API keys before selecting the API-billed carrier.',
    }, { status: 409 });
  }

  try {
    await writeClaudeCodeWorkerProfile({ source: body.source, model, codexModel, repoSkillAllowlist });
    // Claude readiness is derived from the stored carrier and cached for 60s. Without
    // this drop, switching carriers leaves dispatch judged against the previous one —
    // a native-to-gateway switch stays refused, and the reverse stays wrongly allowed.
    invalidateRuntimeAuthCache();
    return NextResponse.json(await responseBody(), {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Claude Code worker settings could not be saved.',
    }, { status: 500 });
  }
}
