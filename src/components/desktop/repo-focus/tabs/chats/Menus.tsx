'use client';

import { useEffect } from 'react';
import { REPO_FOCUS_FONT } from '../../utils';
import { historyKindLabel, historyRepoLabel } from './helpers';
import type { HistoryActionMenuState } from './types';

export function HistoryActionMenu({
  state,
  busy,
  canOpen,
  onClose,
  onOpen,
  onTogglePin,
  onArchive,
  onDelete,
}: {
  state: HistoryActionMenuState;
  busy: boolean;
  canOpen: boolean;
  onClose: () => void;
  onOpen: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const menuWidth = 190;
  const menuHeight = 180;
  const panelRect = typeof document === 'undefined'
    ? null
    : document.querySelector('[data-o8-agent-panel="true"]')?.getBoundingClientRect() ?? null;
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const boundaryLeft = panelRect?.left ?? 0;
  const boundaryRight = panelRect?.right ?? viewportWidth;
  const boundaryTop = panelRect?.top ?? 0;
  const boundaryBottom = panelRect?.bottom ?? viewportHeight;
  const minLeft = boundaryLeft + 8;
  const maxLeft = Math.max(minLeft, boundaryRight - menuWidth - 8);
  const left = Math.min(Math.max(state.x, minLeft), maxLeft);
  const minTop = boundaryTop + 8;
  const maxTop = Math.max(minTop, boundaryBottom - menuHeight - 8);
  const top = Math.min(Math.max(state.y, minTop), maxTop);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close chat action menu"
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 58,
          border: 0,
          background: 'transparent',
          cursor: 'default',
        }}
      />
      <div
        data-o8-history-action-menu="true"
        style={{
          position: 'fixed',
          left,
          top,
          zIndex: 59,
          width: menuWidth,
          borderRadius: 13,
          border: '1px solid var(--t-divider-subtle)',
          background: 'color-mix(in srgb, var(--t-bg-elevated, #ffffff) 86%, transparent)',
          boxShadow: '0 18px 48px rgba(15, 23, 42, 0.12)',
          backdropFilter: 'blur(18px) saturate(145%)',
          WebkitBackdropFilter: 'blur(18px) saturate(145%)',
          padding: 7,
          color: 'var(--t-text)',
          fontFamily: REPO_FOCUS_FONT,
        }}
      >
        <div style={{ padding: '4px 7px 7px' }}>
          <div style={{ fontSize: 11.25, lineHeight: '15px', fontWeight: 620, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {state.item.title}
          </div>
          <div style={{ marginTop: 1, color: 'var(--t-text-faint)', fontSize: 10, lineHeight: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {historyRepoLabel(state.item)} - {historyKindLabel(state.item)}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 2 }}>
          <HistoryMenuRow label="Open chat" disabled={!canOpen || busy} onClick={() => run(onOpen)} />
          <HistoryMenuRow label={state.item.pinned ? 'Unpin' : 'Pin'} disabled={busy} onClick={() => run(onTogglePin)} />
          <HistoryMenuRow label={state.archived ? 'Restore' : 'Archive'} disabled={busy} onClick={() => run(onArchive)} />
          <HistoryMenuRow label="Delete" danger disabled={busy} onClick={() => run(onDelete)} />
        </div>
      </div>
    </>
  );
}

function HistoryMenuRow({
  label,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: '100%',
        minHeight: 29,
        borderRadius: 9,
        border: 0,
        background: 'transparent',
        color: disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: danger ? 620 : 560,
        transition: 'background 120ms ease, color 120ms ease',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
        event.currentTarget.style.color = danger ? '#dc2626' : 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = disabled ? 'var(--t-text-faint)' : danger ? '#dc2626' : 'var(--t-text-muted)';
      }}
    >
      {label}
    </button>
  );
}
