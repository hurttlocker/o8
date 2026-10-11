import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { TaskDraftError } from '@/lib/mcp/task-draft-contract';
import { controlTaskExecution } from '@/lib/mcp/task-execution-control';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** This local operator decision is deliberately absent from the hosted MCP catalogue. */
export async function POST(request: Request): Promise<Response> {
  const role = resolveRequestPrincipal(request);
  if (role !== 'operator') return NextResponse.json({ error: 'operator_required' }, { status: role === 'anonymous' ? 401 : 403 });
  try {
    if (Number(request.headers.get('content-length')) > 4096) throw new TaskDraftError('invalid_arguments');
    const text = await request.text();
    if (text.length > 4096) throw new TaskDraftError('invalid_arguments');
    let args: unknown;
    try { args = JSON.parse(text); } catch { throw new TaskDraftError('invalid_arguments'); }
    return NextResponse.json({ ok: true, execution: await controlTaskExecution(args) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TaskDraftError ? error.code : 'execution_uncertain' },
      { status: error instanceof TaskDraftError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
