'use client';

/**
 * RepoPickerRow — a single checkbox + repo + role-popover row used inside
 * the ProjectForm's repo list. Extracted from ProjectsPanel so the surface
 * stays under the 800-line ceiling.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  ChevronGlyph,
  CURATED_ROLES,
  FolderGlyph,
  popoverItemStyle,
  roleColor,
} from './shared';
import type { ProjectRole } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const ROLE_POPOVER_WIDTH = 160; const ROLE_POPOVER_GAP = 4; const ROLE_POPOVER_MARGIN = 8; const ROLE_POPOVER_ESTIMATED_HEIGHT = (CURATED_ROLES.length + 1) * 29 + 8;
function computePopoverPosition(rect: DOMRect): { top: number; left: number } {
  const belowTop = rect.bottom + ROLE_POPOVER_GAP; const aboveTop = rect.top - ROLE_POPOVER_GAP - ROLE_POPOVER_ESTIMATED_HEIGHT; const openAbove = belowTop + ROLE_POPOVER_ESTIMATED_HEIGHT > window.innerHeight - ROLE_POPOVER_MARGIN && aboveTop >= ROLE_POPOVER_MARGIN;
  return { top: openAbove ? aboveTop : Math.max(ROLE_POPOVER_MARGIN, Math.min(belowTop, window.innerHeight - ROLE_POPOVER_ESTIMATED_HEIGHT - ROLE_POPOVER_MARGIN)), left: Math.max(ROLE_POPOVER_MARGIN, Math.min(rect.right - ROLE_POPOVER_WIDTH, window.innerWidth - ROLE_POPOVER_WIDTH - ROLE_POPOVER_MARGIN)) };
}

export function RepoPickerRow({
  repo,
  checked,
  role,
  isMain,
  onToggle,
  onSetMain,
  onChangeRole,
}: {
  repo: RepoRegistryEntry;
  checked: boolean;
  role: ProjectRole | null;
  isMain: boolean;
  onToggle: () => void;
  onSetMain: () => void;
  onChangeRole: (role: ProjectRole | null) => void;
}) {
  const [openPopover, setOpenPopover] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null); const popoverRef = useRef<HTMLDivElement | null>(null);

  const togglePopover = () => {
    if (openPopover) { setOpenPopover(false); return; }
    if (!triggerRef.current || typeof window === 'undefined') return;
    setPopoverPosition(computePopoverPosition(triggerRef.current.getBoundingClientRect()));
    setOpenPopover(true);
  };

  useEffect(() => {
    if (!checked && openPopover) { const timer = window.setTimeout(() => setOpenPopover(false), 0); return () => window.clearTimeout(timer); }
    if (!openPopover) return;
    const closePopover = () => setOpenPopover(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closePopover(); }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) closePopover();
    };
    window.addEventListener('keydown', handleKeyDown, true); window.addEventListener('resize', closePopover); window.addEventListener('scroll', closePopover, true); document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true); window.removeEventListener('resize', closePopover); window.removeEventListener('scroll', closePopover, true); document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [checked, openPopover]);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingRight: 8,
        paddingBottom: 8,
        paddingLeft: 8,
        borderRadius: 4,
        position: 'relative',
        background: checked ? 'var(--t-settings-accent-active-bg, rgba(29, 78, 216, 0.04))' : 'transparent',
      }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        onClick={onToggle}
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: checked ? RAMS_ACCENT : RAMS_HAIRLINE,
          borderRadius: 3,
          background: checked ? RAMS_ACCENT : 'transparent',
          cursor: 'pointer',
          padding: 0,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked ? (
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 5.2l2 2 4-4.4" />
          </svg>
        ) : null}
      </button>
      <button
        type="button"
        onClick={onToggle}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          borderWidth: 0,
          textAlign: 'left',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <FolderGlyph size={12} />
        <span style={{ fontFamily: APP_FONT_STACK, fontSize: 12.5, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.005em' }}>
          {repo.name}
        </span>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, color: RAMS_INK_QUIET, marginLeft: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {repo.localPath}
        </span>
      </button>

      {checked ? (
        <button
          type="button"
          onClick={onSetMain}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: isMain ? 'rgba(37, 99, 235, 0.26)' : RAMS_HAIRLINE_SOFT,
            background: isMain ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
            color: isMain ? '#1d4ed8' : RAMS_INK_QUIET,
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '-0.01em',
            textTransform: 'capitalize',
            cursor: isMain ? 'default' : 'pointer',
          }}
        >
          {isMain ? 'main' : 'set main'}
        </button>
      ) : null}

      {checked ? (
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePopover}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 4,
            paddingRight: 8,
            paddingBottom: 4,
            paddingLeft: 8,
            borderRadius: 4,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_HAIRLINE_SOFT,
            background: 'transparent',
            color: role ? roleColor(role) : RAMS_INK_QUIET,
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '-0.01em',
            textTransform: 'capitalize',
            cursor: 'pointer',
          }}
        >
          {role ?? 'role'}
          <ChevronGlyph size={9} rotated={openPopover} />
        </button>
      ) : null}

      {openPopover && checked && popoverPosition && typeof document !== 'undefined' ? createPortal(
        <div
          ref={popoverRef}
          data-o8-settings-portal="true"
          style={{
            position: 'fixed',
            top: popoverPosition.top,
            left: popoverPosition.left,
            zIndex: 30,
            minWidth: ROLE_POPOVER_WIDTH,
            paddingTop: 4,
            paddingBottom: 4,
            borderRadius: 6,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: RAMS_HAIRLINE,
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
          }}
        >
          <button
            type="button"
            onClick={() => { onChangeRole(null); setOpenPopover(false); }}
            style={popoverItemStyle(role === null)}
          >
            <span style={{ flex: 1, color: RAMS_INK_QUIET }}>(no role)</span>
          </button>
          {CURATED_ROLES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => { onChangeRole(r); setOpenPopover(false); }}
              style={popoverItemStyle(role === r)}
            >
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: roleColor(r), flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{r}</span>
            </button>
          ))}
        </div>
      , document.body) : null}
    </div>
  );
}
