'use client';

import { useRef, useState } from 'react';
import { FloatingSurface } from '../../FloatingSurface';
import { useComposerChipCompact } from '../composer-compact-context';
import { ComposerPopover } from './ComposerPopover';
import type { ThoughtsChatPermissionMode } from './types';

/** What Full access allows when the lead's commands run confined to the workspace (#3658). */
export const WORKSPACE_FULL_ACCESS_DETAIL = 'Can edit files and run commands that write only in this workspace';

/** Next-message permissions sit inside the composer and shrink with its row. */
export function ComposerPermissionChip({ mode, onChange, fullAccessDetail = 'Can edit files and run actions' }: {
  mode: ThoughtsChatPermissionMode;
  onChange: (mode: ThoughtsChatPermissionMode) => void;
  fullAccessDetail?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const compact = useComposerChipCompact();
  const label = mode === 'full' ? 'Full access' : 'Plan only';
  return <>
    <button ref={triggerRef} type="button" aria-label={`Permissions: ${label}`} title={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, paddingTop: 0, paddingBottom: 0,
        paddingLeft: 6, paddingRight: 6, border: 0, borderRadius: 7, background: 'transparent',
        color: 'var(--t-text-muted)', cursor: 'pointer', fontSize: 10.5, fontWeight: 300,
        fontFamily: 'var(--font-sans-system)', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" />
      </svg>
      {!compact ? <span>{label}</span> : null}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => { setOpen(false); triggerRef.current?.focus(); }} align="start">
      <FloatingSurface role="menu" aria-label="Permissions for next message" style={{ width: 232 }} contentStyle={{ padding: 6 }}>
        {([
          { mode: 'full', label: 'Full access', detail: fullAccessDetail },
          { mode: 'plan', label: 'Plan only', detail: 'Inspect and propose without edits' },
        ] as const).map(option => <button key={option.mode} type="button" role="menuitemradio" aria-checked={mode === option.mode}
          onClick={() => { onChange(option.mode); setOpen(false); triggerRef.current?.focus(); }}
          style={{ display: 'flex', flexDirection: 'column', gap: 2, width: '100%', paddingTop: 8, paddingBottom: 8,
            paddingLeft: 10, paddingRight: 10, border: 0, borderRadius: 8, background: mode === option.mode ? 'var(--t-hover)' : 'transparent',
            color: 'var(--t-text)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans-system)' }}>
          <span style={{ fontSize: 12, fontWeight: 400 }}>{option.label}</span>
          <span style={{ fontSize: 10.5, color: 'var(--t-text-muted)' }}>{option.detail}</span>
        </button>)}
      </FloatingSurface>
    </ComposerPopover>
  </>;
}
