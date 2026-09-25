'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApprovalRecord } from '@/lib/approvals/types';
import {
  resolveTerminalApprovalAdapter,
  TERMINAL_APPROVAL_ADAPTER_SCHEMA,
} from '@/lib/terminal-status/action-adapter';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';

interface TerminalApprovalActionProps {
  active: boolean;
  sessionKey: string;
  tmuxSession: string;
  evidence: TerminalStatusEvidence;
}

const actionStyle = {
  minHeight: 28,
  paddingTop: 0,
  paddingRight: 9,
  paddingBottom: 0,
  paddingLeft: 9,
  borderRadius: 7,
  fontFamily: 'var(--font-sans-system)',
  fontSize: 11,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  cursor: 'pointer',
} as const;

export function TerminalApprovalAction({
  active,
  sessionKey,
  tmuxSession,
  evidence,
}: TerminalApprovalActionProps) {
  const approvalId = useMemo(() => evidence.evidence
    .find((item) => item.source.startsWith('approval:') && item.value.startsWith('pending · '))
    ?.source.slice('approval:'.length) ?? null, [evidence.evidence]);
  const [approval, setApproval] = useState<ApprovalRecord | null>(null);
  const [showStructured, setShowStructured] = useState(true);
  const [confirmReject, setConfirmReject] = useState(false);
  const [confirmContinue, setConfirmContinue] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [notice, setNotice] = useState('');

  const loadApproval = useCallback(async (signal?: AbortSignal) => {
    if (!approvalId) {
      setApproval(null);
      return;
    }
    try {
      const response = await fetch(`/api/panel/approvals?sessionKey=${encodeURIComponent(sessionKey)}`, {
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error('Approval status could not be read.');
      const payload = await response.json() as { approvals?: ApprovalRecord[] };
      setApproval(payload.approvals?.find((candidate) => candidate.id === approvalId) ?? null);
    } catch (error) {
      if (signal?.aborted) return;
      setApproval(null);
      setNotice(error instanceof Error ? error.message : 'Approval status could not be read.');
    }
  }, [approvalId, sessionKey]);

  useEffect(() => {
    if (!active || !approvalId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await loadApproval(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [active, approvalId, loadApproval]);

  const adapter = resolveTerminalApprovalAdapter({
    schema: TERMINAL_APPROVAL_ADAPTER_SCHEMA,
    evidence,
    approval,
    sessionKey,
    tmuxSession,
  });

  const resolve = async (action: 'approve' | 'reject') => {
    if (!adapter || busy) return;
    setBusy(action);
    setNotice('Recording the decision…');
    try {
      const response = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          id: adapter.approvalId,
          ...(action === 'approve' ? { laneChoice: 'continue_in_terminal', approvalUpdatedAt: adapter.approvalUpdatedAt } : {}),
          terminalAdapter: {
            schema: adapter.schema,
            authority: adapter.authority,
            sessionKey: adapter.sessionKey,
            tmuxSession: adapter.tmuxSession,
            approvalUpdatedAt: adapter.approvalUpdatedAt,
          },
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; note?: string };
      if (!response.ok || !result.ok) throw new Error(result.error ?? result.note ?? 'Decision was not recorded.');
      setApproval(null);
      setNotice(result.note ?? (action === 'approve' ? 'Continue in this terminal.' : 'Request rejected.'));
      setConfirmReject(false);
      setConfirmContinue(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Decision was not recorded.');
      await loadApproval();
    } finally {
      setBusy(null);
    }
  };

  if (!active || (!adapter && !notice)) return null;

  return (
    <div
      data-terminal-approval-action={adapter?.approvalId ?? 'result'}
      style={{
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: 'var(--t-panel)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      {adapter ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-brand-orange)' }}>
            Approval required
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: 300 }}>
            {approval?.title}
          </span>
          <button type="button" style={{ ...actionStyle, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-input-bg)', color: 'var(--t-text-secondary)' }} onClick={() => setShowStructured((current) => !current)}>
            {showStructured ? 'Show raw terminal' : 'Show approval'}
          </button>
        </div>
      ) : null}
      {adapter && showStructured ? (
        <div style={{ marginTop: 7, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 180, fontSize: 11, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-secondary)' }}>
            {approval?.description || approval?.summary}
            <span style={{ display: 'block', marginTop: 3 }}>Continue this live CLI here. Recording that choice sends no turn and starts no new run.</span>
          </span>
          {confirmContinue ? <span style={{ fontSize: 10.5, color: 'var(--t-text-secondary)' }}>Record that you will continue here?</span> : null}
          <button type="button" disabled={busy !== null} style={{ ...actionStyle, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-brand-orange)', background: 'var(--t-brand-orange)', color: 'var(--t-brand-orange-contrast)' }} onClick={() => {
            if (!confirmContinue) {
              setConfirmReject(false);
              setConfirmContinue(true);
            } else void resolve('approve');
          }}>
            {busy === 'approve' ? 'Recording…' : confirmContinue ? 'Confirm terminal' : 'Handle here'}
          </button>
          {confirmReject ? (
            <span style={{ fontSize: 10.5, color: 'var(--t-danger)' }}>Reject this request?</span>
          ) : null}
          <button type="button" disabled={busy !== null} style={{ ...actionStyle, border: '1px solid var(--t-danger-border)', background: 'var(--t-danger-soft)', color: 'var(--t-danger)' }} onClick={() => {
            if (!confirmReject) {
              setConfirmContinue(false);
              setConfirmReject(true);
            }
            else void resolve('reject');
          }}>
            {busy === 'reject' ? 'Rejecting…' : confirmReject ? 'Confirm reject' : 'Reject'}
          </button>
          {confirmReject || confirmContinue ? (
            <button type="button" disabled={busy !== null} style={{ ...actionStyle, border: '1px solid var(--t-divider-subtle)', background: 'transparent', color: 'var(--t-text-secondary)' }} onClick={() => { setConfirmReject(false); setConfirmContinue(false); }}>
              Cancel
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? <div role="status" style={{ marginTop: 5, fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>{notice}</div> : null}
    </div>
  );
}
