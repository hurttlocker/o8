'use client';

import { useState } from 'react';
import type { SupervisorInboxItem } from '@/lib/supervisor/inbox';
import { composeSupervisorInboxCardCopy } from '@/lib/inbox/card-copy';
import { AlertCircle, Archive, ExternalLink, RefreshCw } from '../../../lucide-shims';
import { formatElapsed } from '../../utils';
import { FLAT_HOVER_SURFACE } from './constants';
import { baseName, supervisorKindLabel, supervisorStatusTone } from './helpers';
import { IconActionButton, TaskIconButton } from './shared';
import { openExternalUrl } from '@/lib/desktop/open-external';

export function SupervisorIncidentSection({
  items,
  loading,
  refreshing,
  error,
  busyKey,
  onRefresh,
  onDismiss,
}: {
  items: SupervisorInboxItem[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  busyKey: string | null;
  onRefresh: () => void;
  onDismiss: (item: SupervisorInboxItem) => void;
}) {
  if (!loading && !error && items.length === 0) {
    return null;
  }

  return (
    <section
      style={{
        borderBottom: '1px solid var(--t-divider-subtle)',
        paddingTop: 8,
        paddingBottom: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: 'var(--t-text-faint)',
              fontSize: 10,
              lineHeight: '13px',
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Agent triage
          </div>
        </div>
        <span style={{ color: 'var(--t-text-faint)', fontSize: 9.5, lineHeight: '12px', flexShrink: 0 }}>
          {items.length}
        </span>
        <IconActionButton
          label="Refresh agent triage"
          active={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={12} strokeWidth={2} />
        </IconActionButton>
      </div>

      {error ? (
        <div style={{ color: '#dc2626', fontSize: 10.5, lineHeight: '14px', paddingTop: 5 }}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div style={{ color: 'var(--t-text-faint)', fontSize: 11, lineHeight: '15px', paddingTop: 7 }}>
          Reading supervisor incidents...
        </div>
      ) : null}

      {!loading ? items.map((item) => (
        <SupervisorIncidentRow
          key={item.id}
          item={item}
          busy={busyKey === `supervisor-dismiss:${item.id}`}
          onDismiss={onDismiss}
        />
      )) : null}
    </section>
  );
}

export function SupervisorIncidentRow({
  item,
  busy,
  onDismiss,
}: {
  item: SupervisorInboxItem;
  busy: boolean;
  onDismiss: (item: SupervisorInboxItem) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const tone = supervisorStatusTone(item.status);
  const repoName = baseName(item.repoPath) || 'repo';
  const copy = composeSupervisorInboxCardCopy(item);
  const verificationKind = typeof item.payload.verificationKind === 'string'
    ? item.payload.verificationKind
    : null;
  const metaParts = [
    repoName,
    supervisorKindLabel(item.kind),
    `${formatElapsed(item.lastSeenAt)} ago`,
  ];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 42,
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) auto',
        gap: 8,
        alignItems: 'center',
        borderTop: '1px solid var(--t-divider-subtle)',
        background: hovered ? FLAT_HOVER_SURFACE : 'transparent',
        paddingTop: 6,
        paddingBottom: 6,
        transition: 'background 140ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tone.color,
        }}
      >
        <AlertCircle size={13} strokeWidth={2} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            color: 'var(--t-text)',
            fontSize: 11.75,
            lineHeight: '15px',
            fontWeight: 540,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {copy.headline}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: 'var(--t-text-faint)',
            fontSize: 10.25,
            lineHeight: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {copy.subline || metaParts.join(' - ')}
          {verificationKind ? ` - ${verificationKind}` : ''}
          {item.repeatCount > 1 ? ` - x${item.repeatCount}` : ''}
        </span>
        <span
          style={{
            display: 'block',
            marginTop: 1,
            color: item.status === 'human_required' ? '#dc2626' : 'var(--t-text-muted)',
            fontSize: 10,
            lineHeight: '13px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.errorExcerpt}
        </span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <span
          style={{
            minHeight: 18,
            display: 'inline-flex',
            alignItems: 'center',
            borderRadius: 7,
            background: tone.background,
            color: tone.color,
            paddingTop: 0,
            paddingRight: 5,
            paddingBottom: 0,
            paddingLeft: 5,
            fontSize: 9.25,
            lineHeight: '12px',
            fontWeight: 580,
          }}
        >
          {tone.label}
        </span>
        {item.transcriptLink ? (
          <TaskIconButton
            label="Open transcript"
            visible={hovered}
            active={false}
            onClick={(event) => {
              event.stopPropagation();
              openExternalUrl(item.transcriptLink ?? '');
            }}
          >
            <ExternalLink size={12} strokeWidth={2} />
          </TaskIconButton>
        ) : null}
        <TaskIconButton
          label="Dismiss incident"
          visible={hovered}
          active={busy}
          onClick={(event) => {
            event.stopPropagation();
            if (!busy) onDismiss(item);
          }}
        >
          <Archive size={12} strokeWidth={2} />
        </TaskIconButton>
      </span>
    </div>
  );
}
