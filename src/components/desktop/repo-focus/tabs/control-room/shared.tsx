'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { ClaudeIcon, CodexIcon, GeminiIcon, OpenCodeIcon } from '../../../repo-registry/shared';
import { REPO_FOCUS_FONT } from '../../utils';
import { FLAT_HOVER_SURFACE, GROUP_LABELS, GROUP_TONES } from './constants';

export function RuntimeIcon({ runtime, size = 14 }: { runtime?: string | null; size?: number }) {
  switch (runtime) {
    case 'claude-code':
      return <ClaudeIcon size={size} />;
    case 'gemini':
      return <GeminiIcon size={size} />;
    case 'opencode':
      return <OpenCodeIcon size={size} />;
    default:
      return <CodexIcon size={size} />;
  }
}

export function IconActionButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 23,
        height: 23,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? FLAT_HOVER_SURFACE : 'transparent',
        color: disabled ? 'var(--t-text-faint)' : active ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        flexShrink: 0,
        transition: 'background 140ms ease, color 140ms ease',
      }}
      onMouseEnter={(event) => {
        if (!disabled) event.currentTarget.style.background = FLAT_HOVER_SURFACE;
      }}
      onMouseLeave={(event) => { event.currentTarget.style.background = active ? FLAT_HOVER_SURFACE : 'transparent'; }}
    >
      {children}
    </button>
  );
}

export function StatusChip({ group, count }: { group: 'blocked' | 'review' | 'running' | 'ready'; count: number }) {
  const tone = GROUP_TONES[group];
  return (
    <span
      style={{
        minWidth: 0,
        minHeight: 20,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        borderRadius: 999,
        color: tone.text,
        paddingTop: 0,
        paddingRight: 7,
        paddingBottom: 0,
        paddingLeft: 0,
        fontSize: 10,
        lineHeight: '12px',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: 999, background: tone.dot, flexShrink: 0 }} />
      <span style={{ color: 'var(--t-text-faint)', fontWeight: 560 }}>{GROUP_LABELS[group]}</span>
      <span style={{ fontWeight: 680 }}>{count}</span>
    </span>
  );
}

export function ActionButton({
  label,
  icon,
  primary = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon?: ReactNode;
  primary?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        minHeight: 28,
        borderRadius: 9,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: primary ? 'color-mix(in srgb, var(--t-accent) 35%, var(--t-divider-subtle))' : 'var(--t-divider-subtle)',
        background: primary ? 'color-mix(in srgb, var(--t-accent) 11%, var(--t-panel))' : 'transparent',
        color: primary ? 'var(--t-accent)' : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.58 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        paddingTop: 0,
        paddingRight: 10,
        paddingBottom: 0,
        paddingLeft: 10,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 10.5,
        lineHeight: '14px',
        fontWeight: 620,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 13,
        paddingRight: 0,
        paddingBottom: 4,
        paddingLeft: 0,
        fontSize: 10,
        lineHeight: '13px',
        color: 'var(--t-text-faint)',
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ fontSize: 9.5, lineHeight: '12px', letterSpacing: 0, fontWeight: 500 }}>{count}</span>
    </div>
  );
}

export function TaskIconButton({
  label,
  visible,
  active,
  children,
  onClick,
}: {
  label: string;
  visible: boolean;
  active: boolean;
  children: ReactNode;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 20,
        height: 20,
        border: 0,
        borderRadius: 7,
        background: hovered ? FLAT_HOVER_SURFACE : 'transparent',
        color: hovered || active ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
        cursor: 'pointer',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
      }}
    >
      {children}
    </button>
  );
}

export function MenuActionRow({
  label,
  primary = false,
  danger = false,
  disabled = false,
  onClick,
}: {
  label: string;
  primary?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        minHeight: 30,
        borderRadius: 10,
        border: 0,
        background: hovered && !disabled ? FLAT_HOVER_SURFACE : 'transparent',
        color: disabled
          ? 'var(--t-text-faint)'
          : danger
            ? '#dc2626'
            : primary
              ? 'var(--t-accent)'
              : 'var(--t-text-muted)',
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
        fontFamily: REPO_FOCUS_FONT,
        fontSize: 11.25,
        lineHeight: '15px',
        fontWeight: primary ? 650 : 560,
        transition: 'background 140ms ease, color 140ms ease',
      }}
    >
      {label}
    </button>
  );
}

export function StatusMessage({
  icon,
  tone,
  title,
  body,
}: {
  icon: ReactNode;
  tone: string;
  title: string;
  body: string;
}) {
  return (
    <div
      style={{
        marginTop: 18,
        display: 'flex',
        gap: 9,
        color: 'var(--t-text-muted)',
      }}
    >
      <span style={{ width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tone, flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', color: 'var(--t-text)', fontSize: 12, lineHeight: '16px', fontWeight: 600 }}>
          {title}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 11, lineHeight: '15px', color: 'var(--t-text-faint)' }}>
          {body}
        </span>
      </span>
    </div>
  );
}
