'use client';

import { useState } from 'react';
import type { AutomationRecord, RunStatus } from './types';

const UI_FONT = 'var(--font-sans-system)';

const MS_MINUTE = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

export function formatRelative(ms: number | null, fallback: string): string {
  if (ms == null) return fallback;
  const delta = ms - Date.now();
  if (delta < 0) {
    const ago = Math.abs(delta);
    if (ago < MS_MINUTE) return 'just now';
    if (ago < MS_HOUR) return `${Math.max(1, Math.floor(ago / MS_MINUTE))}m ago`;
    if (ago < MS_DAY) return `${Math.floor(ago / MS_HOUR)}h ago`;
    return `${Math.floor(ago / MS_DAY)}d ago`;
  }
  if (delta < MS_HOUR) return `in ${Math.max(1, Math.ceil(delta / MS_MINUTE))}m`;
  if (delta < MS_DAY) {
    const hours = Math.floor(delta / MS_HOUR);
    const minutes = Math.floor((delta % MS_HOUR) / MS_MINUTE);
    return minutes > 0 ? `in ${hours}h ${minutes}m` : `in ${hours}h`;
  }
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function repoBasename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function statusColor(status: RunStatus): string {
  if (status === 'running') return 'var(--t-accent)';
  if (status === 'ok') return 'var(--t-success)';
  if (status === 'error') return 'var(--t-brand-red)';
  return 'var(--t-text-faint)';
}

function statusTitle(row: AutomationRecord): string {
  if (row.lastRunStatus === 'error') return row.lastErrorMessage ? `Error: ${row.lastErrorMessage}` : 'Last run failed';
  if (row.lastRunStatus === 'running') return 'Running now';
  if (row.lastRunStatus === 'ok') return 'Last run succeeded';
  return row.enabled ? 'Idle' : 'Paused';
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? 'Disable automation' : 'Enable automation'}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 32,
        height: 18,
        flexShrink: 0,
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        borderWidth: 0,
        borderRadius: 9,
        background: checked ? 'var(--t-accent)' : 'var(--t-divider)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        transition: 'background 120ms ease',
      }}
    >
      <span aria-hidden="true" style={{
        position: 'absolute',
        top: 2,
        left: 2,
        width: 14,
        height: 14,
        borderRadius: '50%',
        background: 'var(--t-panel)',
        transform: checked ? 'translateX(14px)' : 'translateX(0)',
        transition: 'transform 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }} />
    </button>
  );
}

function ActionButton({ children, disabled = false, danger = false, onClick }: {
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        height: 24,
        paddingTop: 0,
        paddingRight: 6,
        paddingBottom: 0,
        paddingLeft: 6,
        borderWidth: 0,
        borderRadius: 6,
        background: 'transparent',
        color: danger ? 'var(--t-brand-red)' : 'var(--t-text-muted)',
        fontSize: 11,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        fontFamily: UI_FONT,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function LastRunLink({ row, onOpenLane }: { row: AutomationRecord; onOpenLane: (row: AutomationRecord) => void }) {
  const [hovered, setHovered] = useState(false);
  const label = row.lastRunAt == null ? 'never ran' : `last ran ${formatRelative(row.lastRunAt, 'just now')}`;
  if (!row.lastLaneId) return <span>{label}</span>;
  return (
    <button
      type="button"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => {
        event.stopPropagation();
        onOpenLane(row);
      }}
      style={{
        paddingTop: 0,
        paddingRight: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        borderWidth: 0,
        background: 'transparent',
        color: 'inherit',
        fontSize: 'inherit',
        fontWeight: 'inherit',
        letterSpacing: 'inherit',
        fontFamily: 'inherit',
        lineHeight: 'inherit',
        textDecoration: hovered ? 'underline' : 'none',
        textUnderlineOffset: 2,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

export function AutomationListRow({
  row,
  onToggle,
  onEdit,
  onRun,
  onDelete,
  onOpenLane,
}: {
  row: AutomationRecord;
  onToggle: (id: string, next: boolean) => Promise<void>;
  onEdit: (row: AutomationRecord) => void;
  onRun: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onOpenLane: (row: AutomationRecord) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'run' | 'delete' | null>(null);
  const running = row.lastRunStatus === 'running' || busy === 'run';
  const revealActions = hovered || focusWithin || confirmDelete;
  const trigger = row.triggerKind === 'cron' ? `cron ${row.cronExpr ?? ''}`.trim() : 'manual';

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 9,
        background: revealActions ? 'var(--t-hover)' : 'transparent',
        opacity: row.enabled ? 1 : 0.62,
        transition: 'background 100ms ease, opacity 100ms ease',
      }}
    >
      <div style={{
        minHeight: 52,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        paddingTop: 7,
        paddingRight: 10,
        paddingBottom: 7,
        paddingLeft: 10,
      }}>
        <span title={statusTitle(row)} aria-label={statusTitle(row)} style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          borderRadius: '50%',
          background: statusColor(row.lastRunStatus),
        }} />
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span title={row.prompt} style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--t-text)',
            fontSize: 13.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
          }}>
            {row.name}
          </span>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--t-text-muted)',
            fontSize: 9.5,
            fontWeight: 260,
            letterSpacing: '-0.4px',
            lineHeight: 1.25,
          }}>
            {trigger}
            <MetaSeparator />
            {repoBasename(row.repoPath)}
            <MetaSeparator />
            {row.runtime}
            <MetaSeparator />
            <LastRunLink row={row} onOpenLane={onOpenLane} />
          </span>
        </div>
        <Toggle
          checked={row.enabled}
          disabled={busy === 'toggle'}
          onChange={(next) => {
            setBusy('toggle');
            void onToggle(row.id, next).finally(() => setBusy(null));
          }}
        />
        <div aria-hidden={!revealActions} style={{
          width: 118,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          overflow: 'hidden',
          opacity: revealActions ? 1 : 0,
          pointerEvents: revealActions ? 'auto' : 'none',
          transition: 'opacity 100ms ease',
        }}>
          <ActionButton disabled={running} onClick={() => {
            setBusy('run');
            void onRun(row.id).finally(() => setBusy(null));
          }}>
            {running ? 'Running' : 'Run'}
          </ActionButton>
          <ActionButton onClick={() => onEdit(row)}>Edit</ActionButton>
          <ActionButton danger onClick={() => setConfirmDelete(true)}>Delete</ActionButton>
        </div>
      </div>
      {confirmDelete ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 6,
          paddingRight: 10,
          paddingBottom: 7,
          paddingLeft: 25,
          borderTopWidth: 1,
          borderTopStyle: 'solid',
          borderTopColor: 'var(--t-divider-subtle)',
        }}>
          <span style={{ flex: 1, fontSize: 11, fontWeight: 300, letterSpacing: '-0.1px', lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
            Delete “{row.name}”? This can’t be undone.
          </span>
          <ActionButton onClick={() => setConfirmDelete(false)}>Cancel</ActionButton>
          <ActionButton danger disabled={busy === 'delete'} onClick={() => {
            setBusy('delete');
            void onDelete(row.id).finally(() => setBusy(null));
          }}>
            {busy === 'delete' ? 'Deleting' : 'Confirm delete'}
          </ActionButton>
        </div>
      ) : null}
    </div>
  );
}

function MetaSeparator() {
  return <span aria-hidden="true" style={{ paddingRight: 5, paddingLeft: 5, color: 'var(--t-text-faint)' }}>·</span>;
}
