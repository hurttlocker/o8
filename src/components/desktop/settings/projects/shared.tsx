'use client';

/**
 * Shared types, helpers, glyphs, and small components for the Settings →
 * Projects panel (epic #899 wave 2). Lives next to ProjectsPanel.tsx so the
 * surface stays under the 800-line ceiling.
 */

import { useState, type CSSProperties } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
} from '../shared';
import type { ProjectRole, ProjectWithRepos } from '@/lib/projects/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

// ── API response shapes ──

export interface ProjectsApiResponse {
  projects?: ProjectWithRepos[];
  error?: string;
}

export interface RepoApiResponse {
  repos?: RepoRegistryEntry[];
  error?: string;
}

export interface DismissedApiResponse {
  fingerprints?: string[];
  error?: string;
}

export interface ProjectContextRepoView {
  id: string;
  name: string;
  role: ProjectRole | null;
  isPrimary: boolean;
  isCurrent: boolean;
}

export interface ProjectContextView {
  id: string;
  name: string;
  runtimeProjectId: string;
  settingsProjectId: string | null;
  instructions: string | null;
  repos: ProjectContextRepoView[];
  primaryRepo: ProjectContextRepoView | null;
  currentRepo: ProjectContextRepoView | null;
  relatedRepos: ProjectContextRepoView[];
  source: {
    warnings: string[];
  };
}

export interface ProjectContextApiResponse {
  context?: ProjectContextView;
  taskBrief?: string;
  error?: string;
}

export interface ProjectLockView {
  projectId: string;
  runtimeProjectId: string;
  projectName: string;
  repoName: string;
  laneId: string;
  packetId: string | null;
  label: string;
  status: string;
  runtime: string;
  branch: string;
  stale: boolean;
}

export interface ProjectLocksApiResponse {
  locks?: ProjectLockView[];
  error?: string;
}

// ── Suggestions ──

export interface OrgSuggestion {
  org: string;
  repos: RepoRegistryEntry[];
  fingerprint: string;
}

// ── Confirm strip ──

export type ConfirmKind = { kind: 'delete'; projectId: string } | null;

// ── Curated roles ──

export const CURATED_ROLES: ProjectRole[] = [
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'library',
  'service',
  'infra',
  'docs',
  'site',
  'shared',
];

// ── Helpers ──

export function slugifyName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'project';
}

/**
 * Pull "github-org" from a remote URL like:
 *   https://github.com/hurttlocker/cortex-ide.git
 *   git@github.com:hurttlocker/cortex-ide.git
 *   ssh://git@github.com/hurttlocker/cortex-ide
 */
export function parseGithubOrg(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/[^/]+?(?:\.git)?$/i);
  if (!match) return null;
  return match[1].trim().toLowerCase() || null;
}

/**
 * Fingerprint a candidate org-suggestion by sorted repo IDs so dismissals
 * stay stable even as the registry mutates. Same scheme the Wave 1 storage
 * layer expects (opaque string keyed in dismissed_suggestions.fingerprint).
 */
export function fingerprintOrgSuggestion(org: string, repoIds: string[]): string {
  const sorted = [...repoIds].sort();
  return `github-org:${org}:${sorted.join('|')}`;
}

export function roleColor(role: ProjectRole | null): string {
  // Each role gets a stable accent; muted enough not to fight the orange.
  switch (role) {
    case 'frontend':
      return '#2563eb';
    case 'backend':
      return '#0891b2';
    case 'fullstack':
      return '#7c3aed';
    case 'mobile':
      return '#ea580c';
    case 'library':
      return '#0d9488';
    case 'service':
      return '#4f46e5';
    case 'infra':
      return '#ca8a04';
    case 'docs':
      return '#65a30d';
    case 'site':
      return '#db2777';
    case 'shared':
      return '#475569';
    default:
      return RAMS_INK_QUIET as string;
  }
}

// ── Tiny SVG glyphs (raw — no React icon libs in Tauri) ──

export function PlusGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ display: 'block' }}>
      <path d="M6 1.5v9M1.5 6h9" />
    </svg>
  );
}

export function ChevronGlyph({ size = 10, rotated = false }: { size?: number; rotated?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      style={{ display: 'block', transition: 'transform 160ms', transform: rotated ? 'rotate(180deg)' : 'rotate(0deg)' }}
    >
      <path d="M2.5 3.5L5 6L7.5 3.5" />
    </svg>
  );
}

export function XGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ display: 'block' }}>
      <path d="M2 2l7 7M9 2l-7 7" />
    </svg>
  );
}

export function FolderGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M1.5 3.25h3l1 1.25h5v5a.75.75 0 0 1-.75.75H1.5z" />
    </svg>
  );
}

// ── Popover styling primitive ──

export function popoverItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    paddingTop: 7,
    paddingRight: 12,
    paddingBottom: 7,
    paddingLeft: 12,
    borderWidth: 0,
    background: active ? 'rgba(29, 78, 216, 0.08)' : 'transparent',
    color: 'var(--t-text)',
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: active ? 500 : 400,
    cursor: 'pointer',
    textAlign: 'left',
    letterSpacing: '-0.005em',
  };
}

// ── RepoChip — display-only chip used inside ProjectCard ──

export function RepoChip({
  repoName,
  role,
  onRemove,
  onChangeRole,
  rolePopoverDisabled,
}: {
  repoName: string;
  role: ProjectRole | null;
  onRemove?: () => void;
  onChangeRole?: (role: ProjectRole | null) => void;
  rolePopoverDisabled?: boolean;
}) {
  const [openPopover, setOpenPopover] = useState(false);
  const popoverDisabled = rolePopoverDisabled ?? !onChangeRole;

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 4,
        paddingRight: onRemove ? 4 : 8,
        paddingBottom: 4,
        paddingLeft: 8,
        borderRadius: 4,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: RAMS_HAIRLINE_SOFT,
        background: 'transparent',
        fontFamily: APP_FONT_STACK,
        fontSize: 11.5,
        color: 'var(--t-text)',
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
      }}
    >
      <FolderGlyph size={11} />
      <span style={{ fontWeight: 300 }}>{repoName}</span>
      <button
        type="button"
        onClick={() => { if (!popoverDisabled) setOpenPopover((prev) => !prev); }}
        disabled={popoverDisabled}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          paddingTop: 2,
          paddingRight: 6,
          paddingBottom: 2,
          paddingLeft: 6,
          borderRadius: 3,
          borderWidth: 0,
          background: 'transparent',
          color: role ? roleColor(role) : RAMS_INK_QUIET,
          fontFamily: MONO_FONT_STACK,
          fontSize: 9.5,
          fontWeight: 350,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          cursor: popoverDisabled ? 'default' : 'pointer',
        }}
      >
        {role ?? 'no role'}
        {!popoverDisabled ? <ChevronGlyph size={8} rotated={openPopover} /> : null}
      </button>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove repo"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            borderRadius: 3,
            borderWidth: 0,
            background: 'transparent',
            color: RAMS_INK_QUIET,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#d94f3a'; }}
          onMouseLeave={(e) => { (e.currentTarget.style.color as string) = RAMS_INK_QUIET as string; }}
        >
          <XGlyph size={9} />
        </button>
      ) : null}

      {openPopover && onChangeRole ? (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
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
    </span>
  );
}

// Re-exports so ProjectsPanel's tokens stay typed even after we move helpers.
export { APP_FONT_STACK, MONO_FONT_STACK, RAMS_ACCENT, RAMS_HAIRLINE, RAMS_HAIRLINE_SOFT, RAMS_INK_QUIET };
