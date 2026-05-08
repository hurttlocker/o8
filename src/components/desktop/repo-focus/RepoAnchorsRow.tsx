'use client';

import type { RepoFocusRepo } from './types';
import { REPO_FOCUS_FONT, REPO_FOCUS_MONO, currentBranch, normalizeRepoPath } from './utils';

interface RepoAnchorsRowProps {
  repos: RepoFocusRepo[];
  selectedRepoPath: string | null;
  onSelect: (repoPath: string | null) => void;
}

const CHIP_HEIGHT = 28;

export function RepoAnchorsRow({ repos, selectedRepoPath, onSelect }: RepoAnchorsRowProps) {
  const selected = selectedRepoPath ? normalizeRepoPath(selectedRepoPath) : '';

  if (repos.length === 0) return null;

  return (
    <div
      role="tablist"
      aria-label="Project repositories"
      className="hide-scrollbar"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 2,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 10,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={!selected}
        onClick={() => onSelect(null)}
        title="Project-wide view"
        style={chipStyle(!selected)}
        onMouseEnter={(e) => {
          if (selected) e.currentTarget.style.borderColor = 'var(--t-border)';
        }}
        onMouseLeave={(e) => {
          if (selected) e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
        }}
      >
        <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }}>
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1.4" />
            <rect x="14" y="3" width="7" height="7" rx="1.4" />
            <rect x="3" y="14" width="7" height="7" rx="1.4" />
            <rect x="14" y="14" width="7" height="7" rx="1.4" />
          </svg>
        </span>
        <span>All</span>
      </button>

      {repos.map((repo) => {
        const path = normalizeRepoPath(repo.localPath);
        const isActive = path === selected;
        return (
          <button
            key={repo.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(isActive ? null : repo.localPath)}
            title={repo.localPath}
            style={chipStyle(isActive)}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.borderColor = 'var(--t-border)';
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.borderColor = 'var(--t-divider-subtle)';
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              {repo.name}
            </span>
            <span
              style={{
                fontFamily: REPO_FOCUS_MONO,
                fontSize: 9.5,
                color: isActive ? 'var(--t-accent)' : 'var(--t-text-faint)',
                paddingTop: 1,
                paddingRight: 5,
                paddingBottom: 1,
                paddingLeft: 5,
                borderRadius: 6,
                background: isActive ? 'var(--t-accent-soft)' : 'var(--t-input-bg)',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {currentBranch(repo)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: CHIP_HEIGHT,
    paddingTop: 0,
    paddingRight: 8,
    paddingBottom: 0,
    paddingLeft: 10,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: active ? 'var(--t-accent-border)' : 'var(--t-divider-subtle)',
    borderRadius: 999,
    background: active ? 'var(--t-accent-soft)' : 'transparent',
    color: active ? 'var(--t-accent)' : 'var(--t-text)',
    cursor: 'pointer',
    flexShrink: 0,
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: '-0.005em',
    transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
    whiteSpace: 'nowrap',
  };
}
