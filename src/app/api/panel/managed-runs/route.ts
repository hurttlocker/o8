import { NextResponse } from 'next/server';
import {
  registerManagedRun,
  finishManagedRun,
  listManagedRuns,
} from '@/lib/runtimes/managed-runs/registry';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET — list managed runs (reconciled against live tmux). */
export async function GET() {
  try {
    const runs = await listManagedRuns();
    return NextResponse.json({ schema: 'o8/managed-runs/v1', runs });
  } catch (err) {
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', runs: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

type RegisterBody = {
  action?: 'register' | 'finish';
  id?: string;
  session?: string;
  command?: string;
  cwd?: string;
  repo?: string | null;
  packetId?: string | null;
  laneId?: string | null;
  panePid?: number;
  mode?: string;
  exitCode?: number;
};

/** POST — register a new run (default) or finish an existing one (action:'finish'). */
export async function POST(req: Request) {
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  if (body.action === 'finish') {
    const key = body.session ?? body.id;
    if (!key) {
      return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });
    }
    const rec = finishManagedRun(key, typeof body.exitCode === 'number' ? body.exitCode : null);
    return NextResponse.json({ ok: Boolean(rec), run: rec });
  }

  if (!body.id || !body.session || !body.command || !body.cwd) {
    return NextResponse.json(
      { ok: false, error: 'missing_fields', need: ['id', 'session', 'command', 'cwd'] },
      { status: 400 },
    );
  }

  const rec: ManagedRunRecord = {
    id: body.id,
    session: body.session,
    command: body.command,
    cwd: body.cwd,
    repo: body.repo ?? null,
    packetId: body.packetId ?? null,
    laneId: body.laneId ?? null,
    panePid: typeof body.panePid === 'number' ? body.panePid : null,
    mode: body.mode === 'detach' ? 'detach' : 'stream',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    status: 'running',
  };
  registerManagedRun(rec);
  return NextResponse.json({ ok: true, run: rec });
}
