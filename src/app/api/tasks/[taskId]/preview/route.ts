import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { requirePanelAuth } from '@/lib/panel/auth';
import { DEFAULT_CLOUD_TEAM_ID } from '@/lib/cloud/team';
import { resolveTaskPreview } from '@/lib/cloud/preview-authority';
import { closePreviewServer, openPreviewServer } from '@/lib/cloud/preview-server';
import { readPreviewMessage } from '@/lib/cloud/preview-message';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function POST(request: NextRequest, context: { params: Promise<{ taskId: string }> }) {
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization is required.' }, { status: 403, headers });
  }
  // This first transport serves the coordinator's native app, not off-host clients.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(request.nextUrl.hostname)) {
    return NextResponse.json({ error: 'Open this preview in the coordinator desktop app.' }, { status: 409, headers });
  }
  try {
    const { taskId } = await context.params;
    const body = await readPreviewMessage(request, 1_024);
    if (!taskId || typeof body.jobId !== 'string' || !Number.isSafeInteger(body.attempt) || Number(body.attempt) < 1) {
      return NextResponse.json({ error: 'Task, job and attempt are required.' }, { status: 400, headers });
    }
    const binding = await resolveTaskPreview(DEFAULT_CLOUD_TEAM_ID, taskId, body.jobId, Number(body.attempt));
    if (!binding) return NextResponse.json({ error: 'No healthy preview belongs to this current attempt. Refresh the task.' }, { status: 409, headers });
    if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
      return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
    }
    const preview = await openPreviewServer(binding, request.nextUrl.origin);
    if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
      preview.close();
      return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
    }
    return NextResponse.json({ schema: 'o8/task.remote-preview/v1', jobId: binding.jobId, attempt: binding.attempt, service: binding.service.name,
      id: preview.id, url: preview.url, expiresAt: preview.expiresAt }, { headers });
  } catch {
    return NextResponse.json({ error: 'Remote preview could not be opened.' }, { status: 503, headers });
  }
}

export async function DELETE(request: NextRequest) {
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization is required.' }, { status: 403, headers });
  }
  const body = await readPreviewMessage(request, 1_024).catch(() => null);
  if (requirePanelAuth(request) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return NextResponse.json({ error: 'Operator authorization changed.' }, { status: 403, headers });
  }
  if (typeof body?.id !== 'string') return NextResponse.json({ error: 'Preview id required.' }, { status: 400, headers });
  closePreviewServer(body.id);
  return NextResponse.json({ ok: true }, { headers });
}
