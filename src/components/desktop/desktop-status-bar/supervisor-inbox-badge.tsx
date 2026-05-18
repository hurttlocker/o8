'use client';

import { useEffect, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';

export function SupervisorInboxBadge() {
  const [humanRequiredCount, setHumanRequiredCount] = useState(0);

  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: { humanRequiredCount?: unknown } }>).detail;
      const nextCount = detail?.data?.humanRequiredCount;
      if (typeof nextCount === 'number' && Number.isFinite(nextCount)) {
        setHumanRequiredCount(Math.max(0, Math.floor(nextCount)));
      }
    };

    window.addEventListener('o8:supervisor-inbox', handleUpdate);
    return () => {
      window.removeEventListener('o8:supervisor-inbox', handleUpdate);
    };
  }, []);

  const active = humanRequiredCount > 0;
  const background = active ? 'var(--t-warning-soft, rgba(249,115,22,0.11))' : 'var(--t-chrome-btn-bg)';
  const chromeShadow = 'var(--t-chrome-btn-shadow)';
  const countBackground = active ? 'var(--t-warning, #f97316)' : 'transparent';
  const countColor = active ? '#ffffff' : 'var(--t-text-muted)';

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
        gap: 6,
        height: 22,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 6,
        border: active ? `1px solid var(--t-warning-border, rgba(249,115,22,0.22))` : 'none',
        boxShadow: active ? 'none' : chromeShadow,
        background,
        color: active ? 'var(--t-warning, #c2410c)' : 'var(--t-chrome-btn-text, var(--t-text))',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <WarningCircle size={11} weight={active ? 'fill' : 'bold'} />
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '-0.01em',
        }}
      >
        Inbox
      </span>
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
