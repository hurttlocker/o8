import type { Lane, LaneEvent } from '@/lib/lane/types';

export const CODEX_AUTH_RECOVERY_LANE_LABEL = 'codex_auth_recovery_required';
export const ACCEPTED_LAUNCH_ATTACH_PROVENANCE = 'accepted_launch_session_v1';

export interface CurrentAuthExit {
  exitEvent: LaneEvent;
  attachEvent: LaneEvent;
  runId: string;
  surfaceId: string;
  launchGeneration: number;
}

function packetLaunchIdentity(value: unknown): { packetId: string; generation: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^packet-launch:(.+):(\d+)$/.exec(value.trim());
  if (!match) return null;
  const generation = Number.parseInt(match[2]!, 10);
  return Number.isSafeInteger(generation) && generation > 0
    ? { packetId: match[1]!, generation }
    : null;
}

function isLaunchBoundary(event: LaneEvent): boolean {
  return event.verb === 'status_change' && event.payload.status === 'launching';
}

function isSuccessorBoundary(event: LaneEvent): boolean {
  if (event.verb === 'attach_session' || event.verb === 'steered_packet') return true;
  if (isLaunchBoundary(event)) return true;
  return event.verb === 'status_change' && event.payload.status === 'running';
}

export function acceptedLaunchAttachmentProvenance(input: {
  lane: Lane;
  events: LaneEvent[];
  surfaceId: string;
  clientMutationId: string | undefined;
}): Record<string, unknown> | null {
  const identity = packetLaunchIdentity(input.clientMutationId);
  if (!identity || identity.packetId !== input.lane.packetId) return null;

  const launchIndex = input.events.findLastIndex(isLaunchBoundary);
  const storageIndex = input.events.findLastIndex((event, index) => (
    index > launchIndex
    && typeof event.payload.storageAdmissionOwnerGeneration === 'number'
  ));
  if (launchIndex < 0 || storageIndex < 0) return null;
  const launchEvent = input.events[launchIndex]!;
  const storageEvent = input.events[storageIndex]!;
  if (storageEvent.payload.storageAdmissionOwnerGeneration !== identity.generation) return null;
  if (input.events.slice(launchIndex + 1).some((event) => event.verb === 'attach_session')) return null;

  const exitEvent = input.events.findLast((event, index) => (
    index > launchIndex
    && event.verb === 'runtime_process_exit'
    && event.payload.runtime === 'codex'
    && event.payload.surfaceId === input.surfaceId
    && event.payload.authRecoveryRequired === true
    && event.payload.runtimeOutcome === 'failed'
    && typeof event.payload.runId === 'string'
  ));

  return {
    launchAttachProvenance: ACCEPTED_LAUNCH_ATTACH_PROVENANCE,
    launchEventId: launchEvent.id,
    storageEventId: storageEvent.id,
    surfaceId: input.surfaceId,
    clientMutationId: input.clientMutationId,
    launchGeneration: identity.generation,
    acceptedAuthExitRunId: exitEvent?.payload.runId ?? null,
  };
}

export function findCurrentAuthExit(lane: Lane, events: LaneEvent[]): CurrentAuthExit | null {
  if (lane.runtime !== 'codex' || !lane.packetId || !lane.sessionKey) return null;
  const mayApplyAuthRecovery = lane.status === 'launching'
    || lane.status === 'running'
    || lane.status === 'recovering'
    || (lane.status === 'awaiting_input' && lane.lastEventLabel === CODEX_AUTH_RECOVERY_LANE_LABEL);
  if (!mayApplyAuthRecovery) return null;

  const attachIndex = events.findLastIndex((event) => (
    event.verb === 'attach_session'
    && event.payload.launchAttachProvenance === ACCEPTED_LAUNCH_ATTACH_PROVENANCE
  ));
  if (attachIndex < 1) return null;
  const attachEvent = events[attachIndex]!;
  if (attachEvent.payload.sessionKey !== lane.sessionKey
    || attachEvent.payload.surfaceId !== lane.sessionKey) return null;

  const identity = packetLaunchIdentity(attachEvent.payload.clientMutationId);
  if (!identity || identity.packetId !== lane.packetId) return null;
  if (attachEvent.payload.launchGeneration !== identity.generation) return null;

  const launchIndex = events.findLastIndex((event, index) => (
    index < attachIndex && isLaunchBoundary(event)
  ));
  const storageIndex = events.findLastIndex((event, index) => (
    index > launchIndex
    && index < attachIndex
    && typeof event.payload.storageAdmissionOwnerGeneration === 'number'
  ));
  const launchEvent = launchIndex >= 0 ? events[launchIndex]! : null;
  const storageEvent = storageIndex >= 0 ? events[storageIndex]! : null;
  if (!launchEvent || attachEvent.payload.launchEventId !== launchEvent.id) return null;
  if (!storageEvent || attachEvent.payload.storageEventId !== storageEvent.id) return null;
  if (storageEvent.payload.storageAdmissionOwnerGeneration !== identity.generation) return null;
  if (events.slice(launchIndex + 1, attachIndex).some((event) => event.verb === 'attach_session')) return null;

  const exitEvent = events.findLast((event) => (
    event.verb === 'runtime_process_exit'
    && event.payload.runtime === 'codex'
    && event.payload.surfaceId === lane.sessionKey
    && event.payload.authRecoveryRequired === true
    && event.payload.runtimeOutcome === 'failed'
    && typeof event.payload.runId === 'string'
  ));
  if (!exitEvent) return null;
  const exitIndex = events.indexOf(exitEvent);
  if (exitIndex <= launchIndex) return null;
  const exitRunId = exitEvent.payload.runId as string;
  if (exitIndex < attachIndex
    && attachEvent.payload.acceptedAuthExitRunId !== exitRunId) return null;
  if (exitIndex > attachIndex && attachEvent.payload.acceptedAuthExitRunId !== null) return null;

  const eventsAfterAttach = events.slice(attachIndex + 1);
  const acceptedLaunchStatuses = eventsAfterAttach.filter((event) => (
    event.verb === 'status_change'
    && event.payload.status === 'running'
    && event.payload.eventLabel === 'session_launched'
  ));
  if (acceptedLaunchStatuses.length > 1) return null;
  if (eventsAfterAttach.some((event) => (
    isSuccessorBoundary(event) && !acceptedLaunchStatuses.includes(event)
  ))) return null;
  const betweenAttachAndExit = exitIndex > attachIndex
    ? events.slice(attachIndex + 1, exitIndex)
    : [];
  if (betweenAttachAndExit.some((event) => event.verb === 'runtime_process_exit')) return null;

  const laterEvents = events.slice(Math.max(exitIndex, attachIndex) + 1);
  if (laterEvents.some((event) => (
    isSuccessorBoundary(event) && !acceptedLaunchStatuses.includes(event)
  ))) return null;
  if (laterEvents.some((event) => (
    event.verb === 'runtime_process_exit' && event.payload.runId !== exitRunId
  ))) return null;

  return {
    exitEvent,
    attachEvent,
    runId: exitRunId,
    surfaceId: lane.sessionKey,
    launchGeneration: identity.generation,
  };
}
