import { describe, expect, it } from 'vitest';

import type { ApprovalRecord } from '@/lib/approvals/types';
import type { Lane } from '@/lib/lane/types';
import type { OwnedRunRecord } from '@/lib/runtimes/shared/owned-session/types';
import {
  resolveTerminalStatusEvidence,
  type RawTerminalLifecycleEvidence,
  type TerminalStatusState,
} from './resolve';

const observedAt = '2026-08-29T12:00:00.000Z';

function lane(status: Lane['status'], updatedAt = observedAt): Lane {
  return {
    id: 'lane-status-evidence',
    projectId: null,
    label: 'status evidence',
    repoPath: '/repo',
    worktreePath: '/repo/worktree',
    branch: 'feat/status-evidence',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'codex-owned:status-evidence',
    packetId: 'pkt-status-evidence',
    prNumber: null,
    status,
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: updatedAt,
    updatedAt,
    lastEventAt: updatedAt,
    lastEventLabel: status,
  };
}

function ownedRun(outcome: OwnedRunRecord['outcome']): OwnedRunRecord {
  return {
    id: `run-${outcome}`,
    mode: 'launch',
    prompt: 'test status evidence',
    startedAt: observedAt,
    finishedAt: outcome === 'running' ? undefined : observedAt,
    pid: 42,
    stdoutPath: '/tmp/status-evidence.stdout',
    stderrPath: '/tmp/status-evidence.stderr',
    outcome,
  };
}

