'use client';

import { Mail, MailOpen } from 'iconoir-react';
import { openSupervisorInboxTab, useSupervisorInboxCount } from './supervisor-inbox-store';

export function SupervisorInboxBadge() {
  // Count + polling live in the shared store — the branch rail's capsule shows
  // the same number, and two owners meant two pollers for one value.
  const humanRequiredCount = useSupervisorInboxCount();

  const active = humanRequiredCount > 0;
  // 2026-05-27 — operator wants no full-pill orange fill on active. Only
  // the Mail icon + the count number carry the warning color so the badge
  // feels informational, not alarming. Outer button stays transparent.
  const background = 'transparent';
  const countBackground = 'transparent';
  const countColor = active ? 'var(--t-warning)' : 'var(--t-text-muted)';

  return (
    <button
      type="button"
      onClick={openSupervisorInboxTab}
      aria-label={`Supervisor inbox${active ? `, ${humanRequiredCount} human-required item${humanRequiredCount === 1 ? '' : 's'}` : ''}`}
      title={active ? `${humanRequiredCount} human-required inbox item${humanRequiredCount === 1 ? '' : 's'}` : 'Supervisor inbox'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        height: 26,
        minWidth: 36,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 7,
        border: 'none',
        boxShadow: 'none',
        flexShrink: 0,
        background,
        color: active ? 'var(--t-warning)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        fontSize: 11,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Iconoir Mail / MailOpen — operator-locked. Closed envelope when
          something needs attention (unread), open envelope when inbox is
          quiet. Reads more "inbox" than the old warning circle. */}
      {active ? (
        <Mail width={13} height={13} color="currentColor" strokeWidth={2} />
      ) : (
        <MailOpen width={13} height={13} color="currentColor" strokeWidth={2} />
      )}
      {active ? (
        <span
          style={{
            minWidth: 14,
            height: 14,
            paddingLeft: 4,
            paddingRight: 4,
            borderRadius: 7,
            background: countBackground,
            color: countColor,
            fontSize: 9.5,
            fontWeight: 400,
            letterSpacing: '-0.2px',
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {humanRequiredCount > 99 ? '99+' : humanRequiredCount}
        </span>
      ) : null}
    </button>
  );
}
