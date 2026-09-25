'use client';

import { useState, type CSSProperties } from 'react';
import type { ApprovalRecord, ApprovalRisk } from '@/lib/approvals/types';
import { isDiscoveredCliSessionKey } from '@/lib/runtime/discovered-cli-session';
import { isGateApprovalRow } from '@/lib/approvals/gating';
import { composeApprovalCardCopy } from '@/lib/inbox/card-copy';
import { O8RefereeRow, refereeRiskSummary } from './O8RefereeRow';

type ApprovalAction = 'approve' | 'reject';
type LaneChoice = 'continue_in_terminal' | 'start_fresh';

interface O8ApprovalCardsProps {
  approvals: ApprovalRecord[];
  busyApproval: { id: string; action: ApprovalAction } | null;
  noteById: Record<string, string>;
  onResolve: (approval: ApprovalRecord, action: ApprovalAction, laneChoice?: LaneChoice) => void;
}

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)';

function riskTone(risk: ApprovalRisk): { label: string; bg: string; border: string; color: string } {
  if (risk === 'high') {
    return {
      label: 'High risk',
      bg: 'var(--t-danger-soft)',
      border: 'var(--t-danger-border)',
      color: 'var(--t-danger)',
    };
  }
  if (risk === 'medium') {
    return {
      label: 'Medium risk',
      bg: 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 13%, transparent)',
      border: 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 34%, transparent)',
      color: 'var(--t-brand-orange, #FF5A1F)',
    };
  }
  return {
    label: 'Low risk',
    bg: 'var(--t-success-soft)',
    border: 'var(--t-success-border)',
    color: 'var(--t-success)',
  };
}

function toolLabel(approval: ApprovalRecord) {
  if (approval.toolName) return approval.toolName;
  if (approval.command) return 'terminal command';
  if (approval.continuation?.kind === 'lane') return approval.continuation.verb.replace('_', ' ');
  if (approval.continuation?.kind === 'plan') return 'dispatch plan';
  if (approval.continuation?.kind === 'spec-update') return 'spec update';
  return approval.source.replace('-', ' ');
}

function ageLabel(createdAt: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function ApprovalToolIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0-6.4 6.4l-4.1 4.1a2.1 2.1 0 0 0 3 3l4.1-4.1a4.5 4.5 0 0 0 6.4-6.4" />
      <path d="M15 5 19 1" />
      <path d="M18 8 22 4" />
    </svg>
  );
}

function ApprovalActionButton({
  action,
  busy,
  disabled,
  label,
  busyLabel,
  secondary = false,
  onClick,
}: {
  action: ApprovalAction;
  busy: boolean;
  disabled: boolean;
  label?: string;
  busyLabel?: string;
  secondary?: boolean;
  onClick: () => void;
}) {
  const approve = action === 'approve';
  const buttonLabel = label ?? (approve ? 'Approve' : 'Reject');
  const pendingLabel = busyLabel ?? (approve ? 'Approving...' : 'Rejecting...');
  const style: CSSProperties = approve && secondary
    ? {
        borderColor: 'var(--t-divider-subtle)',
        background: 'var(--t-input-bg)',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
      }
    : approve
    ? {
        borderColor: 'var(--t-brand-orange, #FF5A1F)',
        background: disabled ? 'var(--t-input-bg)' : 'var(--t-brand-orange, #FF5A1F)',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-brand-orange-contrast)',
      }
    : {
        borderColor: disabled ? 'var(--t-divider-subtle)' : 'var(--t-danger-border)',
        background: disabled ? 'var(--t-input-bg)' : 'var(--t-danger-soft)',
        color: disabled ? 'var(--t-text-faint)' : 'var(--t-danger)',
      };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        minHeight: 44,
        paddingTop: 0,
        paddingRight: 13,
        paddingBottom: 0,
        paddingLeft: 13,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: UI_FONT,
        fontSize: 12,
        fontWeight: 400,
        letterSpacing: '-0.1px',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        opacity: busy ? 0.75 : 1,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        ...style,
      }}
    >
      {busy ? pendingLabel : buttonLabel}
    </button>
  );
}

