'use client';

import { useState } from 'react';
import type {
  TerminalStatusAuthority,
  TerminalStatusEvidence,
} from '@/lib/terminal-status/resolve';

const AUTHORITY_CAPTION: Record<TerminalStatusAuthority, string> = {
  'runtime-event': 'runtime',
  'lane-state': 'lane',
  'known-screen-adapter': 'adapter',
  'raw-terminal': 'terminal',
};

const EVIDENCE_LABEL_COLUMN_WIDTH = 144;

interface DisplayEvidenceRow {
  authority: TerminalStatusAuthority;
  sources: string[];
  value: string;
}

export function terminalStatusCaption(evidence: TerminalStatusEvidence): string {
  return `${evidence.state} · ${AUTHORITY_CAPTION[evidence.authority]}`;
}

export function terminalEvidenceSourceLabel(source: string): string {
  if (source === 'runtime-session.status') return 'Runtime status';
  if (source === 'runtime-session.lifecycle') return 'Runtime lifecycle';
  if (source.startsWith('owned-run:')) return 'Run';
  if (/^lane:.*\.status$/.test(source)) return 'Lane status';
  if (source.startsWith('lane-event:')) {
    const verb = source.slice('lane-event:'.length).replace(/[_-]+/g, ' ').trim();
    return verb ? `Lane event · ${verb}` : 'Lane event';
  }
  if (source.startsWith('approval:')) return 'Approval';
  if (source.startsWith('review_queue:')) return 'Review queue';
  if (source === 'raw-terminal.lifecycle') return 'Terminal';
  return source;
}

function sourceAuthority(
  source: string,
  fallback: TerminalStatusAuthority,
): TerminalStatusAuthority {
  if (source.startsWith('runtime-session.') || source.startsWith('owned-run:')) {
    return 'runtime-event';
  }
  if (/^lane:.*\.status$/.test(source)
    || source.startsWith('lane-event:')
    || source.startsWith('approval:')
    || source.startsWith('review_queue:')) {
    return 'lane-state';
  }
  if (source.startsWith('known-screen-adapter')) return 'known-screen-adapter';
  if (source.startsWith('raw-terminal.')) return 'raw-terminal';
  return fallback;
}

function displayEvidenceRows(evidence: TerminalStatusEvidence): DisplayEvidenceRow[] {
  return evidence.evidence.reduce<DisplayEvidenceRow[]>((rows, item) => {
    const authority = sourceAuthority(item.source, evidence.authority);
    const previous = rows.at(-1);
    if (previous?.value === item.value && previous.authority === authority) {
      previous.sources.push(item.source);
      return rows;
    }
    rows.push({ authority, sources: [item.source], value: item.value });
    return rows;
  }, []);
}

export function relativeObservationTime(observedAt: string, now = Date.now()): string {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed)) return observedAt;
  const seconds = Math.max(0, Math.round((now - observed) / 1_000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function EvidenceRow({
  source,
  sourceTitle = source,
  value,
  valueTitle,
}: {
  source: string;
  sourceTitle?: string;
  value: string;
  valueTitle?: string;
}) {
  return (
    <div
      data-terminal-status-evidence-row={source}
      style={{
        display: 'grid',
        gridTemplateColumns: `${EVIDENCE_LABEL_COLUMN_WIDTH}px minmax(0, 1fr)`,
        gap: 10,
        minHeight: 36,
        alignItems: 'center',
        paddingTop: 6,
        paddingRight: 10,
        paddingBottom: 6,
        paddingLeft: 10,
        borderTopWidth: 1,
        borderTopStyle: 'solid',
        borderTopColor: 'var(--t-divider-subtle)',
      }}
    >
      <span
        style={{
          minWidth: 0,
          color: 'var(--t-text-faint)',
          fontSize: 9,
          fontWeight: 300,
          letterSpacing: '0.04em',
          lineHeight: '14px',
          textTransform: 'uppercase',
          overflowWrap: 'anywhere',
        }}
        title={sourceTitle}
      >
        {source}
      </span>
      <span
        style={{
          minWidth: 0,
          color: 'var(--t-text-muted)',
          fontSize: 11.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
          overflowWrap: 'anywhere',
        }}
        title={valueTitle}
      >
        {value}
      </span>
    </div>
  );
}

export function TerminalStatusEvidenceDisclosure({
  evidence,
  defaultExpanded = false,
}: {
  evidence: TerminalStatusEvidence;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const caption = terminalStatusCaption(evidence);
  const evidenceRows = displayEvidenceRows(evidence);

  return (
    <div
      data-terminal-status-evidence={evidence.sessionId}
      style={{
        width: '100%',
        minWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'var(--t-panel)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Hide' : 'Show'} status evidence for ${evidence.sessionId}`}
        title={evidence.summary}
        onClick={() => setExpanded((current) => !current)}
        style={{
          width: '100%',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 5,
          paddingRight: 10,
          paddingBottom: 5,
          paddingLeft: 10,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text)',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans-system)',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.background = 'var(--t-hover)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.background = 'transparent';
        }}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span
            data-terminal-status-caption
            style={{
              display: 'block',
              color: 'var(--t-text)',
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              lineHeight: 1.25,
              textTransform: 'lowercase',
            }}
          >
            {caption}
          </span>
          <span
            style={{
              display: 'block',
              marginTop: 4,
              color: 'var(--t-text-faint)',
              fontSize: 9.5,
              fontWeight: 260,
              letterSpacing: '-0.4px',
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {evidence.summary}
          </span>
        </span>
        <svg
          aria-hidden
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            color: 'var(--t-text-faint)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>

      {expanded ? (
        <div role="group" aria-label="Session status diagnostics">
          <EvidenceRow source="authority" value={evidence.authority} />
          <EvidenceRow
            source="observed"
            value={relativeObservationTime(evidence.observedAt)}
            valueTitle={evidence.observedAt}
          />
          {evidenceRows.map((item, index) => (
            <EvidenceRow
              key={`${item.sources.join(':')}:${item.value}:${index}`}
              source={terminalEvidenceSourceLabel(item.sources[0])}
              sourceTitle={item.sources.join('\n')}
              value={item.value}
            />
          ))}
          {evidence.fallbackReason ? (
            <EvidenceRow source="fallback" value={evidence.fallbackReason} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
