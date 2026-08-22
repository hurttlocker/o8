'use client';

import { motion } from 'framer-motion';

import type { BroadcastApprovalSnapshot } from '@/lib/broadcast/types';

const STALE_STATE_MS = 15 * 60_000;

export function broadcastStateAge(nowMs: number, value: string): { label: string; stale: boolean } {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return { label: 'age unavailable', stale: false };
  const elapsedMs = Math.max(0, nowMs - parsed);
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 1) return { label: 'now', stale: false };
  if (elapsedMinutes < 60) return { label: `${elapsedMinutes}m`, stale: elapsedMs >= STALE_STATE_MS };
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return { label: `${elapsedHours}h`, stale: true };
  return { label: `${Math.floor(elapsedHours / 24)}d`, stale: true };
}

function packetLabel(approval: BroadcastApprovalSnapshot): string {
  const target = approval.packetId ?? approval.laneId;
  if (!target) return 'Unassigned';
  return target.length > 24 ? `${target.slice(0, 21)}…` : target;
}

export function BroadcastApprovalInbox({
  items,
  nowMs,
  reduceMotion,
}: {
  items: BroadcastApprovalSnapshot[];
  nowMs: number;
  reduceMotion: boolean;
}) {
  return (
    <section
      aria-label="Pending approvals"
      style={{
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid var(--t-panel-border)',
        borderRadius: 14,
        background: 'var(--t-panel)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingTop: 15,
          paddingRight: 18,
          paddingBottom: 12,
          paddingLeft: 18,
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}
      >
        <span style={{ color: 'var(--t-text-faint)', fontSize: 13, fontWeight: 300, letterSpacing: '0.04em', lineHeight: '18px' }}>
          APPROVALS
        </span>
        <span
          aria-label={`${items.length} pending approvals`}
          style={{
            minWidth: 24,
            paddingTop: 2,
            paddingRight: 7,
            paddingBottom: 2,
            paddingLeft: 7,
            borderRadius: 999,
            background: items.length ? 'var(--t-warning-soft)' : 'var(--t-input-bg)',
            color: items.length ? 'var(--t-warning)' : 'var(--t-text-faint)',
            fontSize: 13,
            fontWeight: 500,
            lineHeight: '18px',
            textAlign: 'center',
          }}
        >
          {items.length}
        </span>
      </div>
      <div style={{ minHeight: 0, overflowY: 'auto', paddingTop: 4, paddingRight: 12, paddingBottom: 4, paddingLeft: 12 }}>
        {items.length ? items.map((approval) => {
          const age = broadcastStateAge(nowMs, approval.createdAt);
          return (
            <motion.article
              key={approval.id}
              data-broadcast-approval="true"
              data-broadcast-age={age.stale ? 'stale' : 'fresh'}
              initial={reduceMotion ? false : { opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) auto',
                columnGap: 12,
                rowGap: 4,
                paddingTop: 11,
                paddingRight: 8,
                paddingBottom: 11,
                paddingLeft: 8,
                borderBottom: '1px solid var(--t-divider-subtle)',
                background: age.stale ? 'var(--t-warning-soft)' : 'transparent',
              }}
            >
              <div style={{ minWidth: 0, color: 'var(--t-text)', fontSize: 16, fontWeight: 350, lineHeight: 1.3, overflowWrap: 'anywhere' }}>
                {approval.title}
              </div>
              <time dateTime={approval.createdAt} style={{ color: age.stale ? 'var(--t-warning)' : 'var(--t-text-faint)', fontSize: 13, fontWeight: 400, lineHeight: 1.3, whiteSpace: 'nowrap' }}>
                {age.label}
              </time>
              <div style={{ color: 'var(--t-text-faint)', fontSize: 13, fontWeight: 300, lineHeight: 1.25, overflowWrap: 'anywhere' }}>
                {packetLabel(approval)} · {approval.risk}
              </div>
            </motion.article>
          );
        }) : (
          <div style={{ paddingTop: 16, paddingRight: 6, paddingBottom: 16, paddingLeft: 6, color: 'var(--t-text-muted)', fontSize: 16, fontWeight: 300, lineHeight: 1.4 }}>
            Inbox clear
          </div>
        )}
      </div>
    </section>
  );
}
