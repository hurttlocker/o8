export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import {
  normalizeMobileAskModelId,
  resolveMobileAskRoute,
} from '@/lib/mobile/ask-model-routing';
import { readSymonAgentContext, resolveSymonAgentScope } from '@/lib/mobile/symon-agent-context';
import {
  type SymonTextPlannerSelection,
} from '@/lib/mobile/symon-text-eval';
import { createSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import {
  readSymonTextPlannerInfo,
  type SymonTextPlannerInfo,
} from '@/lib/mobile/symon-text-bridge-client';
import { getRuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';

function requestBearer(request: NextRequest): string {
  const auth = request.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

async function resolveRequestedPlanner(value: unknown): Promise<SymonTextPlannerSelection | null> {
  const requestedModel = normalizeMobileAskModelId(value);
  if (requestedModel === 'auto') return null;
  try {
    const snapshot = await getRuntimeAuthSnapshot();
    const claude = snapshot.statuses.claude;
    const codex = snapshot.statuses.codex;
    const route = resolveMobileAskRoute(requestedModel, {
      claude: claude.installed && claude.authenticated,
      codex: codex.installed && codex.authenticated,
    });
    if (route.kind === 'managed') return null;
    return {
      engine: route.kind,
      model: route.cliModel,
      effort: route.effort,
    };
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') {
    return NextResponse.json(
      { ok: false, error: 'locked', detail: 'Symon text mode is not available to a dispatched worker.' },
      { status: 403 },
    );
  }
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', detail: 'Symon text mode requires the operator credential or an enrolled device.' },
      { status: 401 },
    );
  }
  const device = principal === 'device' ? resolveDeviceByToken(requestBearer(request)) : null;
  if (principal === 'device' && !device) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', detail: 'The enrolled phone identity could not be resolved.' },
      { status: 401 },
    );
  }

  const context = await readSymonAgentContext(request);
  const scope = await resolveSymonAgentScope(context);
  if (!scope) {
    return NextResponse.json(
      { ok: false, error: 'invalid_repo', detail: 'Code mode requires an exact registered repository.' },
      { status: 400 },
    );
  }

  const requestedPlanner = await resolveRequestedPlanner(context.model);
  let info: SymonTextPlannerInfo;
  try {
    info = await readSymonTextPlannerInfo(requestedPlanner ?? undefined);
    if (requestedPlanner && !info.available) {
      info = await readSymonTextPlannerInfo();
    }
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'Desktop bridge unavailable.' },
      { status: 503 },
    );
  }
  if (!info.available || !info.engine || !info.model || !info.effort) {
    return NextResponse.json(
      { ok: false, error: 'no_cli', detail: info.detail || 'No supported Symon planner CLI is installed.' },
      { status: 501 },
    );
  }
  const allowedTools = Array.from(new Set((info.tools ?? []).flatMap((tool) => {
    const name = tool.name;
    return typeof name === 'string' && /^[A-Za-z0-9_:-]{1,96}$/.test(name) ? [name] : [];
  })));
  try {
    const session = createSymonTextSession({
      subject: principal,
      deviceId: device?.id ?? null,
      engine: info.engine,
      model: info.model,
      effort: info.effort,
      workspaceMode: scope.workspaceMode,
      repoId: scope.repoId,
      repoPath: scope.repoPath,
      allowedTools,
    });
    return NextResponse.json({
      ok: true,
      session: {
        sessionId: session.sessionId,
        model: session.model,
        effort: session.effort,
        engine: session.engine,
        activeMachine: session.activeMachine,
      },
      scope: {
        version: 1,
        repoId: session.repoId,
        repoPath: session.repoPath,
        workspaceMode: session.workspaceMode,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: 'desktop_unavailable', detail: error instanceof Error ? error.message : 'Session persistence failed.' },
      { status: 503 },
    );
  }
}
