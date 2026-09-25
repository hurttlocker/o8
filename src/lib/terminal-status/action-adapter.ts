import type { ApprovalRecord } from '@/lib/approvals/types';
import type { TerminalStatusEvidence } from './resolve';

/** The first terminal action reads o8's durable approval evidence, never PTY text. */
export const TERMINAL_APPROVAL_ADAPTER_SCHEMA = 'o8/terminal-approval/v1' as const;

export interface TerminalApprovalAdapter {
  schema: typeof TERMINAL_APPROVAL_ADAPTER_SCHEMA;
  runtime: 'codex' | 'claude-code';
  screenRegion: 'status-evidence';
  screenSignature: string;
  semanticState: 'approval-required';
  confidence: 'verified';
  authority: 'lane-state';
  sessionKey: string;
  tmuxSession: string;
  approvalId: string;
  approvalUpdatedAt: number;
  rawFallback: 'xterm';
}

export function resolveTerminalApprovalAdapter(input: {
  schema: string;
  evidence: TerminalStatusEvidence;
  approval: ApprovalRecord | null;
  sessionKey: string;
  tmuxSession: string;
}): TerminalApprovalAdapter | null {
  const { schema, evidence, approval, sessionKey, tmuxSession } = input;
  if (schema !== TERMINAL_APPROVAL_ADAPTER_SCHEMA) return null;
  if (!sessionKey.trim() || !tmuxSession.trim() || !approval) return null;
  let runtime: TerminalApprovalAdapter['runtime'];
  if (evidence.runtime === 'codex') runtime = 'codex';
  else if (evidence.runtime === 'claude-code') runtime = 'claude-code';
  else return null;
  if (evidence.authority !== 'lane-state' && evidence.authority !== 'runtime-event') return null;
  if (evidence.sessionId !== sessionKey || approval.sessionKey !== sessionKey) return null;
  if (approval.runtime !== evidence.runtime || approval.status !== 'pending') return null;
  if (approval.continuation?.kind !== 'lane' || approval.continuation.verb !== 'resume') return null;
  if (!Number.isSafeInteger(approval.updatedAt)) return null;
  const observedAt = Date.parse(evidence.observedAt);
  if (!Number.isFinite(observedAt)) return null;
  const source = `approval:${approval.id}`;
  if (!evidence.evidence.some((item) => item.source === source && item.value.startsWith('pending · '))) return null;

  return {
    schema: TERMINAL_APPROVAL_ADAPTER_SCHEMA,
    runtime,
    screenRegion: 'status-evidence',
    screenSignature: source,
    semanticState: 'approval-required',
    confidence: 'verified',
    authority: 'lane-state',
    sessionKey,
    tmuxSession,
    approvalId: approval.id,
    approvalUpdatedAt: approval.updatedAt,
    rawFallback: 'xterm',
  };
}
