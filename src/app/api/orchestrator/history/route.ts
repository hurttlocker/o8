import { NextRequest } from 'next/server';

import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { requirePanelAuth } from '@/lib/panel/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function noStore(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

function limitFrom(request: NextRequest): number {
  const value = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '200', 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(value, 1_000)) : 200;
}

export async function GET(request: NextRequest): Promise<Response> {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const threadId = request.nextUrl.searchParams.get('threadId')?.trim() ?? '';
  if (!threadId.startsWith('thoughts-')) {
    return noStore({
      schema: 'o8/orchestrator.history.error/v1',
      ok: false,
      error: { code: 'invalid_thread_id', message: 'threadId must identify an orchestrator thread.' },
    }, 400);
  }
  const persisted = readPersistedLlmChat(threadId);
  if (!persisted) {
    return noStore({
      schema: 'o8/orchestrator.history.error/v1',
      ok: false,
      error: { code: 'thread_not_found', message: 'The orchestrator thread was not found.' },
    }, 404);
  }

  const audits = listLanes().flatMap((lane) => (
    getLaneEvents(lane.id, 5_000)
      .filter((event) => event.verb === 'handoff' && event.payload.threadId === threadId)
      .map((event) => ({
        id: event.id,
        handoffId: typeof event.payload.handoffId === 'string' ? event.payload.handoffId : null,
        laneId: lane.id,
        packetId: lane.packetId,
        actor: event.actor,
        timestamp: event.timestamp,
      }))
  ));
  const auditsByHandoff = new Map<string, typeof audits>();
  for (const audit of audits) {
    if (!audit.handoffId) continue;
    const current = auditsByHandoff.get(audit.handoffId) ?? [];
    current.push(audit);
    auditsByHandoff.set(audit.handoffId, current);
  }

  const fullTimeline = persisted.history.messages.map((message, index) => ({
    kind: message.type === 'handoff' && message.handoff ? 'handoff' as const : 'message' as const,
    id: message.id || `${threadId}-history-${index}`,
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : index,
    role: message.role ?? 'system',
    content: message.content ?? '',
    backend: message.backend ?? null,
    model: message.model ?? null,
    handoff: message.handoff ?? null,
    audits: message.handoff ? auditsByHandoff.get(message.handoff.handoffId) ?? [] : [],
  }));
  const representedAudits = new Set(fullTimeline.flatMap((entry) => entry.audits.map((audit) => audit.id)));
  for (const audit of audits) {
    if (representedAudits.has(audit.id)) continue;
    const auditTimestamp = Date.parse(audit.timestamp);
    fullTimeline.push({
      kind: 'handoff',
      id: audit.handoffId ?? audit.id,
      timestamp: Number.isFinite(auditTimestamp) ? auditTimestamp : 0,
      role: 'system',
      content: 'A governed handoff was recorded.',
      backend: null,
      model: null,
      handoff: null,
      audits: [audit],
    });
  }
  fullTimeline.sort((a, b) => a.timestamp - b.timestamp);
  const limit = limitFrom(request);
  const timeline = fullTimeline.slice(-limit);

  return noStore({
    schema: 'o8/orchestrator.history/v1',
    ok: true,
    thread: {
      id: threadId,
      title: persisted.history.title ?? null,
      repoPath: persisted.history.repoPath ?? null,
      modifiedAt: persisted.modifiedAt,
    },
    count: fullTimeline.length,
    truncated: timeline.length < fullTimeline.length,
    timeline,
  });
}
