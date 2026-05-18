'use client';

/**
 * O8PRPane — Pull request surface for the o8 right panel.
 *
 * Two modes:
 *   • List (no PR selected) — fetches /api/panel/prs and shows a scrollable
 *     summary list grouped by repo. Picking one opens the detail view.
 *   • Detail — delegates to <PrPanel> (Cursor-style header + tabs).
 */

import { useCallback, useEffect, useState } from 'react';
import { PrPanel } from './pr-panel/PrPanel';

interface PRSummary {
  number: number;
  title: string;
  author: string | { login: string };
  headRefName: string;
  baseRefName: string;
  state: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  url: string;
}

interface O8PRPaneProps {
  prNumber?: number | null;
  repo?: string | null;
}

const ADD_SOFT = '#91c99d';
const DELETE_SOFT = '#d99a9a';
const ADD = '#70b57f';
const DELETE = '#c97878';
const MERGE = '#aaa0c7';
const MERGE_BG = 'rgba(170, 160, 199, 0.095)';
const ADD_BG = 'rgba(112, 181, 127, 0.08)';
const DELETE_BG = 'rgba(201, 120, 120, 0.08)';
const ACCENT_BG = 'rgba(141, 159, 189, 0.065)';

function GitMergeIcon({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function DiffBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const addPct = Math.round((additions / total) * 100);
  return (
    <div style={{ display: 'flex', width: 40, height: 4, borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
      <div style={{ width: `${addPct}%`, background: ADD }} />
      <div style={{ flex: 1, background: DELETE }} />
    </div>
  );
}

function PRListItem({ pr, onClick }: { pr: PRSummary; onClick: () => void }) {
  const merged = pr.state === 'merged';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: '100%',
        paddingTop: 10,
        paddingRight: 14,
        paddingBottom: 10,
        paddingLeft: 14,
        borderWidth: 0,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        color: 'var(--t-text)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
        transition: 'background 80ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = ACCENT_BG; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <GitMergeIcon size={14} color={merged ? MERGE : ADD} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pr.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
          <span>#{pr.number}</span>
          <span>&middot;</span>
          <span>{pr.baseRefName} &larr; {pr.headRefName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, fontSize: 10 }}>
          <span style={{ color: 'var(--t-text-secondary)' }}>{typeof pr.author === 'string' ? pr.author : pr.author?.login}</span>
          <span style={{ color: 'var(--t-text-faint)' }}>&middot;</span>
          <span style={{ color: ADD_SOFT, fontWeight: 600 }}>+{pr.additions}</span>
          <span style={{ color: DELETE_SOFT, fontWeight: 600 }}>-{pr.deletions}</span>
          <DiffBar additions={pr.additions} deletions={pr.deletions} />
          <span style={{ color: 'var(--t-text-faint)' }}>{pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
          {merged ? (
            <span style={{
              marginLeft: 'auto',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 6,
              paddingRight: 6,
              borderRadius: 999,
              background: MERGE_BG,
              color: MERGE,
              fontWeight: 700,
            }}>
              Merged
            </span>
          ) : pr.state === 'open' ? (
            <span style={{
              marginLeft: 'auto',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 6,
              paddingRight: 6,
              borderRadius: 999,
              background: ADD_BG,
              color: ADD_SOFT,
              fontWeight: 700,
            }}>
              Open
            </span>
          ) : (
            <span style={{
              marginLeft: 'auto',
              paddingTop: 2,
              paddingBottom: 2,
              paddingLeft: 6,
              paddingRight: 6,
              borderRadius: 999,
              background: DELETE_BG,
              color: DELETE_SOFT,
              fontWeight: 700,
            }}>
              Closed
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function O8PRPane({ prNumber, repo }: O8PRPaneProps) {
  const [prList, setPrList] = useState<PRSummary[]>([]);
  const [prListLoading, setPrListLoading] = useState(false);
  const [selectedPr, setSelectedPr] = useState<number | null>(prNumber ?? null);

  // Sync external prNumber — when the user clicks a PR ref in the
  // transcript, dashboard/page.tsx routes through here.
  useEffect(() => {
    if (prNumber) setSelectedPr(prNumber);
  }, [prNumber]);

  // Fetch the open-PR list whenever the repo scope changes.
  useEffect(() => {
    setPrListLoading(true);
    const repoParam = repo ? `?repo=${encodeURIComponent(repo)}` : '';
    fetch(`/api/panel/prs${repoParam}`)
      .then((r) => r.json())
      .then((data) => setPrList(data.prs ?? []))
      .catch(() => {})
      .finally(() => setPrListLoading(false));
  }, [repo]);

  const handleClose = useCallback(() => {
    setSelectedPr(null);
  }, []);

  if (selectedPr) {
    return <PrPanel prNumber={selectedPr} repoSlug={repo ?? null} onClose={handleClose} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      <div style={{
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderBottomWidth: 1,
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <GitMergeIcon size={13} color="var(--t-text-secondary)" />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          Pull Requests
        </span>
        {prList.length > 0 ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 18,
            height: 18,
            paddingLeft: 6,
            paddingRight: 6,
            borderRadius: 999,
            background: 'var(--t-divider-subtle)',
            color: 'var(--t-text-secondary)',
            fontSize: 10,
            fontWeight: 700,
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}>
            {prList.length}
          </span>
        ) : null}
      </div>
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {prListLoading ? (
          <div style={{ paddingTop: 20, paddingBottom: 20, paddingLeft: 14, paddingRight: 14, color: 'var(--t-text-faint)', fontSize: 12, textAlign: 'center' }}>Loading pull requests...</div>
        ) : prList.length === 0 ? (
          <div style={{ paddingTop: 40, paddingBottom: 40, paddingLeft: 14, paddingRight: 14, textAlign: 'center', color: 'var(--t-text-faint)' }}>
            <GitMergeIcon size={28} color="var(--t-text-faint)" />
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 500 }}>No open pull requests</div>
          </div>
        ) : (
          prList.map((item) => (
            <PRListItem key={item.number} pr={item} onClick={() => setSelectedPr(item.number)} />
          ))
        )}
      </div>
    </div>
  );
}
