import { NextResponse } from 'next/server';
import {
  registerManagedRun,
  finishManagedRun,
  killManagedRun,
  listManagedRuns,
} from '@/lib/runtimes/managed-runs/registry';
import { killTmuxSession } from '@/lib/terminal/tmux';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { serverTimingHeaders } from '@/lib/performance/server-timing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Managed-run sessions are always `cortex-run-<id>`; never let a caller act on any other session. */
const RUN_SESSION_RE = /^cortex-run-[A-Za-z0-9]+$/;
const MAX_FIELD = 4096; // cap persisted/echoed strings — no unbounded command/cwd

/** GET — list managed runs (reconciled against live tmux). */
export async function GET(request: Request) {
  const startedAt = performance.now();
  try {
    const principal = resolveRequestPrincipalContext(request);
    const allRuns = await listManagedRuns();
    const runs = principal.role === 'worker'
      ? allRuns.filter((run) => Boolean(principal.packetId) && run.packetId === principal.packetId)
      : allRuns;
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', runs },
      { headers: serverTimingHeaders(startedAt) },
    );
  } catch (err) {
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', runs: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: serverTimingHeaders(startedAt) },
    );
  }
}

type RegisterBody = {
  action?: 'register' | 'finish' | 'kill';
  id?: string;
  session?: string;
  command?: string;
  title?: string | null;
  cwd?: string;
  repo?: string | null;
  packetId?: string | null;
  laneId?: string | null;
  panePid?: number;
  mode?: string;
  startedAt?: string;
  exitCode?: number;
};

/** POST — register a run (default), finish one (action:'finish'), or kill one (action:'kill'). */
export async function POST(req: Request) {
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const principal = resolveRequestPrincipalContext(req);

  if (body.action === 'register' || !body.action) {
    const ownershipRefusal = workerPacketRefusal(principal, body.packetId);
    if (ownershipRefusal) {
      return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
    }
  } else if (principal.role === 'worker') {
    const key = body.session ?? body.id ?? '';
    const target = (await listManagedRuns()).find((run) => run.session === key || run.id === key);
    const ownershipRefusal = workerPacketRefusal(principal, target?.packetId);
    if (ownershipRefusal) {
      return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
    }
  }

  if (body.action === 'finish') {
    const key = body.session ?? body.id;
    if (!key) {
      return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });
    }
    const rec = finishManagedRun(key, typeof body.exitCode === 'number' ? body.exitCode : null);
    return NextResponse.json({ ok: Boolean(rec), run: rec });
  }

  if (body.action === 'kill') {
    const session = body.session;
    // Only ever kill o8-owned managed-run sessions — never an orchestrator,
    // agent-runtime, dashboard, or unrelated tmux session passed by name.
    if (!session || !RUN_SESSION_RE.test(session)) {
      return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 });
    }
    await killTmuxSession(session); // best-effort; no-op if already gone
    const rec = killManagedRun(session);
    return NextResponse.json({ ok: Boolean(rec), run: rec });
  }

  // ── register (default) ──
  if (body.action && body.action !== 'register') {
    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  }
  if (!body.id || !body.session || !body.command || !body.cwd) {
    return NextResponse.json(
      { ok: false, error: 'missing_fields', need: ['id', 'session', 'command', 'cwd'] },
      { status: 400 },
    );
  }
  // Session must be the canonical cortex-run-<id> and match the id, so a caller
  // can't register a record that later legitimizes killing a foreign session.
  if (!RUN_SESSION_RE.test(body.session) || body.session !== `cortex-run-${body.id}`) {
    return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 });
  }
  if (body.command.length > MAX_FIELD || body.cwd.length > MAX_FIELD || (body.title?.length ?? 0) > MAX_FIELD || (body.startedAt?.length ?? 0) > MAX_FIELD) {
    return NextResponse.json({ ok: false, error: 'field_too_long' }, { status: 400 });
  }

  const rec: ManagedRunRecord = {
    id: body.id,
    session: body.session,
    command: body.command,
    title: body.title?.trim() || null,
    cwd: body.cwd,
    repo: body.repo ?? null,
    packetId: body.packetId ?? null,
    laneId: body.laneId ?? null,
    panePid: typeof body.panePid === 'number' ? body.panePid : null,
    mode: body.mode === 'detach' ? 'detach' : 'stream',
    startedAt: typeof body.startedAt === 'string' && body.startedAt.trim()
      ? body.startedAt.trim()
      : new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: 'running',
  };
  registerManagedRun(rec);
  return NextResponse.json({ ok: true, run: rec });
}
