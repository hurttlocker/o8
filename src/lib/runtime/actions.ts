import type { AgentSummary } from '@/lib/fleet/types';
import { abortOpenClawSession, steerOpenClawSession } from '@/lib/openclaw/chat';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export type RuntimeActionKind = 'steer' | 'stop' | 'send_input' | 'interrupt';

export interface RuntimeActionRequest {
  action: RuntimeActionKind;
  surfaceId: string;
  message?: string;
  runId?: string;
  attachments?: Array<{
    type?: string;
    mimeType: string;
    fileName: string;
    content: string;
  }>;
}

export interface RuntimeActionResult {
  ok: boolean;
  action: RuntimeActionKind;
  surfaceId: string;
  runtime: string;
  status: 'queued' | 'completed' | 'unavailable';
  note: string;
  runId?: string;
  aborted?: boolean;
}

function findRuntimeAgent(snapshot: Awaited<ReturnType<typeof getRuntimeInventorySnapshot>>, surfaceId: string) {
  return snapshot.agents.find(
    (agent) => agent.sessionKey === surfaceId || agent.runtimeSurface?.id === surfaceId || agent.id === surfaceId,
  );
}

function unavailable(agent: AgentSummary, action: RuntimeActionKind, note: string): RuntimeActionResult {
  return {
    ok: false,
    action,
    surfaceId: agent.runtimeSurface?.id ?? agent.sessionKey,
    runtime: agent.runtime,
    status: 'unavailable',
    note,
  };
}

export async function performRuntimeAction(payload: RuntimeActionRequest): Promise<RuntimeActionResult> {
  const surfaceId = payload.surfaceId?.trim();
  if (!surfaceId) {
    throw new Error('surfaceId is required');
  }

  const snapshot = await getRuntimeInventorySnapshot();
  const agent = findRuntimeAgent(snapshot, surfaceId);
  if (!agent) {
    throw new Error('Runtime surface not found.');
  }

  const runtimeSurface = agent.runtimeSurface;
  if (!runtimeSurface) {
    throw new Error('Runtime surface metadata is unavailable.');
  }

  switch (agent.runtime) {
    case 'openclaw': {
      if (payload.action === 'steer') {
        const message = payload.message?.trim();
        const attachments = Array.isArray(payload.attachments)
          ? payload.attachments.filter((item) => item?.content && item?.mimeType && item?.fileName)
          : [];
        if (!message && attachments.length === 0) {
          throw new Error('message or image attachment is required for steer');
        }
        const result = await steerOpenClawSession(agent.sessionKey, message, attachments);
        return {
          ok: true,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          status: 'queued',
          note: 'Steer request queued on the live session.',
          runId: result.runId,
        };
      }

      if (payload.action === 'stop') {
        const result = await abortOpenClawSession(agent.sessionKey, payload.runId?.trim());
        return {
          ok: true,
          action: payload.action,
          surfaceId: runtimeSurface.id,
          runtime: agent.runtime,
          status: 'completed',
          note: result.aborted
            ? 'Stop request sent to the active run for this session.'
            : 'No active run was in flight for this session.',
          aborted: result.aborted,
        };
      }

      return unavailable(
        agent,
        payload.action,
        `${payload.action} is part of the runtime control contract, but it is not wired truthfully on the OpenClaw-backed lane yet.`,
      );
    }
    case 'codex': {
      if (runtimeSurface.ownership !== 'owned') {
        return unavailable(
          agent,
          payload.action,
          'This Codex surface was discovered from local runtime history, not launched or owned by Cortex IDE. Read-tail is truthful; input and interrupt stay disabled until we can prove an owned-session seam.',
        );
      }

      return unavailable(
        agent,
        payload.action,
        'This Codex surface is marked as IDE-owned, but write/interrupt plumbing is not wired yet. The ownership seam exists; mutation remains intentionally disabled until the transport is real.',
      );
    }
    default:
      return unavailable(agent, payload.action, `Runtime action ${payload.action} is not supported for ${agent.runtime}.`);
  }
}
