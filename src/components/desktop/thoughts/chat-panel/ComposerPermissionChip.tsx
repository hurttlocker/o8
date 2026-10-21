'use client';

import { useRef, useState } from 'react';
import { FloatingSurface } from '../../FloatingSurface';
import { motion, useReducedMotion } from 'framer-motion';
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
  const reduceMotion = useReducedMotion();
  const label = mode === 'full' ? 'Full access' : 'Plan only';
  return <>
    <button ref={triggerRef} type="button" aria-label={`Permissions: ${label}`} title={`${label} · ${mode === 'full' ? fullAccessDetail : 'Inspect and propose without edits'}`}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, paddingTop: 0, paddingBottom: 0,
        paddingLeft: 0, paddingRight: 0, border: 0, borderRadius: 7, background: 'transparent',
        color: mode === 'full' ? 'var(--t-brand-orange)' : 'var(--t-accent)', cursor: 'pointer', fontSize: 10.5, fontWeight: 300,
        fontFamily: 'var(--font-sans-system)', whiteSpace: 'nowrap', flexShrink: 0 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <motion.g initial={false} animate={{ opacity: mode === 'full' ? 1 : 0, scale: mode === 'full' ? 1 : 0.8 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} style={{ transformOrigin: '12px 12px' }}>
          <rect x="4" y="11" width="16" height="10" rx="3" /><path d="M8 11V7a4 4 0 0 1 7.5-2M12 15v2" />
        </motion.g>
        <motion.g initial={false} animate={{ opacity: mode === 'plan' ? 1 : 0, scale: mode === 'plan' ? 1 : 0.8 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} style={{ transformOrigin: '12px 12px' }}>
          <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Zm0 0v6h6M8 13h8M8 17h5" />
        </motion.g>
      </svg>
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