function ApprovalRequestCard({
  approval,
  busyApproval,
  note,
  onResolve,
}: {
  approval: ApprovalRecord;
  busyApproval: { id: string; action: ApprovalAction } | null;
  note?: string;
  onResolve: (approval: ApprovalRecord, action: ApprovalAction, laneChoice?: LaneChoice) => void;
}) {
  const [confirmChoice, setConfirmChoice] = useState<LaneChoice | null>(null);
  const tone = riskTone(approval.risk);
  const busyAction = busyApproval?.id === approval.id ? busyApproval.action : null;
  const continuationUnsettled = approval.resolution?.continuationStatus === 'pending'
    || approval.resolution?.continuationStatus === 'outcome_unknown';
  const disabled = busyAction !== null || continuationUnsettled;
  const tool = toolLabel(approval);
  const copy = composeApprovalCardCopy(approval);
  const isMerge = approval.continuation?.kind === 'lane' && approval.continuation.verb === 'merge';
  const isLaneResume = approval.continuation?.kind === 'lane' && approval.continuation.verb === 'resume';
  const hasOriginalCli = isLaneResume && isDiscoveredCliSessionKey(approval.runtime, approval.sessionKey);
  const isUnreviewedMerge = isMerge && approval.title === 'Review required before merge';
  const reason = isUnreviewedMerge
    ? 'No approved review is recorded for this exact revision. Check the current diff before deciding whether to merge.'
    : approval.description || approval.summary;

  return (
    <article
      style={{
        paddingTop: 11,
        paddingRight: 12,
        paddingBottom: 12,
        paddingLeft: 12,
        marginBottom: 8,
        borderRadius: 8,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-bg-card)',
        boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 8%, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--t-brand-orange, #FF5A1F)',
            background: 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 11%, var(--t-input-bg))',
            border: '1px solid color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 30%, transparent)',
            flexShrink: 0,
          }}
        >
          <ApprovalToolIcon />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 17,
                paddingLeft: 6,
                paddingRight: 6,
                borderRadius: 6,
                border: `1px solid ${tone.border}`,
                background: tone.bg,
                color: tone.color,
                fontSize: 9,
                fontWeight: 400,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                lineHeight: 1,
              }}
            >
              {tone.label}
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>
              {ageLabel(approval.createdAt)}
            </span>
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, color: 'var(--t-text)', overflowWrap: 'anywhere' }}>
            {copy.headline}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 10, paddingTop: 9, paddingRight: 10, paddingBottom: 9, paddingLeft: 10, borderRadius: 8, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-input-bg)' }}>
        <div style={{ marginBottom: 3, fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
          Why this needs you
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 350, letterSpacing: '-0.1px', lineHeight: 1.45, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>
          {reason}
        </div>
      </div>

      <details style={{ marginBottom: 9, color: 'var(--t-text-muted)' }}>
        <summary style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 350, color: 'var(--t-text-secondary)' }}>
          {approval.referee ? `Advisory review: ${refereeRiskSummary(approval.referee)} · Details` : 'Request details'}
        </summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, paddingLeft: 12 }}>
          <div style={{ fontSize: 10, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{copy.subline}</div>
          <div style={{ fontSize: 10, lineHeight: 1.4 }}>Tool: <span style={{ fontFamily: MONO_FONT }}>{tool}</span></div>
          {isUnreviewedMerge ? <div style={{ fontSize: 10, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{approval.description}</div> : null}
          {approval.referee ? <O8RefereeRow referee={approval.referee} /> : null}
        </div>
      </details>

      {approval.command ? (
        <pre
          style={{
            marginTop: 8,
            marginRight: 0,
            marginBottom: 0,
            marginLeft: 0,
            maxHeight: 82,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            borderRadius: 7,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            paddingTop: 7,
            paddingRight: 8,
            paddingBottom: 7,
            paddingLeft: 8,
            fontFamily: MONO_FONT,
            fontSize: 10.5,
            fontWeight: 300,
            lineHeight: 1.45,
          }}
        >
          {`$ ${approval.command}`}
        </pre>
      ) : null}

      {hasOriginalCli ? (
        <div style={{ marginTop: 9, fontSize: 10.5, lineHeight: 1.4, color: 'var(--t-text-secondary)' }}>
          {confirmChoice === 'start_fresh'
            ? 'Confirm a separate CLI process. o8 checks the original process and session first. Do not restart that CLI elsewhere while this runs.'
            : confirmChoice === 'continue_in_terminal'
              ? 'Confirm to open the verified original terminal. You enter the next message there; o8 does not send a turn.'
              : 'Open the original terminal to continue manually, or start a separate run after the original stops.'}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <div role={note ? 'status' : undefined} title={note} style={{ flex: 1, minWidth: 0, fontSize: 10, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35, color: note?.startsWith('Cannot ') ? 'var(--t-danger)' : 'var(--t-text-faint)', overflowWrap: 'anywhere' }}>
          {continuationUnsettled
            ? 'Approval recorded; continuation unconfirmed. Inspect the target before another action.'
            : note}
        </div>
        <ApprovalActionButton
          action="reject"
          busy={busyAction === 'reject'}
          disabled={disabled}
          onClick={() => onResolve(approval, 'reject')}
        />
        {hasOriginalCli ? (
          <>
            <ApprovalActionButton
              action="approve"
              busy={busyAction === 'approve'}
              disabled={disabled}
              label={confirmChoice === 'continue_in_terminal' ? 'Confirm and open' : 'Open original terminal'}
              busyLabel="Recording choice..."
              onClick={() => {
                if (confirmChoice === 'continue_in_terminal') onResolve(approval, 'approve', 'continue_in_terminal');
                else setConfirmChoice('continue_in_terminal');
              }}
            />
            <ApprovalActionButton
              action="approve"
              busy={busyAction === 'approve'}
              disabled={disabled}
              label={confirmChoice === 'start_fresh' ? 'Confirm new run' : 'Start new run'}
              busyLabel="Starting new run..."
              secondary
              onClick={() => {
                if (confirmChoice === 'start_fresh') onResolve(approval, 'approve', 'start_fresh');
                else setConfirmChoice('start_fresh');
              }}
            />
            {confirmChoice ? (
              <button type="button" onClick={() => setConfirmChoice(null)} style={{ borderWidth: 0, borderStyle: 'none', background: 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
            ) : null}
          </>
        ) : (
          <ApprovalActionButton
            action="approve"
            busy={busyAction === 'approve'}
            disabled={disabled}
            label={isMerge ? 'Approve merge' : undefined}
            onClick={() => onResolve(approval, 'approve')}
          />
        )}
      </div>
    </article>
  );
}

export function O8ApprovalCards({
  approvals,
  busyApproval,
  noteById,
  onResolve,
}: O8ApprovalCardsProps) {
  if (approvals.length === 0) return null;

  const gateRows = approvals.filter(isGateApprovalRow);
  const infoRows = approvals.filter((approval) => !isGateApprovalRow(approval));

  return (
    <section style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7, paddingLeft: 2, paddingRight: 2 }}>
        <span style={{ fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
          Approval requests
        </span>
        <span style={{ height: 1, flex: 1, background: 'var(--t-divider-subtle)' }} />
        <span style={{ fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-brand-orange, #FF5A1F)' }}>
          {gateRows.length}
        </span>
        {infoRows.length > 0 ? (
          <span
            title={infoRows.map((approval) => approval.title).join('\n')}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 20,
              paddingLeft: 7,
              paddingRight: 7,
              borderRadius: 6,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-input-bg)',
              color: 'var(--t-text-muted)',
              fontSize: 9.5,
              fontWeight: 300,
              letterSpacing: '-0.2px',
              lineHeight: 1,
              whiteSpace: 'nowrap',
            }}
          >
            +{infoRows.length} info
          </span>
        ) : null}
      </div>
      {gateRows.map((approval) => (
        <ApprovalRequestCard
          key={approval.id}
          approval={approval}
          busyApproval={busyApproval}
          note={noteById[approval.id]}
          onResolve={onResolve}
        />
      ))}
    </section>
  );
}
