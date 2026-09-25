import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { TerminalStatusEvidence } from './resolve';
import { resolveTerminalApprovalAdapter, TERMINAL_APPROVAL_ADAPTER_SCHEMA } from './action-adapter';

const updatedAt = Date.parse('2026-09-25T01:00:00.000Z');
const approval = {
  id: 'approval-current',
  runtime: 'codex',
  sessionKey: 'codex:current',
  status: 'pending',
  updatedAt,
  continuation: { kind: 'lane', laneId: 'lane-current', verb: 'resume' },
} as ApprovalRecord;
const evidence: TerminalStatusEvidence = {
  sessionId: 'codex:current',
  runtime: 'codex',
  state: 'blocked',
  authority: 'lane-state',
  observedAt: new Date(updatedAt).toISOString(),
  summary: 'Approval pending.',
  evidence: [{ source: 'approval:approval-current', value: 'pending · Resume this lane' }],
};

function match(overrides: Partial<Parameters<typeof resolveTerminalApprovalAdapter>[0]> = {}) {
  return resolveTerminalApprovalAdapter({
    schema: TERMINAL_APPROVAL_ADAPTER_SCHEMA,
    evidence,
    approval,
    sessionKey: 'codex:current',
    tmuxSession: 'o8-owned-current',
    ...overrides,
  });
}

describe('terminal approval action adapter', () => {
  it('binds one pending lane resume to the structured approval source and exact session', () => {
    expect(match()).toMatchObject({
      schema: TERMINAL_APPROVAL_ADAPTER_SCHEMA,
      authority: 'lane-state',
      screenSignature: 'approval:approval-current',
      sessionKey: 'codex:current',
      tmuxSession: 'o8-owned-current',
      approvalUpdatedAt: updatedAt,
      rawFallback: 'xterm',
    });
  });

  it('falls back to raw for unknown version, malformed evidence, a different session, or a settled row', () => {
    expect(match({ schema: 'o8/terminal-approval/v2' })).toBeNull();
    expect(match({ evidence: { ...evidence, evidence: [] } })).toBeNull();
    expect(match({ evidence: { ...evidence, authority: 'raw-terminal' } })).toBeNull();
    expect(match({ sessionKey: 'codex:other' })).toBeNull();
    expect(match({ approval: { ...approval, status: 'approved' } })).toBeNull();
    expect(match({ evidence: { ...evidence, observedAt: 'invalid' } })).toBeNull();
    expect(match({ approval: { ...approval, continuation: { kind: 'lane', laneId: 'lane-current', verb: 'merge' } } })).toBeNull();
  });

  it('uses the durable approval source while a current runtime waiting event owns the status caption', () => {
    expect(match({ evidence: { ...evidence, authority: 'runtime-event' } })?.authority).toBe('lane-state');
    expect(match({ evidence: { ...evidence, authority: 'runtime-event', state: 'working' } })?.authority).toBe('lane-state');
  });
});
