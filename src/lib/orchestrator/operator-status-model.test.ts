import { describe, expect, it, vi } from 'vitest';

import {
  buildOperatorStatusAgents,
  resolveAgentSummaryStatuses,
  summarizeOperatorStatus,
} from './operator-status-model';
import type { AgentSummary } from '@/lib/fleet/types';
import type { Lane } from '@/lib/lane/types';

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: 'codex-owned:1',
    name: 'packet worker',
    squadId: 'squad-codex',
    runtime: 'codex',
    model: 'codex',
    primaryModel: 'codex',
    status: 'failed',
    currentTask: 'running tests',
    workspace: '/repo/worktree',
    branch: 'issue/test',
    sessionKey: 'codex-owned:1',
    approvalStatus: 'none',
    lastEventAt: '2m ago',
    lastActivityAt: Date.now(),
    context: { usedPercent: 0, trend: 'stable' },
    alerts: 0,
    sessionId: '1',
    sessionKind: 'owned',
    surfaceLabel: 'Codex',
    runtimeSurface: {
      id: 'codex-owned:1',
      runtime: 'codex',
      kind: 'terminal-session',
      ownership: 'owned',
      title: 'packet worker',
      cwd: '/repo/worktree',
      branch: 'issue/test',
      sourceLabel: 'test',
      capabilities: { attach: true, readTail: true, sendInput: true, interrupt: true },
    },
    ...overrides,
  } as AgentSummary;
}

function lane(overrides: Partial<Lane>): Lane {
  return {
    id: 'lane-1',
    repoPath: '/repo',
    branch: 'issue/test',
    baseBranch: 'main',
    status: 'running',
    runtime: 'codex',
    label: 'packet worker',
    sessionKey: 'codex-owned:1',
    packetId: 'pkt-1',
    worktreePath: '/repo/worktree',
    writerToken: null,
    ownership: 'owned',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:01:00.000Z',
    lastEventAt: '2026-07-07T00:01:00.000Z',
    lastEventLabel: 'session_running',
    mergeMode: 'direct',
    mergeModeNote: null,
    ...overrides,
  } as Lane;
}

describe('operator status model', () => {
  it('keeps runtime failure authoritative when the lane still says running', () => {
    const agents = buildOperatorStatusAgents([agent({ status: 'failed' })], [lane({ status: 'running' })]);

    expect(agents).toHaveLength(1);
    expect(agents[0].status).toBe('failed');
    expect(agents[0].authority).toBe('runtime-event');
    expect(agents[0].summary).toBe('codex runtime reports this session as failed.');
    expect(agents[0].observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(agents[0].statusEvidence.evidence).toContainEqual({
      source: 'lane:lane-1.status',
      value: 'running',
    });
  });

  it('keeps summary honest when the returned agents include a real terminal failure', () => {
    const agents = buildOperatorStatusAgents([agent({ status: 'failed' })], []);
    const summary = summarizeOperatorStatus({ agents, approvalCount: 0 });

    expect(agents[0].status).toBe('failed');
    expect(summary).toContain('0 agents running');
    expect(summary).toContain('1 needs attention');
    expect(summary).toContain('Last: packet worker failed');
  });

  it('keeps the selected runtime state, summary, and observation time coherent', () => {
    const currentObservedAt = '2026-08-29T12:05:00.000Z';
    const [resolved] = resolveAgentSummaryStatuses([agent({
      status: 'completed',
      lastActivityAt: Date.parse(currentObservedAt),
      statusEvidence: {
        sessionId: 'codex-owned:1',
        runtime: 'codex',
        state: 'review-ready',
        authority: 'runtime-event',
        observedAt: '2026-08-29T12:00:00.000Z',
        summary: 'codex runtime reports this session as review-ready.',
        evidence: [{ source: 'runtime-session.status', value: 'reviewing' }],
      },
    })], []);

    expect(resolved.statusEvidence).toMatchObject({
      state: 'complete',
      authority: 'runtime-event',
      observedAt: currentObservedAt,
      summary: 'codex runtime reports this session as complete.',
    });
    expect(resolved.statusEvidence?.evidence).toEqual(expect.arrayContaining([
      { source: 'runtime-session.status', value: 'reviewing' },
      { source: 'runtime-session.status', value: 'completed' },
    ]));
  });

  it('does not let a lower lane review state override a current runtime event', () => {
    const agents = buildOperatorStatusAgents([agent({ status: 'running' })], [lane({ status: 'reviewing' })]);
    const summary = summarizeOperatorStatus({ agents, approvalCount: 0 });

    expect(agents[0].status).toBe('running');
    expect(agents[0].authority).toBe('runtime-event');
    expect(summary).toContain('1 agent running');
  });

  it('emits cloud and remote-customer sessions with status evidence', () => {
    const sessions = ['cloud', 'remote-customer'].map((runtime) => agent({
      id: `${runtime}-owned:1`,
      name: `${runtime} worker`,
      runtime,
      sessionKey: `${runtime}-owned:1`,
      status: 'running',
    }));

    const agents = buildOperatorStatusAgents(sessions, []);

    expect(agents.map((candidate) => candidate.runtime)).toEqual(['cloud', 'remote-customer']);
    expect(agents.map((candidate) => candidate.statusEvidence.runtime)).toEqual([
      'cloud',
      'remote-customer',
    ]);
    expect(agents.every((candidate) => candidate.authority === 'runtime-event')).toBe(true);
  });

  it('contains a per-session programming error in both status projections', () => {
    const malformed = agent({
      id: '',
      runtime: 'remote-customer',
      sessionKey: '',
      lastEventAt: 'not-a-time',
      lastActivityAt: null,
    });
    const healthy = agent({
      id: 'cloud-owned:healthy',
      runtime: 'cloud',
      sessionKey: 'cloud-owned:healthy',
      status: 'running',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const summaries = resolveAgentSummaryStatuses([malformed, healthy], []);
      const operators = buildOperatorStatusAgents([malformed, healthy], []);

      expect(summaries).toHaveLength(2);
      expect(operators).toHaveLength(2);
      expect(summaries[0].statusEvidence).toMatchObject({
        state: 'unknown',
        authority: 'raw-terminal',
        evidence: [],
      });
      expect(operators[0].statusEvidence).toMatchObject({
        state: 'unknown',
        authority: 'raw-terminal',
        evidence: [],
      });
      expect(summaries[1].statusEvidence?.runtime).toBe('cloud');
      expect(operators[1].statusEvidence.runtime).toBe('cloud');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[terminal-status]'));
    } finally {
      warn.mockRestore();
    }
  });
});