describe('resolveTerminalStatusEvidence', () => {
  const runtimeCases = [
    ['idle', 'idle'],
    ['running', 'working'],
    ['waiting', 'blocked'],
    ['failed', 'failed'],
    ['completed', 'complete'],
    ['reviewing', 'review-ready'],
  ] as const;

  it.each(runtimeCases)('maps runtime status %s to %s under runtime-event authority', (status, state) => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status,
        observedAt,
      },
    });

    expect(resolved).toMatchObject({ authority: 'runtime-event', state });
  });

  it.each(['cloud', 'remote-customer'] as const)(
    'accepts a registered non-orchestrator %s runtime session',
    (runtime) => {
      const resolved = resolveTerminalStatusEvidence({
        runtimeSession: {
          sessionKey: `${runtime}-owned:status-evidence`,
          runtimeId: runtime,
          status: 'running',
          observedAt,
        },
      });

      expect(resolved).toMatchObject({
        sessionId: `${runtime}-owned:status-evidence`,
        runtime,
        authority: 'runtime-event',
        state: 'working',
      });
    },
  );

  it('returns an unknown record when every observation time is invalid', () => {
    const before = Date.now();
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'remote-customer-owned:invalid-observation',
        runtimeId: 'remote-customer',
        status: 'running',
        observedAt: 'not-a-time',
      },
      rawLifecycle: {
        sessionId: 'remote-customer-owned:invalid-observation',
        runtime: 'remote-customer',
        state: 'active',
        observedAt: 'also-not-a-time',
      },
    });
    const after = Date.now();

    expect(resolved).toMatchObject({
      sessionId: 'remote-customer-owned:invalid-observation',
      runtime: 'remote-customer',
      state: 'unknown',
      authority: 'raw-terminal',
      summary: 'No observation with a valid time was available.',
      evidence: [],
    });
    expect(resolved.fallbackReason).toContain('invalid observation times');
    expect(Date.parse(resolved.observedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(resolved.observedAt)).toBeLessThanOrEqual(after);
  });

  it('keeps missing session identity or runtime as a programming error', () => {
    expect(() => resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: '',
        runtimeId: 'cloud',
        status: 'running',
        observedAt,
      },
    })).toThrow('requires an existing session id and registered runtime');
  });

  const laneCases = [
    ['idle', 'idle'],
    ['running', 'working'],
    ['awaiting_input', 'blocked'],
    ['failed', 'failed'],
    ['completed', 'complete'],
    ['reviewing', 'review-ready'],
  ] as const;

  it.each(laneCases)('maps lane status %s to %s under lane-state authority', (status, state) => {
    const resolved = resolveTerminalStatusEvidence({ lane: lane(status) });

    expect(resolved).toMatchObject({ authority: 'lane-state', state });
    expect(resolved.fallbackReason).toContain('No runtime event evidence');
  });

  const rawStates: TerminalStatusState[] = [
    'idle',
    'working',
    'blocked',
    'failed',
    'complete',
    'review-ready',
    'unknown',
  ];

  it.each(rawStates)('preserves raw terminal state %s under the weakest authority', (state) => {
    const rawLifecycle: RawTerminalLifecycleEvidence = {
      sessionId: 'codex-owned:status-evidence',
      runtime: 'codex',
      state,
      observedAt,
    };
    const resolved = resolveTerminalStatusEvidence({ rawLifecycle });

    expect(resolved).toMatchObject({ authority: 'raw-terminal', state });
    expect(resolved.fallbackReason).toContain('No runtime event or lane state evidence');
  });

  it.each([
    ['running', 'working'],
    ['finished', 'complete'],
    ['interrupted', 'blocked'],
    ['failed', 'failed'],
  ] as const)('maps owned run outcome %s to %s as runtime evidence', (outcome, state) => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status: outcome === 'running' ? 'running' : 'idle',
        observedAt: '2026-08-29T11:59:00.000Z',
      },
      ownedRun: ownedRun(outcome),
    });

    expect(resolved).toMatchObject({ authority: 'runtime-event', state });
    expect(resolved.evidence).toContainEqual({ source: `owned-run:run-${outcome}`, value: outcome });
  });

  it('keeps runtime failure authoritative when a lower lane says working', () => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status: 'failed',
        observedAt,
      },
      lane: lane('running', '2026-08-29T12:01:00.000Z'),
    });

    expect(resolved).toMatchObject({ authority: 'runtime-event', state: 'failed' });
    expect(resolved.evidence).toContainEqual({
      source: 'lane:lane-status-evidence.status',
      value: 'running',
    });
    expect(resolved.fallbackReason).toBeUndefined();
  });

  it.each([
    ['reviewing', 'review-ready'],
    ['awaiting_human', 'blocked'],
  ] as const)(
    'lets lane governance state %s outrank a finished runtime as %s',
    (laneStatus, state) => {
      const resolved = resolveTerminalStatusEvidence({
        runtimeSession: {
          sessionKey: 'codex-owned:status-evidence',
          runtimeId: 'codex',
          status: 'completed',
          observedAt,
        },
        lane: lane(laneStatus, '2026-08-29T12:01:00.000Z'),
      });

      expect(resolved).toMatchObject({ authority: 'lane-state', state });
      expect(resolved.evidence).toContainEqual({
        source: 'runtime-session.status',
        value: 'completed',
      });
      expect(resolved.fallbackReason).toBeUndefined();
    },
  );

  it('keeps runtime evidence above raw terminal disagreement', () => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status: 'idle',
        observedAt,
      },
      rawLifecycle: {
        sessionId: 'codex-owned:status-evidence',
        runtime: 'codex',
        state: 'stalled',
        observedAt: '2026-08-29T12:01:00.000Z',
      },
    });

    expect(resolved).toMatchObject({ authority: 'runtime-event', state: 'idle' });
    expect(resolved.evidence).toContainEqual({ source: 'raw-terminal.lifecycle', value: 'stalled' });
  });

  it('keeps lane evidence above raw terminal disagreement', () => {
    const resolved = resolveTerminalStatusEvidence({
      lane: lane('awaiting_input'),
      rawLifecycle: {
        sessionId: 'codex-owned:status-evidence',
        runtime: 'codex',
        state: 'active',
        observedAt: '2026-08-29T12:01:00.000Z',
      },
    });

    expect(resolved).toMatchObject({ authority: 'lane-state', state: 'blocked' });
    expect(resolved.evidence).toContainEqual({ source: 'raw-terminal.lifecycle', value: 'active' });
  });

  it('uses RuntimeSession lifecycle outcome as runtime-event evidence', () => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status: 'idle',
        observedAt,
        lifecycle: {
          availability: 'ready-for-resume',
          lastOutcome: 'failed',
          lastRunFinishedAt: observedAt,
        },
      },
    });

    expect(resolved).toMatchObject({ authority: 'runtime-event', state: 'failed' });
    expect(resolved.evidence).toContainEqual({
      source: 'runtime-session.lifecycle',
      value: 'ready-for-resume · failed',
    });
  });

  it('falls through to lane state only when runtime evidence is explicitly stale', () => {
    const resolved = resolveTerminalStatusEvidence({
      runtimeSession: {
        sessionKey: 'codex-owned:status-evidence',
        runtimeId: 'codex',
        status: 'running',
        observedAt: '2026-08-29T11:00:00.000Z',
        stale: true,
      },
      lane: lane('reviewing'),
    });

    expect(resolved).toMatchObject({ authority: 'lane-state', state: 'review-ready' });
    expect(resolved.fallbackReason).toContain('Runtime event evidence was stale');
    expect(resolved.evidence).toContainEqual({ source: 'runtime-session.status', value: 'running' });
  });

  it('maps a pending approval to blocked lane evidence and cites the approval', () => {
    const approval = {
      id: 'approval-status-evidence',
      status: 'pending',
      sessionKey: 'codex-owned:status-evidence',
      title: 'Allow governed continuation',
      summary: 'Operator approval is required.',
      updatedAt: Date.parse(observedAt),
    } as ApprovalRecord;
    const resolved = resolveTerminalStatusEvidence({
      lane: lane('running', '2026-08-29T11:59:00.000Z'),
      approvals: [approval],
    });

    expect(resolved).toMatchObject({ authority: 'lane-state', state: 'blocked' });
    expect(resolved.evidence).toContainEqual({
      source: 'approval:approval-status-evidence',
      value: 'pending · Operator approval is required.',
    });
  });

  it('maps an active review_queue row to review-ready lane evidence', () => {
    const resolved = resolveTerminalStatusEvidence({
      lane: lane('running', '2026-08-29T11:59:00.000Z'),
      reviewQueue: [{
        id: 'review-status-evidence',
        laneId: 'lane-status-evidence',
        status: 'pending',
        updatedAt: observedAt,
      }],
    });

    expect(resolved).toMatchObject({ authority: 'lane-state', state: 'review-ready' });
    expect(resolved.evidence).toContainEqual({
      source: 'review_queue:review-status-evidence',
      value: 'pending',
    });
  });

  it('never produces the reserved known-screen-adapter authority in child A', () => {
    const resolved = [
      resolveTerminalStatusEvidence({ lane: lane('idle') }),
      resolveTerminalStatusEvidence({
        runtimeSession: {
          sessionKey: 'codex-owned:status-evidence',
          runtimeId: 'codex',
          status: 'running',
          observedAt,
        },
      }),
      resolveTerminalStatusEvidence({
        rawLifecycle: {
          sessionId: 'codex-owned:status-evidence',
          runtime: 'codex',
          state: 'stalled',
          observedAt,
        },
      }),
    ];

    expect(resolved.every((evidence) => evidence.authority !== 'known-screen-adapter')).toBe(true);
  });
});
