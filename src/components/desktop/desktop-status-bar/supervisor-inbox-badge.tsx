'use client';

import { useCallback, useEffect, useState } from 'react';
import { Mail, MailOpen } from 'iconoir-react';
import { safeCancelIdleCallback, safeRequestIdleCallback, type SafeIdleCallbackHandle } from '@/lib/util/webview-safe';

export function SupervisorInboxBadge() {
  const [humanRequiredCount, setHumanRequiredCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/panel/supervisor-inbox?scope=all', { cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({})) as {
        summary?: {
          humanRequired?: unknown;
          active?: unknown;
        };
      };
      const nextCount = payload.summary?.humanRequired ?? payload.summary?.active;
      if (typeof nextCount === 'number' && Number.isFinite(nextCount)) {
        setHumanRequiredCount(Math.max(0, Math.floor(nextCount)));
      }
    } catch {
      // The status bar should not surface transient API failures as UI noise.
    }
  }, []);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: { humanRequiredCount?: unknown } }>).detail;
      const nextCount = detail?.data?.humanRequiredCount;
      if (typeof nextCount === 'number' && Number.isFinite(nextCount)) {
        setHumanRequiredCount(Math.max(0, Math.floor(nextCount)));
      } else {
        void refresh();
      }
    };
    const handleFocus = () => {
      void refresh();
    };

    window.addEventListener('o8:supervisor-inbox', handleUpdate);
    window.addEventListener('focus', handleFocus);
    let rICHandle: SafeIdleCallbackHandle | undefined;
    let timeoutHandle: number | undefined;
    rICHandle = safeRequestIdleCallback(() => {
      rICHandle = undefined;
      if (timeoutHandle !== undefined) {
        window.clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      void refresh();
    }, { timeout: 2500, fallbackDelayMs: 1200 });
    timeoutHandle = window.setTimeout(() => {
      timeoutHandle = undefined;
      if (rICHandle !== undefined) safeCancelIdleCallback(rICHandle);
      rICHandle = undefined;
      void refresh();
    }, 1200);
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => {
      window.removeEventListener('o8:supervisor-inbox', handleUpdate);
      window.removeEventListener('focus', handleFocus);
      if (rICHandle !== undefined) safeCancelIdleCallback(rICHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const active = humanRequiredCount > 0;
  // 2026-05-27 — operator wants no full-pill orange fill on active. Only
  // the Mail icon + the count number carry the warning color so the badge
  // feels informational, not alarming. Outer button stays transparent.
  const background = 'transparent';
  const countBackground = 'transparent';
  const countColor = active ? 'var(--t-warning)' : 'var(--t-text-muted)';

  const openInboxTab = () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('o8:open-inbox-tab'));
  };

  return (
    <button
      type="button"
      onClick={openInboxTab}
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
