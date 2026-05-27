'use client';

/**
 * O8RepoSelector — the shared repo picker for the O8 panel.
 *
 * Extracted from the Activity tab's selector so the Workspace/Review tab and
 * the Activity tab render the exact same chip (folder-in-circle + label +
 * chevron) and dropdown ("All repos" + repo rows with owner). Both tabs and
 * the left switcher drive ONE shared scope in the dashboard, so picking a repo
 * in either place keeps the whole right panel in sync.
 *
 * Operates on RepoRegistryEntry by localPath (the dashboard's scope key);
 * the Activity feed maps the selected path back to a slug internally.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { shortRepoLabel, normalizeRepoSlug } from '../agent-panel/shared';
import { ACTIVITY_COLORS, IconChevronDown, IconFolder } from '../o8-activity-helpers';
import { repoSlugFromRemote } from '../canvas-utils';
import type { RepoRegistryEntry } from '@/lib/repos/types';

interface O8RepoSelectorProps {
  repos: RepoRegistryEntry[];
  /** True = "All repos" aggregate is active. */
  allRepos: boolean;
  /** localPath of the focused repo when not in All-repos mode. */
  selectedRepoPath: string | null;
  onSelectAll: () => void;
  onSelectRepo: (localPath: string) => void;
  /** Hide the "All repos" row when the surface can't aggregate (default: show). */
  showAllReposOption?: boolean;
  /** Wrapper style override (e.g. flex:1 in the Activity header). */
  style?: CSSProperties;
}

function repoMeta(entry: RepoRegistryEntry): { label: string; owner: string } {
  const slug = repoSlugFromRemote(entry.remoteUrl) ?? normalizeRepoSlug(entry.name) ?? entry.name;
  const label = (slug ? shortRepoLabel(slug) : '') || entry.name || 'repo';
  const owner = slug && slug.includes('/') ? slug.split('/')[0] : '';
  return { label, owner };
}

export function O8RepoSelector({
  repos,
  allRepos,
  selectedRepoPath,
  onSelectAll,
  onSelectRepo,
  showAllReposOption = true,
  style,
}: O8RepoSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectedEntry = selectedRepoPath ? repos.find((r) => r.localPath === selectedRepoPath) ?? null : null;
  const chipLabel = allRepos
    ? 'All repos'
    : selectedEntry ? repoMeta(selectedEntry).label : (repos[0] ? repoMeta(repos[0]).label : 'No repo');

  const pickAll = useCallback(() => { onSelectAll(); setOpen(false); }, [onSelectAll]);
  const pickRepo = useCallback((localPath: string) => { onSelectRepo(localPath); setOpen(false); }, [onSelectRepo]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', minWidth: 0, ...style }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Switch repository"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          minHeight: 28,
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 8,
          borderRadius: 8,
          border: '0.5px solid var(--t-divider-subtle)',
          background: 'var(--t-panel)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 13.5,
          fontWeight: 300,
          color: 'var(--t-text)',
          letterSpacing: '-0.1px',
          lineHeight: 1.25,
        }}
      >
        <span style={{
          width: 18,
          height: 18,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          background: ACTIVITY_COLORS.accentBg,
          color: ACTIVITY_COLORS.accent,
          flexShrink: 0,
        }}>
          <IconFolder size={11} color={ACTIVITY_COLORS.accent} />
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1, textAlign: 'left' }}>
          {chipLabel}
        </span>
        <IconChevronDown size={10} color="var(--t-text-muted)" />
      </button>

      {open ? (
        <div className="cortex-themed-scroll" role="menu" style={{
          position: 'absolute',
          top: 32,
          left: 0,
          right: 0,
          minWidth: 180,
          zIndex: 20,
          borderRadius: 12,
          border: '1px solid var(--t-panel-border)',
          background: 'var(--t-panel-solid)',
          boxShadow: 'var(--t-panel-shadow), 0 8px 24px rgba(15, 23, 42, 0.18)',
          maxHeight: 240,
          overflowY: 'auto',
        }}>
          {showAllReposOption ? (
            <button
              type="button"
              onClick={pickAll}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                paddingTop: 7,
                paddingRight: 12,
                paddingBottom: 7,
                paddingLeft: 12,
                border: 'none',
                borderBottom: '1px solid var(--t-divider-subtle)',
                background: allRepos ? ACTIVITY_COLORS.accentBg : 'transparent',
                color: allRepos ? ACTIVITY_COLORS.accent : 'var(--t-text)',
                fontSize: 13.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans-system)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { if (!allRepos) e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { if (!allRepos) e.currentTarget.style.background = 'transparent'; }}
            >
              All repos
            </button>
          ) : null}
          {repos.map((entry) => {
            const { label, owner } = repoMeta(entry);
            const selected = !allRepos && entry.localPath === selectedRepoPath;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => pickRepo(entry.localPath)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  paddingTop: 7,
                  paddingRight: 12,
                  paddingBottom: 7,
                  paddingLeft: 12,
                  border: 'none',
                  background: selected ? ACTIVITY_COLORS.accentBg : 'transparent',
                  color: selected ? ACTIVITY_COLORS.accent : 'var(--t-text)',
                  fontSize: 13.5,
                  fontWeight: 300,
                  letterSpacing: '-0.1px',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!selected) e.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(e) => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
              >
                <IconFolder size={12} color={selected ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)'} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                  {label}
                </span>
                {owner ? (
                  <span style={{
                    marginLeft: 'auto',
                    paddingLeft: 8,
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    color: 'var(--t-text-faint)',
                    fontFamily: 'var(--font-sans-system)',
                    flexShrink: 0,
                  }}>
                    {owner}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
