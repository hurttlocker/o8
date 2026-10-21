import { describe, expect, it } from 'vitest';

import {
  ACCEPTED_LAUNCH_ATTACH_PROVENANCE,
  findCurrentAuthExit,
} from '@/lib/lane/current-auth-exit';
import type { Lane, LaneEvent } from '@/lib/lane/types';

const packetId = 'pkt-auth-exit';
const surfaceId = 'codex-owned:session-1';

function event(id: string, verb: LaneEvent['verb'], payload: Record<string, unknown>): LaneEvent {
  return {
    id,
    laneId: 'lane-auth-exit',
    verb,
    actor: 'system',
    payload,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.slice(1)))).toISOString(),
  };
}

function lane(overrides: Partial<Lane> = {}): Lane {
  return {
    id: 'lane-auth-exit', projectId: null, label: 'Auth exit', repoPath: '/repo',
    worktreePath: '/repo/worktree', branch: 'test/auth-exit', baseBranch: 'main',
    runtime: 'codex', sessionKey: surfaceId, packetId, prNumber: null,
    status: 'awaiting_input', ownership: 'managed', writerToken: null, lastHeartbeatAt: null,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:07.000Z',
    lastEventAt: '2026-01-01T00:00:07.000Z', lastEventLabel: 'codex_auth_recovery_required',
    ...overrides,
  };
}

function exit(id: string, runId: string, authRecoveryRequired = true): LaneEvent {
  return event(id, 'runtime_process_exit', {
    runtime: 'codex', surfaceId, runId, runtimeOutcome: 'failed', authRecoveryRequired,
  });
}

function attach(id: string, acceptedAuthExitRunId: string | null): LaneEvent {
  return event(id, 'attach_session', {
    sessionKey: surfaceId,
    launchAttachProvenance: ACCEPTED_LAUNCH_ATTACH_PROVENANCE,
    launchEventId: 'e1',
    storageEventId: 'e2',
    surfaceId,
    clientMutationId: `packet-launch:${packetId}:3`,
    launchGeneration: 3,
    acceptedAuthExitRunId,
  });
}

function launchEvents(): LaneEvent[] {
  return [
    event('e1', 'status_change', { status: 'launching', eventLabel: 'launching_session' }),
    event('e2', 'update', {
      storageAdmissionOwnerGeneration: 3,
      storageAdmissionReservationId: 'reservation:3',
    }),
  ];
}

function acceptedBeforeAttachEvents(): LaneEvent[] {
  return [
    ...launchEvents(),
    exit('e3', 'run-1'),
    attach('e4', 'run-1'),
    event('e5', 'update', { model: 'gpt-5.6-terra' }),
    event('e6', 'status_change', {
      status: 'awaiting_input', eventLabel: 'codex_auth_recovery_required',
    }),
  ];
}

function delayedExitEvents(boundaries: LaneEvent[] = []): LaneEvent[] {
  return [
    ...launchEvents(),
    attach('e3', null),
    event('e4', 'update', { model: 'gpt-5.6-terra' }),
    event('e5', 'status_change', { status: 'running', eventLabel: 'session_launched' }),
    ...boundaries,
    exit('e9', 'run-2'),
  ];
}

describe('current Codex authentication exit', () => {
  it('accepts bookkeeping after the exact atomic first launch attachment', () => {
    expect(findCurrentAuthExit(lane(), acceptedBeforeAttachEvents())).toMatchObject({
      runId: 'run-1', surfaceId, launchGeneration: 3,
    });
  });

  it('recognizes the first exit from the same run after ordinary launch bookkeeping', () => {
    expect(findCurrentAuthExit(
      lane({ status: 'running', lastEventLabel: 'session_launched' }),
      delayedExitEvents(),
    )).toMatchObject({ runId: 'run-2' });
  });

  it('allows the original session-launched bookkeeping to land just after the first exit', () => {
    const events = [
      ...launchEvents(),
      attach('e3', null),
      event('e4', 'update', { model: 'gpt-5.6-terra' }),
      exit('e5', 'run-2'),
      event('e6', 'status_change', { status: 'running', eventLabel: 'session_launched' }),
    ];
    expect(findCurrentAuthExit(
      lane({ status: 'running', lastEventLabel: 'session_launched' }),
      events,
    )).toMatchObject({ runId: 'run-2' });
  });

  it.each([
    ['same-surface reattachment', [event('e6', 'attach_session', { sessionKey: surfaceId })], {}],
    ['replacement surface', [event('e6', 'attach_session', { sessionKey: 'codex-owned:session-2' })], { sessionKey: 'codex-owned:session-2' }],
    ['new launch', [event('e6', 'status_change', { status: 'launching', eventLabel: 'launching_session' })], {}],
    ['new turn', [event('e6', 'status_change', { status: 'running', eventLabel: 'turn_sent' })], {}],
    ['new run', [exit('e6', 'run-1', false)], {}],
  ] satisfies Array<[string, LaneEvent[], Partial<Lane>]>)
  ('rejects a delayed authentication exit after a %s', (_name, boundaries, overrides) => {
    expect(findCurrentAuthExit(
      lane({ status: 'running', lastEventLabel: 'session_launched', ...overrides }),
      delayedExitEvents(boundaries),
    )).toBeNull();
  });

  it.each([
    ['archived', 'discarded'],
    ['completed', 'merged'],
    ['reviewing', 'agent_completed'],
    ['paused', 'operator_stopped'],
  ] satisfies Array<[Lane['status'], string]>)
  ('preserves a %s lane instead of reviving stale authentication evidence', (status, lastEventLabel) => {
    expect(findCurrentAuthExit(lane({ status, lastEventLabel }), acceptedBeforeAttachEvents())).toBeNull();
  });
});
