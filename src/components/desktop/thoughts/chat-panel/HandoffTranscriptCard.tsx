'use client';

import { useState } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

const LAYERS = ['narrative', 'intent', 'workspace', 'governance', 'provenance'] as const;

function label(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback;
}

export function HandoffTranscriptCard({
  handoff,
  timestampLabel,
}: {
  handoff: NonNullable<MobileTranscriptEntry['handoff']>;
  timestampLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const source = label(handoff.from?.model, label(handoff.from?.backend, 'Unknown source'));
  const destination = label(handoff.to.model, handoff.to.backend);
  const omitted = LAYERS.filter((layer) => handoff.carries[layer] === 'omitted');
  const packet = handoff.packet ?? {};
  const workspace = packet.workspace && typeof packet.workspace === 'object'
    ? packet.workspace as Record<string, unknown>
    : null;
  const governance = packet.governance && typeof packet.governance === 'object'
    ? packet.governance as Record<string, unknown>
    : null;
  const narrative = packet.narrative && typeof packet.narrative === 'object'
    ? packet.narrative as Record<string, unknown>
    : null;
  const governedPackets = Array.isArray(governance?.packets) ? governance.packets.length : 0;
  const approvals = Array.isArray(governance?.approvals) ? governance.approvals.length : 0;
  const compactedBy = narrative?.compactedBy && typeof narrative.compactedBy === 'object'
    ? narrative.compactedBy as Record<string, unknown>
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%' }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-expanded={open}
        aria-label={`${source} handed off to ${destination} — ${open ? 'hide' : 'view'} details`}
        style={{
          width: '100%',
          maxWidth: 'min(480px, 94%)',
          minHeight: 48,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 9,
          paddingRight: 12,
          paddingBottom: 9,
          paddingLeft: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: hovered ? 'var(--t-border)' : 'var(--t-divider)',
          borderRadius: open ? '12px 12px 0 0' : 12,
          background: hovered ? 'var(--t-bg-card)' : 'var(--t-input-bg)',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <span aria-hidden="true" style={{ width: 28, height: 28, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--t-accent-soft)', color: 'var(--t-accent)', flexShrink: 0 }}>
          <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 5h9" /><path d="m8.5 2.5 2.5 2.5-2.5 2.5" />
            <path d="M14 11H5" /><path d="m7.5 8.5-2.5 2.5 2.5 2.5" />
          </svg>
        </span>
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {source} → {destination}
          </span>
          <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', lineHeight: 1.25, color: 'var(--t-text-faint)' }}>
            {handoff.lossless ? 'Lossless same-session handoff' : 'Cold handoff'} · {omitted.length === 0 ? 'all layers carried' : `${omitted.join(', ')} omitted`}
          </span>
        </span>
        {timestampLabel ? <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)', flexShrink: 0 }}>{timestampLabel}</span> : null}
        <svg width={11} height={11} viewBox="0 0 12 12" fill="none" stroke="var(--t-text-faint)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
          <path d="M4.5 2.5 8 6 4.5 9.5" />
        </svg>
      </button>
      {open ? (
        <div style={{ width: '100%', maxWidth: 'min(480px, 94%)', display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 11, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderRight: '1px solid var(--t-divider)', borderBottom: '1px solid var(--t-divider)', borderLeft: '1px solid var(--t-divider)', borderRadius: '0 0 12px 12px', background: 'var(--t-input-bg)', animation: 'o8StatusDetailIn 180ms cubic-bezier(0.22, 1, 0.36, 1) both' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 6 }}>
            {LAYERS.map((layer) => (
              <div key={layer} style={{ paddingTop: 7, paddingRight: 8, paddingBottom: 7, paddingLeft: 8, borderRadius: 8, background: 'var(--t-bg-card)', border: '1px solid var(--t-divider-subtle)' }}>
                <div style={{ fontSize: 9.5, fontWeight: 300, color: 'var(--t-text-faint)', textTransform: 'capitalize', letterSpacing: '-0.1px' }}>{layer}</div>
                <div style={{ marginTop: 3, fontSize: 11, fontWeight: 300, color: handoff.carries[layer] === 'omitted' ? 'var(--t-brand-red)' : 'var(--t-text)' }}>{handoff.carries[layer]}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10.5, fontWeight: 300, color: 'var(--t-text-muted)', lineHeight: 1.4 }}>
            {workspace ? <span>Workspace: {String(workspace.branch ?? 'unknown branch')} · {workspace.dirty === true ? 'uncommitted changes present' : 'clean'}</span> : null}
            {governance ? <span>Governance: {governedPackets} packet{governedPackets === 1 ? '' : 's'} · {approvals} approval{approvals === 1 ? '' : 's'}</span> : null}
            {compactedBy ? <span>Compacted by {String(compactedBy.model ?? compactedBy.backend ?? 'unknown model')}</span> : null}
            {omitted.length > 0 ? <span>Not provided: {omitted.join(', ')}. The receiving agent was instructed to say so when those layers matter.</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
