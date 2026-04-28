'use client';

/**
 * HistoryRowActions — hover-reveal action cluster for an orchestrator history
 * row. Renders 4 hairline icons (pin, rename, export, delete) inline with the
 * row. Parent owns the state; this component is presentational.
 */

import { memo } from 'react';

interface HistoryRowActionsProps {
  visible: boolean;
  pinned: boolean;
  isDeleting: boolean;
  exportStatus: 'idle' | 'copying' | 'copied' | 'error';
  onPin: () => void;
  onRename: () => void;
  onExport: () => void;
  onDelete: () => void;
}

function PinIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function PencilIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  );
}

function ExportIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function ActionButton({
  onClick,
  disabled,
  title,
  active,
  accentColor,
  children,
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled: boolean;
  title: string;
  active?: boolean;
  accentColor?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderWidth: 0,
        borderRadius: 8,
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: active ? (accentColor ?? 'var(--t-accent)') : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        flexShrink: 0,
      }}
      onMouseEnter={(event) => {
        if (disabled || active) return;
        event.currentTarget.style.background = 'var(--t-bg-card)';
        event.currentTarget.style.color = accentColor ?? 'var(--t-text)';
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.color = 'var(--t-text-muted)';
      }}
    >
      {children}
    </button>
  );
}

function HistoryRowActionsBase({ visible, pinned, isDeleting, exportStatus, onPin, onRename, onExport, onDelete }: HistoryRowActionsProps) {
  const showStrip = visible || pinned || exportStatus !== 'idle';
  const exportActive = exportStatus === 'copied';
  const exportAccent = exportStatus === 'error' ? 'var(--t-danger, #ef4444)' : undefined;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        opacity: showStrip ? 1 : 0,
        transition: 'opacity 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        flexShrink: 0,
        paddingRight: 4,
      }}
    >
      <ActionButton
        onClick={(event) => { event.stopPropagation(); onPin(); }}
        disabled={isDeleting}
        title={pinned ? 'Unpin' : 'Pin to top'}
        active={pinned}
      >
        <PinIcon size={14} filled={pinned} />
      </ActionButton>
      <ActionButton
        onClick={(event) => { event.stopPropagation(); onRename(); }}
        disabled={isDeleting}
        title="Rename"
      >
        <PencilIcon size={14} />
      </ActionButton>
      <ActionButton
        onClick={(event) => { event.stopPropagation(); onExport(); }}
        disabled={isDeleting || exportStatus === 'copying'}
        title={exportStatus === 'copied' ? 'Copied as Markdown' : 'Copy thread as Markdown'}
        active={exportActive}
        accentColor={exportAccent}
      >
        <ExportIcon size={14} />
      </ActionButton>
      <ActionButton
        onClick={(event) => { event.stopPropagation(); onDelete(); }}
        disabled={isDeleting}
        title="Delete conversation"
        accentColor="var(--t-danger, #ef4444)"
      >
        <TrashIcon size={14} />
      </ActionButton>
    </div>
  );
}

export const HistoryRowActions = memo(HistoryRowActionsBase);
