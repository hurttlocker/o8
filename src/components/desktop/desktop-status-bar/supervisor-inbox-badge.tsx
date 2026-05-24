'use client';

import { useCallback, useEffect, useState } from 'react';
import { WarningCircleIcon } from './status-bar-icons';

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
    const initialTimer = window.setTimeout(() => {
      void refresh();
    }, 0);
    const timer = window.setInterval(() => {
      void refresh();
    }, 15000);
    return () => {
      window.removeEventListener('o8:supervisor-inbox', handleUpdate);
      window.removeEventListener('focus', handleFocus);
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const active = humanRequiredCount > 0;
  // DESIGN.md §06.7 — flat. Active uses the warning-soft fill (informational
  // emphasis, not a chrome-btn boxy bg). Inactive is transparent; the
  // surrounding footer card chrome already overrides --t-chrome-btn-bg to
  // transparent, but we set it explicitly here so the component stands on
  // its own when consumed outside the card.
  const background = active ? 'var(--t-warning-soft)' : 'transparent';
  const countBackground = active ? 'var(--t-warning)' : 'transparent';
  const countColor = active ? 'var(--t-warning-contrast)' : 'var(--t-text-muted)';

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
        background,
        color: active ? 'var(--t-warning)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <WarningCircleIcon size={12} filled={active} />
      <span
        style={{
          minWidth: 14,
          height: 14,
          paddingLeft: 4,
          paddingRight: 4,
          borderRadius: 7,
          background: countBackground,
          color: countColor,
          fontSize: 9,
          fontWeight: 800,
          lineHeight: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {humanRequiredCount > 99 ? '99+' : humanRequiredCount}
      </span>
    </button>
  );
}
