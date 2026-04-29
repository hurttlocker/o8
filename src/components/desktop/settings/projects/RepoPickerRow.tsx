'use client';

/**
 * RepoPickerRow — a single checkbox + repo + role-popover row used inside
 * the ProjectForm's repo list. Extracted from ProjectsPanel so the surface
 * stays under the 800-line ceiling.
 */

import { useState } from 'react';
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

export function RepoPickerRow({
  repo,
  checked,
  role,
  onToggle,
  onChangeRole,
}: {
  repo: RepoRegistryEntry;
  checked: boolean;
  role: ProjectRole | null;
  onToggle: () => void;
  onChangeRole: (role: ProjectRole | null) => void;
}) {
  const [openPopover, setOpenPopover] = useState(false);

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
        background: checked ? 'rgba(255, 90, 31, 0.04)' : 'transparent',
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
        <span style={{ fontFamily: APP_FONT_STACK, fontSize: 12.5, fontWeight: 500, color: 'var(--t-text)', letterSpacing: '-0.005em' }}>
          {repo.name}
        </span>
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 10, color: RAMS_INK_QUIET, marginLeft: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
          {repo.localPath}
        </span>
      </button>

      {checked ? (
        <button
          type="button"
          onClick={() => setOpenPopover((prev) => !prev)}
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
            fontFamily: MONO_FONT_STACK,
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          {role ?? 'role'}
          <ChevronGlyph size={9} rotated={openPopover} />
        </button>
      ) : null}

      {openPopover && checked ? (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% - 4px)',
            right: 8,
            zIndex: 30,
            minWidth: 160,
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
      ) : null}
    </div>
  );
}
