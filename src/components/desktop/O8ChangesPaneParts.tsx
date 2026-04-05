'use client';

import type { ReactNode } from 'react';

export type ChangeFilter = 'uncommitted' | 'staged' | 'unstaged' | 'branch' | 'commits';

export function ChevronIcon({ open, size = 10, color = 'currentColor' }: { open: boolean; size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        display: 'block',
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 140ms ease',
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function CopyIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="9" y="9" width="11" height="11" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function ExternalLinkIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14 3h7v7" />
      <path d="M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

export function CheckIcon({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function formatRelativeTime(value?: string | null) {
  if (!value) return 'unknown';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'unknown';
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function matchesCommitSha(candidateSha: string, value?: string | null) {
  if (!value) return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return candidateSha === normalized || candidateSha.startsWith(normalized) || normalized.startsWith(candidateSha);
}

export function filterLabel(filter: ChangeFilter) {
  switch (filter) {
    case 'staged':
      return 'Staged';
    case 'unstaged':
      return 'Unstaged';
    case 'branch':
      return 'Branch Changes';
    case 'commits':
      return 'Recent Commits';
    case 'uncommitted':
    default:
      return 'Uncommitted';
  }
}

export function itemLabel(filter: ChangeFilter, count: number) {
  if (count > 0) {
    return filter === 'commits'
      ? `${count} Recent Commits`
      : `${count} ${filterLabel(filter)}`;
  }
  if (filter === 'commits') return 'No Recent Commits';
  if (filter === 'branch') return 'No Branch Changes';
  return `No ${filterLabel(filter)} Changes`;
}

export function ActionButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 28,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.1)',
        background: disabled ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.06)',
        color: disabled ? 'rgba(255,255,255,0.35)' : '#e2e8f0',
        cursor: disabled ? 'default' : 'pointer',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: '-apple-system, system-ui, sans-serif',
        transition: 'background 140ms ease, border-color 140ms ease',
      }}
      onMouseEnter={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'rgba(255,255,255,0.1)';
        event.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)';
      }}
      onMouseLeave={(event) => {
        if (disabled) return;
        event.currentTarget.style.background = 'rgba(255,255,255,0.06)';
        event.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split('\n');

  return (
    <div
      style={{
        marginTop: 10,
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.08)',
        background: 'rgba(15,23,42,0.46)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          maxHeight: 280,
          overflow: 'auto',
        }}
      >
        <div
          style={{
            fontFamily: '"SF Mono", ui-monospace, monospace',
            fontSize: 11,
            lineHeight: 1.6,
            color: '#cbd5e1',
          }}
        >
          {lines.map((line, index) => {
            const isAddition = line.startsWith('+') && !line.startsWith('+++');
            const isDeletion = line.startsWith('-') && !line.startsWith('---');
            const isHunk = line.startsWith('@@');

            return (
              <div
                key={`${line}-${index}`}
                style={{
                  minHeight: 20,
                  paddingTop: 0,
                  paddingRight: 12,
                  paddingBottom: 0,
                  paddingLeft: 12,
                  display: 'flex',
                  alignItems: 'center',
                  background: isAddition
                    ? 'rgba(34,197,94,0.12)'
                    : isDeletion
                      ? 'rgba(239,68,68,0.12)'
                      : isHunk
                        ? 'rgba(59,130,246,0.12)'
                        : 'transparent',
                  color: isAddition
                    ? '#86efac'
                    : isDeletion
                      ? '#fca5a5'
                      : isHunk
                        ? '#93c5fd'
                        : '#cbd5e1',
                }}
              >
                {line || '\u00A0'}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
