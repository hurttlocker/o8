import { resolveApproval } from '@/lib/approvals/resolution';
import { createApproval, getApproval } from '@/lib/approvals/store';
import { appendEvent, findLaneBySession } from '@/lib/lane/registry';
import { compactText } from '@/lib/runtimes/shared/owned-session';

export type PiRpcFrame = Record<string, unknown>;

export interface PiPermissionSession {
  surfaceId: string;
  title: string;
  repoPath: string;
  branch?: string;
}

export interface PiPermissionClient {
  send(command: Record<string, unknown>): boolean;
}

export const PI_PERMISSION_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const PI_PERMISSION_APPROVAL_POLL_MS = 250;

function safeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(source: Record<string, unknown> | null, ...keys: string[]) {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function buildPiPermissionDefaultResponse(frame: PiRpcFrame): PiRpcFrame | null {
  if (frame.type !== 'extension_ui_request') return null;
  const requestId = readString(frame, 'id', 'requestId', 'request_id');
  const kind = readString(frame, 'kind', 'ui', 'requestType') ?? 'confirm';
  const response: PiRpcFrame = {
    type: 'extension_ui_response',
    success: true,
  };
  if (requestId) {
    response.requestId = requestId;
    response.id = requestId;
  }
  if (kind === 'confirm') {
    response.value = false;
    response.confirmed = false;
  } else {
    response.cancelled = true;
    response.value = null;
  }
  return response;
}

function buildPiPermissionApprovedResponse(frame: PiRpcFrame): PiRpcFrame | null {
  if (frame.type !== 'extension_ui_request') return null;
  const requestId = readString(frame, 'id', 'requestId', 'request_id');
  const response: PiRpcFrame = {
    type: 'extension_ui_response',
    success: true,
    value: true,
    confirmed: true,
  };
  if (requestId) {
    response.requestId = requestId;
    response.id = requestId;
  }
  return response;
}

export function buildPiPermissionDeniedResponse(frame: PiRpcFrame, note?: string): PiRpcFrame | null {
  const response = buildPiPermissionDefaultResponse(frame);
  if (response && note?.trim()) {
    response.message = note.trim();
    response.reason = note.trim();
  }
  return response;
}

function piRequestKind(frame: PiRpcFrame) {
  return readString(frame, 'kind', 'ui', 'requestType') ?? 'confirm';
}

function piRequestId(frame: PiRpcFrame) {
  return readString(frame, 'id', 'requestId', 'request_id') ?? `pi-request-${Date.now()}`;
}

function piPermissionTitle(frame: PiRpcFrame) {
  return compactText(
    readString(frame, 'summary', 'title', 'message', 'prompt')
      ?? readString(safeRecord(frame.toolCall), 'summary', 'name', 'toolName')
      ?? readString(frame, 'toolName', 'tool_name')
      ?? 'Pi permission request',
    120,
  );
}

function recordPiPermissionLaneEvent(
  sessionKey: string,
  family: 'approval_requested' | 'approval_resolved',
  payload: Record<string, unknown>,
) {
  try {
    const lane = findLaneBySession(sessionKey);
    if (!lane) return;
    appendEvent(lane.id, 'update', 'system', {
      family,
      runtime: 'pi',
      sessionKey,
      packetId: lane.packetId,
      ...payload,
    });
  } catch (error) {
    console.warn('[pi-owned] Failed to record permission lane event:', error instanceof Error ? error.message : error);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handlePiPermissionRequest(
  frame: PiRpcFrame,
  session: PiPermissionSession,
  client: PiPermissionClient,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<'bridged' | 'defaulted'> {
  if (frame.type !== 'extension_ui_request') return 'defaulted';
  const kind = piRequestKind(frame);
  if (kind !== 'confirm') {
    // v1 only bridges confirm. select/input stay deny-by-default as safe cancel.
    const response = buildPiPermissionDefaultResponse(frame);
    if (response) client.send(response);
    return 'defaulted';
  }

  const requestId = piRequestId(frame);
  let approvalId: string | null = null;
  try {
    const lane = findLaneBySession(session.surfaceId);
    const title = piPermissionTitle(frame);
    const approval = createApproval({
      source: 'runtime',
      runtime: 'pi',
      agent: session.title,
      sessionKey: session.surfaceId,
      title,
      description: `Pi is requesting permission to continue: ${title}`,
      summary: title,
      toolName: readString(frame, 'toolName', 'tool_name') ?? readString(safeRecord(frame.toolCall), 'name', 'toolName') ?? 'pi_permission_confirm',
      args: {
        requestId,
        kind,
        frame,
      },
      editable: false,
      risk: 'medium',
      metadata: {
        Runtime: 'pi',
        Session: session.surfaceId,
        Request: requestId,
        RepoPath: session.repoPath,
        ...(session.branch ? { Branch: session.branch } : {}),
        ...(lane ? { Lane: lane.id } : {}),
        ...(lane?.packetId ? { Packet: lane.packetId } : {}),
      },
    });
    approvalId = approval.id;
    recordPiPermissionLaneEvent(session.surfaceId, 'approval_requested', {
      approvalId,
      requestId,
      title,
    });
  } catch (error) {
    console.warn('[pi-owned] Permission approval bridge failed open-to-deny:', error instanceof Error ? error.message : error);
    const response = buildPiPermissionDeniedResponse(frame, 'Approval bridge failed; denied by default.');
    if (response) client.send(response);
    return 'defaulted';
  }

  const timeoutMs = options.timeoutMs ?? PI_PERMISSION_APPROVAL_TIMEOUT_MS;
  const pollMs = options.pollMs ?? PI_PERMISSION_APPROVAL_POLL_MS;
  const expiresAt = Date.now() + timeoutMs;

  while (Date.now() < expiresAt) {
    const approval = getApproval(approvalId);
    if (!approval || approval.status !== 'pending') {
      const approved = approval?.status === 'approved';
      const note = approval?.resolution?.note;
      const response = approved
        ? buildPiPermissionApprovedResponse(frame)
        : buildPiPermissionDeniedResponse(frame, note);
      if (response) client.send(response);
      recordPiPermissionLaneEvent(session.surfaceId, 'approval_resolved', {
        approvalId,
        requestId,
        status: approval?.status ?? 'missing',
        actor: approval?.resolution?.actor,
      });
      return 'bridged';
    }
    await wait(Math.max(10, pollMs));
  }

  const expired = resolveApproval(approvalId, 'reject', 'system', 'Expired: Pi permission request timed out');
  const response = buildPiPermissionDeniedResponse(frame, expired?.resolution?.note ?? 'Expired: Pi permission request timed out');
  if (response) client.send(response);
  recordPiPermissionLaneEvent(session.surfaceId, 'approval_resolved', {
    approvalId,
    requestId,
    status: expired?.status ?? 'rejected',
    actor: expired?.resolution?.actor ?? 'system',
    expired: true,
  });
  return 'bridged';
}
