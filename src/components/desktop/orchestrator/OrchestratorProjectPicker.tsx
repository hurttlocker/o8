'use client';

/**
 * OrchestratorProjectPicker — the "Which project?" empty-state a new orchestrator
 * shows when it hasn't resolved a repo. Instead of starting repo-less (which bled
 * stale mission cards across projects and showed an ambiguous "build in <blank>"
 * hero), the operator picks from their registered projects. Selecting one calls
 * onSelectProject → the existing `o8:select-workspace-scope` path re-binds the
 * tab's repo and the empty state falls through to the normal hero. (2026-07-02)
 *
 * House rules: inline styles only, var(--t-*) tokens, iconoir SVG icons.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Folder, FolderPlus, GitBranch, Search } from 'iconoir-react';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';

const SEARCH_THRESHOLD = 7;

export function OrchestratorProjectPicker({
  workspaceTargets,
  onSelectProject,
  onAddProject,
  onWorkWithoutProject,
}: {
  workspaceTargets: OrchestratorWorkspaceTarget[];
  onSelectProject?: (target: OrchestratorWorkspaceTarget) => void;
  onAddProject?: (mode?: 'scratch' | 'existing') => void;
  onWorkWithoutProject?: () => void;
}) {
  const [query, setQuery] = useState('');
  const showSearch = workspaceTargets.length > SEARCH_THRESHOLD;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workspaceTargets;
    return workspaceTargets.filter((t) =>
      (t.repoName ?? t.label ?? '').toLowerCase().includes(q)
      || (t.branch ?? '').toLowerCase().includes(q),
    );
  }, [workspaceTargets, query]);

  return (
    <div
      style={{
        display: 'flex',
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: 24,
        paddingRight: 24,
        paddingBottom: 24,
        paddingLeft: 24,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          maxWidth: 420,
          minHeight: 0,
        }}
      >
        <div
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 44,
            height: 44,
            borderRadius: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            color: 'var(--t-text-faint)',
            flexShrink: 0,
          }}
        >
          <Folder width={20} height={20} color="currentColor" strokeWidth={1.6} />
        </div>

        <h1
          style={{
            fontSize: 'clamp(18px, 4.5cqw, 25px)',
            fontWeight: 200,
            color: 'var(--t-text)',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
            fontFamily: 'var(--font-sans-system)',
            textWrap: 'balance',
            margin: 0,
            textAlign: 'center',
          }}
        >
          Which project?
        </h1>

        <p
          style={{
            margin: 0,
            maxWidth: 340,
            fontSize: 13,
            fontWeight: 360,
            lineHeight: 1.5,
            color: 'var(--t-text-muted)',
            fontFamily: 'var(--font-sans-system)',
            textWrap: 'balance',
            textAlign: 'center',
          }}
        >
          The orchestrator builds inside a repo. Pick one to start.
        </p>

        {showSearch ? (
          <div style={{ position: 'relative', width: '100%', marginTop: 2 }}>
            <span
              aria-hidden
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--t-text-faint)',
                display: 'inline-flex',
              }}
            >
              <Search width={14} height={14} color="currentColor" strokeWidth={1.7} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              autoFocus
              style={{
                width: '100%',
                boxSizing: 'border-box',
                paddingTop: 8,
                paddingBottom: 8,
                paddingLeft: 33,
                paddingRight: 12,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider)',
                borderRadius: 10,
                background: 'var(--t-input-bg)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: 'var(--font-sans-system)',
                outline: 'none',
              }}
            />
          </div>
        ) : null}

        <div
          style={{
            width: '100%',
            maxHeight: 284,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 3,
            marginTop: 4,
          }}
        >
          {filtered.map((target) => (
            <ProjectRow key={target.id} target={target} onClick={() => onSelectProject?.(target)} />
          ))}
          {filtered.length === 0 ? (
            <div
              style={{
                paddingTop: 16,
                paddingBottom: 16,
                textAlign: 'center',
                fontSize: 12.5,
                color: 'var(--t-text-faint)',
                fontFamily: 'var(--font-sans-system)',
              }}
            >
              No projects match “{query.trim()}”.
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
          <FooterLink
            onClick={() => onAddProject?.('existing')}
            icon={<FolderPlus width={13} height={13} color="currentColor" strokeWidth={1.7} />}
            label="Add a repo"
          />
          {onWorkWithoutProject ? (
            <FooterLink onClick={onWorkWithoutProject} label="Work without a project" />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ target, onClick }: { target: OrchestratorWorkspaceTarget; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const name = target.repoName ?? target.label ?? 'Repo';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        boxSizing: 'border-box',
        paddingTop: 9,
        paddingBottom: 9,
        paddingLeft: 11,
        paddingRight: 11,
        borderWidth: 0,
        borderRadius: 10,
        background: hover ? 'var(--t-hover)' : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 120ms ease',
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', color: 'var(--t-text-muted)', flexShrink: 0 }}>
        <Folder width={16} height={16} color="currentColor" strokeWidth={1.6} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 400,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {target.branch ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
            maxWidth: 130,
            fontSize: 11,
            fontWeight: 400,
            color: 'var(--t-text-faint)',
          }}
        >
          <GitBranch width={11} height={11} color="currentColor" strokeWidth={1.6} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target.branch}</span>
        </span>
      ) : null}
    </button>
  );
}

function FooterLink({ onClick, icon, label }: { onClick: () => void; icon?: ReactNode; label: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12,
        fontWeight: 400,
        color: hover ? 'var(--t-text)' : 'var(--t-text-faint)',
        letterSpacing: '-0.005em',
        transition: 'color 120ms ease',
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0,
      }}
    >
      {icon}
      {label}
    </button>
  );
}
