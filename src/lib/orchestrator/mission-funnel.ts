import 'server-only';

import { basename } from 'node:path';

import { getSqlite } from '@/lib/db';
import { getLaneEvents, listLanes } from '@/lib/lane/registry';
import type { Lane, LaneEvent, LaneStatus } from '@/lib/lane/types';
import { getMissionRecord } from '@/lib/db/missions-store';
import { readMissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import { readSessionTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import { resolveRuntimeSessionIdentityId } from '@/lib/runtime/session-identity';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import { isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import {
  MISSION_FUNNEL_SCHEMA_VERSION,
  type MissionFunnelAction,
  type MissionFunnelAttempt,
  type MissionFunnelDurations,
  type MissionFunnelPacketReceipt,
  type MissionFunnelPercentiles,
  type MissionFunnelPhases,
  type MissionFunnelReceipt,
} from '@/lib/orchestrator/mission-funnel-types';

export * from '@/lib/orchestrator/mission-funnel-types';

interface ApprovalEvidence {
  id: string;
  laneId: string | null;
  sessionKey: string;
  status: string;
  createdAt: number;
  resolvedAt: number | null;
  continuationJson: string | null;
  argsJson: string | null;
}

interface LaneEvidence {
  lane: Lane;
  events: LaneEvent[];
  transcript: TranscriptEvent[];
  transcriptUnavailable: boolean;
  identityId: string | null;
  sessionBindings: Array<{
    sessionKey: string;
    start: string;
    runtime: string;
    identityId: string | null;
  }>;
}

const OUTPUT_EVENT_TYPES = new Set<TranscriptEvent['type']>([
  'assistant',
  'tool_call',
  'tool_result',
  'error',
  'done',
]);

const IDLE_STATUSES = new Set<LaneStatus>(['idle', 'paused']);
const OPERATOR_WAIT_STATUSES = new Set<LaneStatus>([
  'awaiting_input',
  'awaiting_orchestrator',
  'awaiting_human',
]);
const RECOVERY_STATUSES = new Set<LaneStatus>(['recovering']);
const TERMINAL_LANE_STATUSES = new Set<LaneStatus>(['completed', 'failed', 'archived']);
const RECOVERY_EVENT_VERBS = new Set([
  'session_lost',
  'zombie_reap',
  'runtime_drift',
  'worker_quota_exhausted',
  'worker_fallback',
  'worker_fallback_terminal',
  'review_fallback',
  'typecheck_auto_retry',
  'wedge_timeout',
]);

function validIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isoFromMs(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : null;
}

function earliest(...values: Array<string | null | undefined>): string | null {
  return values.flatMap((value) => validIso(value) ?? []).sort()[0] ?? null;
}

function latest(...values: Array<string | null | undefined>): string | null {
  return values.flatMap((value) => validIso(value) ?? []).sort().at(-1) ?? null;
}

function duration(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function timestampOfEvent(events: LaneEvent[], predicate: (event: LaneEvent) => boolean, useLatest = false) {
  const matches = events.filter(predicate).map((event) => event.timestamp);
  return useLatest ? latest(...matches) : earliest(...matches);
}

function statusTimestamp(events: LaneEvent[], status: LaneStatus, useLatest = false) {
  return timestampOfEvent(
    events,
    (event) => event.verb === 'status_change' && event.payload.status === status,
    useLatest,
  );
}

function transcriptBounds(events: TranscriptEvent[]) {
  const output = events.filter((event) => OUTPUT_EVENT_TYPES.has(event.type));
  return {
    firstOutputAt: earliest(...output.map((event) => event.ts)),
    lastOutputAt: latest(...output.map((event) => event.ts)),
  };
}

function closedStatusDuration(
  lane: Lane,
  events: LaneEvent[],
  statuses: Set<LaneStatus>,
  startAt?: string | null,
  endAt?: string | null,
) {
  const transitions = events
    .filter((event) => event.verb === 'status_change' && typeof event.payload.status === 'string')
    .map((event) => ({ at: validIso(event.timestamp), status: event.payload.status as LaneStatus }))
    .filter((event): event is { at: string; status: LaneStatus } => Boolean(event.at))
    .sort((left, right) => left.at.localeCompare(right.at));
  const allBoundaries = [{ at: validIso(lane.createdAt), status: 'idle' as LaneStatus }, ...transitions]
    .filter((event): event is { at: string; status: LaneStatus } => Boolean(event.at));
  const start = validIso(startAt) ?? allBoundaries[0]?.at ?? null;
  if (!start) return 0;
  const activeAtStart = [...allBoundaries].reverse().find((event) => event.at <= start)?.status ?? 'idle';
  const boundaries = [
    { at: start, status: activeAtStart },
    ...allBoundaries.filter((event) => event.at > start && (!endAt || event.at < endAt)),
    ...(endAt ? [{ at: endAt, status: activeAtStart }] : []),
  ];
  let total = 0;
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const current = boundaries[index];
    const next = boundaries[index + 1];
    if (!current || !next || !statuses.has(current.status)) continue;
    total += duration(current.at, next.at) ?? 0;
  }
  return total;
}

function launchKind(events: LaneEvent[]): MissionFunnelAttempt['launchKind'] {
  const launched = statusTimestamp(events, 'launching');
  const attached = timestampOfEvent(events, (event) => event.verb === 'attach_session');
  if (launched && attached) return 'cold';
  if (timestampOfEvent(events, (event) => event.verb === 'send_turn' || event.verb === 'resume')) return 'warm';
  if (attached) return 'adopted';
  return 'unknown';
}

function lanePacketId(evidence: LaneEvidence, packetIds: Set<string>) {
  if (evidence.lane.packetId && packetIds.has(evidence.lane.packetId)) return evidence.lane.packetId;
  const opened = evidence.events.find((event) => event.verb === 'open_lane');
  const packetId = typeof opened?.payload.packetId === 'string' ? opened.payload.packetId : '';
  return packetIds.has(packetId) ? packetId : null;
}

function attemptFromLane(
  evidence: LaneEvidence,
  attempt: number,
  bindingIndex: number,
): MissionFunnelAttempt {
  const { lane, events, transcript } = evidence;
  const binding = evidence.sessionBindings[bindingIndex];
  const nextBinding = evidence.sessionBindings[bindingIndex + 1];
  const bindingStart = binding?.start ?? validIso(lane.createdAt);
  const bindingEnd = nextBinding?.start ?? null;
  const bindingEvents = events.filter((event) => (
    (!bindingStart || event.timestamp >= bindingStart)
    && (!bindingEnd || event.timestamp < bindingEnd)
  ));
  const launchBeforeBinding = bindingStart
    ? latest(...events.filter((event) => (
        event.verb === 'status_change'
        && event.payload.status === 'launching'
        && event.timestamp <= bindingStart
        && (bindingIndex === 0 || event.timestamp >= (evidence.sessionBindings[bindingIndex - 1]?.start ?? ''))
      )).map((event) => event.timestamp))
    : null;
  const boundedTranscript = binding
    ? transcript.filter((event) => event.ts >= binding.start && (!nextBinding || event.ts < nextBinding.start))
    : transcript;
  const outputs = transcriptBounds(boundedTranscript);
  const launchStartedAt = launchBeforeBinding ?? statusTimestamp(bindingEvents, 'launching');
  const claimedAt = bindingIndex === 0
    ? timestampOfEvent(events, (event) => event.verb === 'open_lane') ?? validIso(lane.createdAt)
    : launchStartedAt ?? binding?.start ?? null;
  const workerReadyAt = binding?.start
    ?? timestampOfEvent(events, (event) => event.verb === 'attach_session');
  const isFinalBinding = bindingIndex === Math.max(1, evidence.sessionBindings.length) - 1;
  const reviewReadyAt = isFinalBinding ? statusTimestamp(events, 'reviewing') : null;
  const mergedAt = isFinalBinding ? timestampOfEvent(events, (event) => event.verb === 'merge', true) : null;
  const terminalAt = isFinalBinding ? timestampOfEvent(
    events,
    (event) => event.verb === 'status_change' && TERMINAL_LANE_STATUSES.has(event.payload.status as LaneStatus),
    true,
  ) : null;
  const terminalStatusEvent = [...events].reverse().find(
    (event) => event.verb === 'status_change' && TERMINAL_LANE_STATUSES.has(event.payload.status as LaneStatus),
  );
  return {
    attempt,
    laneId: lane.id,
    runtime: binding?.runtime ?? lane.runtime,
    sessionKey: binding?.sessionKey ?? lane.sessionKey,
    identityId: binding?.identityId ?? evidence.identityId,
    launchKind: launchStartedAt ? 'cold' : launchKind(bindingEvents),
    phases: {
      claimedAt,
      launchStartedAt,
      workerReadyAt,
      firstOutputAt: outputs.firstOutputAt,
      lastOutputAt: outputs.lastOutputAt,
      reviewReadyAt,
      mergedAt,
      terminalAt,
    },
    durations: {
      claimToLaunchMs: duration(claimedAt, launchStartedAt),
      startupMs: duration(launchStartedAt, workerReadyAt),
      firstOutputMs: duration(workerReadyAt, outputs.firstOutputAt),
      executionMs: duration(outputs.firstOutputAt ?? workerReadyAt, reviewReadyAt),
      idleMs: closedStatusDuration(lane, events, IDLE_STATUSES, bindingStart, bindingEnd),
      operatorWaitMs: closedStatusDuration(lane, events, OPERATOR_WAIT_STATUSES, bindingStart, bindingEnd),
      recoveryMs: closedStatusDuration(lane, events, RECOVERY_STATUSES, bindingStart, bindingEnd),
    },
    terminalStatus: isFinalBinding
      ? terminalStatusEvent?.payload.status as LaneStatus | undefined ?? null
      : null,
  };
}

function isFinalApproval(approval: ApprovalEvidence) {
  try {
    const args = JSON.parse(approval.argsJson ?? 'null') as {
      reviewSuperseded?: unknown;
      reviewTurnOutcome?: unknown;
    } | null;
    if (args?.reviewSuperseded === true || args?.reviewTurnOutcome === 'discarded') return false;
    const continuation = JSON.parse(approval.continuationJson ?? 'null') as {
      kind?: unknown;
      verb?: unknown;
    } | null;
    return continuation?.kind === 'lane'
      && (continuation.verb === 'merge' || continuation.verb === 'create_pr');
  } catch {
    return false;
  }
}

function packetDisposition(packet: OrchestratorPacket, attempts: MissionFunnelAttempt[]) {
  const lanes = attempts.map((attempt) => attempt.terminalStatus);
  const latestLane = attempts.at(-1);
  if (attempts.some((attempt) => attempt.phases.mergedAt) || packet.releaseStatePayload?.mergeCommit) return 'merged';
  if (packet.releaseState === 'released' || packet.status === 'released') return 'closed';
  if (packet.operatorStopped) return 'cancelled';
  if (packet.status === 'failed' || latestLane?.terminalStatus === 'failed') return 'failed';
  if (packet.archivedAt || packet.status === 'archived') {
    return lanes.includes('completed') ? 'closed' : 'partial';
  }
  if (packet.status === 'queued' || packet.status === 'launching' || packet.status === 'running'
    || packet.status === 'awaiting_review' || packet.status === 'recovering') return 'in_progress';
  return 'unknown';
}

function packetInterventions(
  attempts: LaneEvidence[],
  approvals: ApprovalEvidence[],
) {
  const actions: MissionFunnelAction[] = [];
  for (const { lane, events } of attempts) {
    for (const event of events) {
      if (event.verb === 'steered_packet') {
        const requestedSource = typeof event.payload.source === 'string' ? event.payload.source : '';
        if (requestedSource !== 'heal-bot') {
          actions.push({ kind: 'steer', at: event.timestamp, laneId: lane.id, source: 'unattributed' });
        }
      }
      if (event.verb === 'update' && event.actor === 'user' && event.payload.source === 'manual_code_change') {
        actions.push({ kind: 'manual_code_change', at: event.timestamp, laneId: lane.id, source: 'user' });
      }
    }
    const archivedAt = timestampOfEvent(
      events,
      (event) => event.verb === 'status_change' && event.payload.status === 'archived',
      true,
    );
    if (archivedAt && lane.outcomeNote === 'Superseded by rerun') {
      actions.push({ kind: 'rerun_with_feedback', at: archivedAt, laneId: lane.id, source: 'unattributed' });
    }
    if (archivedAt && lane.outcomeNote === 'Superseded by reset') {
      actions.push({ kind: 'reset', at: archivedAt, laneId: lane.id, source: 'unattributed' });
    }
    const stoppedAt = timestampOfEvent(
      events,
      (event) => event.verb === 'status_change' && event.payload.status === 'paused' && event.actor === 'user',
      true,
    );
    if (stoppedAt && lane.lastEventLabel === 'operator_stopped') {
      actions.push({ kind: 'stop', at: stoppedAt, laneId: lane.id, source: 'user' });
    }
    const superseded = lane.outcomeNote === 'Superseded by rerun' || lane.outcomeNote === 'Superseded by reset';
    if (archivedAt && !superseded) {
      const archivedEvent = [...events].reverse().find((event) => (
        event.verb === 'status_change' && event.payload.status === 'archived'
      ));
      if (archivedEvent?.actor === 'user') {
        actions.push({ kind: 'archive', at: archivedAt, laneId: lane.id, source: 'user' });
      }
    }
  }
  for (const approval of approvals) {
    if (approval.status !== 'rejected') continue;
    const at = isoFromMs(approval.resolvedAt ?? approval.createdAt);
    if (at) actions.push({ kind: 'rejection', at, laneId: approval.laneId, source: 'approval' });
  }
  const approvedAt = approvals
    .filter((approval) => isFinalApproval(approval) && approval.status === 'approved')
    .flatMap((approval) => isoFromMs(approval.resolvedAt) ?? []);
  for (const { lane, events } of attempts) {
    for (const event of events.filter((candidate) => candidate.verb === 'merge' && candidate.actor === 'user')) {
      if (!approvedAt.some((timestamp) => timestamp <= event.timestamp)) {
        actions.push({ kind: 'manual_merge_rescue', at: event.timestamp, laneId: lane.id, source: 'user' });
      }
    }
  }
  return actions
    .filter((action) => Boolean(validIso(action.at)))
    .sort((left, right) => left.at.localeCompare(right.at));
}

function packetRecoveryEvents(attempts: LaneEvidence[]) {
  return attempts.flatMap(({ lane, events }) => {
    const explicit = events.flatMap((event) => (
      RECOVERY_EVENT_VERBS.has(event.verb)
        ? [{ kind: event.verb, at: event.timestamp, laneId: lane.id }]
        : []
    ));
    if (explicit.length > 0) return explicit;
    return events.flatMap((event) => (
      event.verb === 'status_change' && event.payload.status === 'recovering'
        ? [{ kind: 'recovering', at: event.timestamp, laneId: lane.id }]
        : []
    ));
  }).sort((left, right) => left.at.localeCompare(right.at));
}

function phaseDurations(
  phases: MissionFunnelPhases,
  attempts: MissionFunnelAttempt[],
): MissionFunnelDurations {
  const reviewEnd = phases.approvalRequestedAt ?? phases.mergedAt ?? phases.terminalAt;
  const mergeStart = phases.approvedAt ?? phases.reviewReadyAt;
  return {
    queueMs: duration(phases.enqueuedAt, phases.claimedAt),
    claimToLaunchMs: duration(phases.claimedAt, phases.launchStartedAt),
    startupMs: duration(phases.launchStartedAt, phases.workerReadyAt),
    firstOutputMs: duration(phases.workerReadyAt, phases.firstOutputAt),
    executionMs: duration(phases.firstOutputAt ?? phases.workerReadyAt, phases.reviewReadyAt),
    reviewMs: duration(phases.reviewReadyAt, reviewEnd),
    approvalMs: duration(phases.approvalRequestedAt, phases.approvedAt),
    mergeMs: duration(mergeStart, phases.mergedAt),
    totalMs: duration(phases.createdAt, phases.terminalAt),
    idleMs: attempts.reduce((sum, attempt) => sum + attempt.durations.idleMs, 0),
    operatorWaitMs: attempts.reduce((sum, attempt) => sum + attempt.durations.operatorWaitMs, 0),
    recoveryMs: attempts.reduce((sum, attempt) => sum + attempt.durations.recoveryMs, 0),
  };
}

function percentile(values: number[]): MissionFunnelPercentiles {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const pick = (ratio: number) => sorted.length > 0
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? null
    : null;
  return {
    samples: sorted.length,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: sorted.at(-1) ?? null,
  };
}

function packetReceipt(input: {
  packet: OrchestratorPacket;
  lanes: LaneEvidence[];
  approvals: ApprovalEvidence[];
}): MissionFunnelPacketReceipt {
  const orderedLanes = [...input.lanes].sort((left, right) => left.lane.createdAt.localeCompare(right.lane.createdAt));
  let attemptNumber = 0;
  const attempts = orderedLanes.flatMap((lane) => {
    const bindingCount = Math.max(1, lane.sessionBindings.length);
    return Array.from({ length: bindingCount }, (_, bindingIndex) => {
      attemptNumber += 1;
      return attemptFromLane(lane, attemptNumber, bindingIndex);
    });
  });
  const finalApprovals = input.approvals.filter(isFinalApproval);
  const approvalRequestedAt = earliest(...finalApprovals.map((approval) => isoFromMs(approval.createdAt)));
  const approvedAt = earliest(...finalApprovals
    .filter((approval) => approval.status === 'approved')
    .map((approval) => isoFromMs(approval.resolvedAt)));
  const mergedAt = latest(...attempts.map((attempt) => attempt.phases.mergedAt));
  const disposition = packetDisposition(input.packet, attempts);
  const cancelledAt = disposition === 'cancelled'
    ? latest(
        ...input.lanes.flatMap(({ lane, events }) => timestampOfEvent(
          events,
          (event) => (
            event.verb === 'status_change'
            && event.payload.status === 'paused'
            && (event.actor === 'user' || lane.lastEventLabel === 'operator_stopped')
          ),
          true,
        ) ?? []),
        input.packet.lastEventLabel === 'operator_stopped' ? validIso(input.packet.lastEventAt) : null,
      )
    : null;
  const terminalAt = disposition === 'in_progress' || disposition === 'unknown'
    ? null
    : validIso(input.packet.archivedAt)
      ?? latest(...attempts.map((attempt) => attempt.phases.terminalAt), mergedAt, cancelledAt);
  const reviewCandidates = attempts.flatMap((attempt) => attempt.phases.reviewReadyAt ?? []);
  const reviewBoundary = approvalRequestedAt ?? mergedAt ?? terminalAt;
  const reviewReadyAt = reviewCandidates.filter((timestamp) => !reviewBoundary || timestamp <= reviewBoundary).at(-1)
    ?? reviewCandidates.at(-1)
    ?? null;
  const phases: MissionFunnelPhases = {
    createdAt: null,
    enqueuedAt: null,
    claimedAt: earliest(...attempts.map((attempt) => attempt.phases.claimedAt)),
    launchStartedAt: earliest(...attempts.map((attempt) => attempt.phases.launchStartedAt)),
    workerReadyAt: earliest(...attempts.map((attempt) => attempt.phases.workerReadyAt)),
    firstOutputAt: earliest(...attempts.map((attempt) => attempt.phases.firstOutputAt)),
    lastOutputAt: latest(...attempts.map((attempt) => attempt.phases.lastOutputAt)),
    reviewReadyAt,
    approvalRequestedAt,
    approvedAt,
    mergedAt,
    terminalAt,
  };
  const interventions = packetInterventions(orderedLanes, input.approvals);
  const recoveryEvents = packetRecoveryEvents(orderedLanes);
  const successful = disposition === 'merged' || disposition === 'closed';
  const retryCount = Math.max(0, attempts.length - 1);
  const controlDisqualifier = interventions.length > 0 || recoveryEvents.length > 0 || retryCount > 0;
  const strictAutonomousClose = !successful || Boolean(approvalRequestedAt) || controlDisqualifier
    ? false
    : null;
  const governedAutonomousClose = !successful
    || !approvalRequestedAt
    || !approvedAt
    || controlDisqualifier
    ? false
    : null;
  const missingSignals = [
    'packet_created_at',
    'packet_enqueued_at',
    ...(orderedLanes.some((lane) => lane.transcriptUnavailable) ? ['transcript_timestamps'] : []),
    ...((strictAutonomousClose === null || governedAutonomousClose === null)
      ? ['manual_code_change_not_observable']
      : []),
    ...(interventions.some((action) => action.source === 'unattributed')
      ? ['intervention_principal']
      : []),
  ];
  const attemptIdentityIds = new Set(
    attempts.map((attempt) => attempt.identityId).filter((identityId): identityId is string => Boolean(identityId)),
  );
  return {
    packetId: input.packet.id,
    title: input.packet.title,
    repoLabel: input.packet.workspaceTargetPath ? basename(input.packet.workspaceTargetPath) : null,
    repoPath: null,
    runtime: input.packet.runtime,
    model: input.packet.workerRouting?.selectedModel ?? input.packet.assignedModel ?? null,
    identityId: attemptIdentityIds.size === 1 ? [...attemptIdentityIds][0] ?? null : null,
    phases,
    durations: phaseDurations(phases, attempts),
    attempts,
    attemptCount: attempts.length,
    retryCount,
    interventions,
    recoveryEvents,
    terminalDisposition: disposition,
    strictAutonomousClose,
    governedAutonomousClose,
    missingSignals,
  };
}

function laneSessionBindings(lane: Lane, events: LaneEvent[]) {
  const attached = events
    .filter((event) => (
      (event.verb === 'open_lane' || event.verb === 'attach_session')
      && typeof event.payload.sessionKey === 'string'
    ))
    .map((event) => ({
      sessionKey: String(event.payload.sessionKey).trim(),
      start: event.timestamp,
    }))
    .filter((binding) => binding.sessionKey && validIso(binding.start));
  if (attached.length === 0 && lane.sessionKey?.trim()) {
    attached.push({
      sessionKey: lane.sessionKey.trim(),
      start: timestampOfEvent(events, (event) => event.verb === 'open_lane') ?? lane.createdAt,
    });
  }
  return attached;
}

function readApprovalEvidence(packetId: string, lanes: LaneEvidence[]) {
  const laneIds = new Set(lanes.map((entry) => entry.lane.id));
  const sessionKeys = new Set(lanes.flatMap((entry) => (
    entry.sessionBindings.map((binding) => binding.sessionKey)
  )));
  const rows = getSqlite().prepare(`
    SELECT id, packet_id AS packetId, lane_id AS laneId, session_key AS sessionKey,
           status, created_at AS createdAt, resolved_at AS resolvedAt,
           continuation_json AS continuationJson, args_json AS argsJson
      FROM approvals
     WHERE packet_id = ?
        OR lane_id IN (SELECT id FROM lanes WHERE id IN (${[...laneIds].map(() => '?').join(',') || "''"}))
        OR session_key IN (${[...sessionKeys].map(() => '?').join(',') || "''"})
     ORDER BY created_at ASC
  `).all(packetId, ...laneIds, ...sessionKeys) as Array<ApprovalEvidence & { packetId: string | null }>;
  const sessionWindows = new Map<string, Array<{ laneId: string; start: number; end: number }>>();
  for (const sessionKey of sessionKeys) {
    const timeline = listLanes().flatMap((lane) => laneSessionBindings(
      lane,
      getLaneEvents(lane.id, 5_000),
    ).filter((binding) => binding.sessionKey === sessionKey)
      .map((binding) => ({
        laneId: lane.id,
        start: new Date(binding.start).getTime(),
      })))
      .filter((entry) => Number.isFinite(entry.start))
      .sort((left, right) => left.start - right.start);
    sessionWindows.set(sessionKey, timeline.map((entry, index) => ({
      ...entry,
      end: timeline[index + 1]?.start ?? Number.POSITIVE_INFINITY,
    })));
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    if (row.packetId === packetId || Boolean(row.laneId && laneIds.has(row.laneId))) return true;
    if (row.packetId || row.laneId || !sessionKeys.has(row.sessionKey)) return false;
    return (sessionWindows.get(row.sessionKey) ?? []).some((window) => (
      laneIds.has(window.laneId)
      && row.createdAt >= window.start
      && row.createdAt < window.end
    ));
  });
}

async function readLaneEvidence(state: OrchestratorMissionState) {
  const packetIds = new Set(state.packets.map((packet) => packet.id));
  const candidates = listLanes().map((lane) => ({ lane, events: getLaneEvents(lane.id, 5_000) }));
  const allBindingsByLane = new Map(candidates.map((entry) => {
    return [entry.lane.id, laneSessionBindings(entry.lane, entry.events)] as const;
  }));
  const matched = candidates.filter((entry) => lanePacketId({
    ...entry,
    transcript: [],
    transcriptUnavailable: false,
    identityId: null,
    sessionBindings: [],
  }, packetIds));
  const ordered = matched.sort((left, right) => {
    const leftAt = timestampOfEvent(left.events, (event) => event.verb === 'open_lane') ?? left.lane.createdAt;
    const rightAt = timestampOfEvent(right.events, (event) => event.verb === 'open_lane') ?? right.lane.createdAt;
    return leftAt.localeCompare(rightAt);
  });
  const bindingsByLane = new Map(ordered.map((entry) => {
    return [entry.lane.id, allBindingsByLane.get(entry.lane.id) ?? []] as const;
  }));
  const allBindings = [...allBindingsByLane.values()].flat();
  const transcriptReads = new Map<string, ReturnType<typeof readSessionTranscriptEvents>>();
  return Promise.all(ordered
    .map(async (entry): Promise<LaneEvidence> => {
      const bindings = bindingsByLane.get(entry.lane.id) ?? [];
      if (bindings.length === 0) {
        return {
          ...entry,
          transcript: [],
          transcriptUnavailable: false,
          identityId: null,
          sessionBindings: [],
        };
      }
      const transcript: TranscriptEvent[] = [];
      const identityIds = new Set<string>();
      const resolvedBindings: LaneEvidence['sessionBindings'] = [];
      let transcriptUnavailable = false;
      for (const [index, binding] of bindings.entries()) {
        const inferredRuntime = runtimeIdFromSessionKey(binding.sessionKey);
        const bindingRuntime = inferredRuntime && isOrchestratorRuntime(inferredRuntime)
          ? inferredRuntime
          : entry.lane.runtime;
        const identityId = await resolveRuntimeSessionIdentityId(bindingRuntime, binding.sessionKey);
        if (identityId) identityIds.add(identityId);
        resolvedBindings.push({
          ...binding,
          runtime: bindingRuntime,
          identityId,
        });
        try {
          const readStartedAt = Date.now();
          const existing = transcriptReads.get(binding.sessionKey);
          const transcriptPromise = existing ?? readSessionTranscriptEvents(binding.sessionKey);
          if (!existing) transcriptReads.set(binding.sessionKey, transcriptPromise);
          const resolved = await transcriptPromise;
          const trustedEvents = resolved.events.filter((event) => {
            const timestamp = new Date(event.ts).getTime();
            return Number.isFinite(timestamp) && timestamp < readStartedAt - 1_000;
          });
          const nextLocalBinding = bindings[index + 1]?.start ?? null;
          const nextSessionBinding = allBindings
            .filter((candidate) => (
              candidate !== binding
              && candidate.sessionKey === binding.sessionKey
              && candidate.start > binding.start
            ))
            .sort((left, right) => left.start.localeCompare(right.start))[0]?.start ?? null;
          const end = earliest(nextLocalBinding, nextSessionBinding);
          transcript.push(...trustedEvents.filter((event) => (
            event.ts >= binding.start && (!end || event.ts < end)
          )));
          transcriptUnavailable ||= Boolean(resolved.unsupportedReason)
            || trustedEvents.length < resolved.events.length;
        } catch {
          transcriptUnavailable = true;
        }
      }
      return {
        ...entry,
        transcript: transcript.sort((left, right) => left.ts.localeCompare(right.ts)),
        transcriptUnavailable,
        identityId: identityIds.size === 1 ? [...identityIds][0] ?? null : null,
        sessionBindings: resolvedBindings,
      };
    }));
}

function missionCreatedAt(state: OrchestratorMissionState) {
  const missionId = state.missionId?.trim();
  if (!missionId) return null;
  const registry = readMissionRegistryEntry(missionId, { includeArchived: true });
  if (registry) return isoFromMs(registry.createdAt);
  return isoFromMs(getMissionRecord(missionId)?.createdAt);
}

export async function projectMissionFunnel(state: OrchestratorMissionState): Promise<MissionFunnelReceipt> {
  const createdAt = missionCreatedAt(state);
  const laneEvidence = await readLaneEvidence(state);
  const packetIds = new Set(state.packets.map((packet) => packet.id));
  const packets = state.packets.map((packet) => {
    const lanes = laneEvidence.filter((lane) => lanePacketId(lane, packetIds) === packet.id);
    return packetReceipt({
      packet,
      lanes,
      approvals: readApprovalEvidence(packet.id, lanes),
    });
  });
  const terminalPackets = packets.filter((packet) => packet.terminalDisposition !== 'in_progress'
    && packet.terminalDisposition !== 'unknown');
  const successfulPackets = packets.filter((packet) => packet.terminalDisposition === 'merged'
    || packet.terminalDisposition === 'closed');
  const failedPackets = packets.filter((packet) => packet.terminalDisposition === 'failed');
  const interventionPackets = terminalPackets.filter((packet) => packet.interventions.length > 0);
  const terminalAt = terminalPackets.length === packets.length
    && packets.length > 0
    && terminalPackets.every((packet) => packet.phases.terminalAt)
    ? latest(...terminalPackets.map((packet) => packet.phases.terminalAt))
    : null;
  const totalDurationMs = duration(createdAt, terminalAt);
  const phaseKeys = [
    'queueMs',
    'startupMs',
    'firstOutputMs',
    'executionMs',
    'reviewMs',
    'approvalMs',
    'totalMs',
  ] as const;
  const phasePercentiles = Object.fromEntries(phaseKeys.map((key) => [
    key,
    percentile(packets.flatMap((packet) => packet.durations[key] ?? [])),
  ])) as MissionFunnelReceipt['phasePercentiles'];
  const autonomyPackets = successfulPackets.filter((packet) => (
    packet.strictAutonomousClose !== null && packet.governedAutonomousClose !== null
  ));
  const autonomyComplete = autonomyPackets.length === successfulPackets.length;
  const denominator = terminalPackets.length;
  const strictCount = terminalPackets.filter((packet) => packet.strictAutonomousClose).length;
  const governedCount = terminalPackets.filter((packet) => packet.governedAutonomousClose).length;
  return {
    schemaVersion: MISSION_FUNNEL_SCHEMA_VERSION,
    missionId: state.missionId ?? '',
    createdAt,
    terminalAt,
    totalDurationMs,
    packets,
    terminalPacketCount: terminalPackets.length,
    successfulPacketCount: successfulPackets.length,
    failedPacketCount: failedPackets.length,
    interventionPacketCount: interventionPackets.length,
    attemptCount: packets.reduce((sum, packet) => sum + packet.attemptCount, 0),
    retryCount: packets.reduce((sum, packet) => sum + packet.retryCount, 0),
    interventionCount: packets.reduce((sum, packet) => sum + packet.interventions.length, 0),
    recoveryEventCount: packets.reduce((sum, packet) => sum + packet.recoveryEvents.length, 0),
    strictAutonomousCloseCount: strictCount,
    governedAutonomousCloseCount: governedCount,
    autonomyObservedPacketCount: autonomyPackets.length,
    strictAutonomousCloseRate: autonomyComplete && autonomyPackets.length > 0
      ? strictCount / autonomyPackets.length
      : null,
    governedAutonomousCloseRate: autonomyComplete && autonomyPackets.length > 0
      ? governedCount / autonomyPackets.length
      : null,
    failureRate: denominator > 0 ? failedPackets.length / denominator : null,
    interventionRate: denominator > 0 ? interventionPackets.length / denominator : null,
    throughputPerHour: totalDurationMs && totalDurationMs > 0
      ? successfulPackets.length / (totalDurationMs / 3_600_000)
      : null,
    phasePercentiles,
    missingSignals: [...new Set(packets.flatMap((packet) => packet.missingSignals))],
  };
}
