import {
  enqueueInboxItem,
  type EnqueueInboxItemInput,
} from '@/lib/supervisor/inbox';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const DISPATCH_PREFLIGHT_ERROR_NAMES = new Set([
  'DispatchPreflightError',
  'ExecutionCarrierPreflightError',
]);

export interface DispatchPreflightRefusal {
  count: number;
  maxAttempts: number;
  exhausted: boolean;
  incidentPersisted: boolean;
  blockedReason: string;
}

let writeIncident: (input: EnqueueInboxItemInput) => unknown = enqueueInboxItem;

export function setDispatchPreflightIncidentWriterForTests(
  writer: ((input: EnqueueInboxItemInput) => unknown) | null,
): void {
  writeIncident = writer ?? enqueueInboxItem;
}

export function dispatchPreflightRefusalLimit(packet: OrchestratorPacket): number {
  return Math.max(1, packet.maxAttempts ?? 3);
}

export function dispatchPreflightRefusalBlocker(packet: OrchestratorPacket): string | null {
  const count = packet.preflightRefusals ?? 0;
  const maxAttempts = dispatchPreflightRefusalLimit(packet);
  return count >= maxAttempts
    ? `Dispatch preflight refusals exceeded (${count}/${maxAttempts})`
    : null;
}

export function surfaceDispatchPreflightRefusalIncident(
  packet: OrchestratorPacket,
  reason: string,
): boolean {
  if (!packet.workspaceTargetPath) return false;
  const count = packet.preflightRefusals ?? 0;
  const maxAttempts = dispatchPreflightRefusalLimit(packet);
  const question = `How should o8 proceed with "${packet.title}" after dispatch preflight refused ${count}/${maxAttempts} attempts: ${reason}?`;
  try {
    writeIncident({
      repoPath: packet.workspaceTargetPath,
      packetId: packet.id,
      kind: 'bounded_retry_exhausted',
      status: 'human_required',
      payload: {
        packetTitle: packet.title,
        packetReferenceLabel: packet.referenceLabel,
        runtime: packet.runtime,
        stage: 'dispatch_preflight',
        attempts: `${count}/${maxAttempts}`,
        errorMessage: reason,
        blockedReason: packet.blockedReason ?? reason,
        question,
        note: question,
      },
    });
    return true;
  } catch (incidentError) {
    console.error(
      `[dag-scheduler] Failed to surface exhausted preflight for ${packet.id}:`,
      incidentError,
    );
    return false;
  }
}

export function recordDispatchPreflightRefusal(
  packet: OrchestratorPacket,
  error: unknown,
): DispatchPreflightRefusal | null {
  if (!(error instanceof Error) || !DISPATCH_PREFLIGHT_ERROR_NAMES.has(error.name)) {
    return null;
  }

  const count = (packet.preflightRefusals ?? 0) + 1;
  const maxAttempts = dispatchPreflightRefusalLimit(packet);
  const exhausted = count >= maxAttempts;
  const blockedReason = exhausted
    ? `Dispatch preflight refused ${count}/${maxAttempts} attempts. ${error.message} Manual reset required.`
    : error.message;

  const incidentPersisted = exhausted
    ? surfaceDispatchPreflightRefusalIncident(
        { ...packet, preflightRefusals: count, blockedReason },
        blockedReason,
      )
    : false;

  return { count, maxAttempts, exhausted, incidentPersisted, blockedReason };
}
