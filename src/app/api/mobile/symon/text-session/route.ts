export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { resolveDeviceByToken } from '@/lib/mobile/device-registry';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import {
  normalizeMobileAskModelId,
  resolveMobileAskRoute,
} from '@/lib/mobile/ask-model-routing';
import { readSymonAgentContext, resolveSymonAgentScope } from '@/lib/mobile/symon-agent-context';
import {
  buildSymonTextPlannerInfoEval,
  type SymonTextPlannerSelection,
} from '@/lib/mobile/symon-text-eval';
import { createSymonTextSession } from '@/lib/mobile/symon-text-session-store';
import { getRuntimeAuthSnapshot } from '@/lib/runtimes/shared/auth-detect';

const POLL_INTERVAL_MS = 100;
const BRIDGE_TIMEOUT_MS = 5_000;

function requestBearer(request: NextRequest): string {
  const auth = request.headers.get('authorization');
  return auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

function webviewClient(): O8WebviewClient {
  const global = globalThis as { __o8SymonTextClient?: O8WebviewClient };
  global.__o8SymonTextClient ??= new O8WebviewClient();
  return global.__o8SymonTextClient;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PlannerInfo {
  available?: boolean;
  engine?: 'claude' | 'codex';
  model?: string;
  effort?: string;
  tools?: Array<Record<string, unknown>>;
  detail?: string;
}

async function readPlannerInfo(selection?: SymonTextPlannerSelection): Promise<PlannerInfo> {
  const code = buildSymonTextPlannerInfoEval(selection);
  const deadline = Date.now() + BRIDGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { result } = await webviewClient().evalJs(code);
    const parsed = JSON.parse(result) as { state?: string; info?: PlannerInfo; detail?: string };
    if (parsed.state === 'no_bridge') throw new Error('Symon text planner bridge is not mounted.');
    if (parsed.state === 'error') throw new Error(parsed.detail || 'Symon text planner bridge failed.');
    if (parsed.state === 'done' && parsed.info) return parsed.info;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Symon text planner bridge timed out.');
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
  let info: PlannerInfo;
  try {
    info = await readPlannerInfo(requestedPlanner ?? undefined);
    if (requestedPlanner && !info.available) {
      info = await readPlannerInfo();
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
