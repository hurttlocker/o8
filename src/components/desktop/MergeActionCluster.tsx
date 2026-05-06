'use client';

import { memo, useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink, GitBranch, Loader2 } from './lucide-shims';
import { formatBranchDisplayName } from './repo-registry/shared';

interface MergeActionClusterProps {
  branchName: string | null;
  repoName: string | null;
  /** GitHub remote URL for the active repo. Used to resolve the slug for
   *  /api/panel/prs and /api/panel/prs/[number] calls. */
  repoRemoteUrl: string | null;
}

interface PrSummary {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  mergeable?: 'CLEAN' | 'DIRTY' | 'BLOCKED' | 'UNKNOWN' | string | null;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | string | null;
  statusCheckRollup?: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'ERROR' | string | null;
}

function repoSlugFromRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

function isProtectedBranch(branch: string | null): boolean {
  if (!branch) return false;
  return branch === 'main' || branch === 'master' || branch === 'develop';
}

interface Derived {
  variant: 'merge' | 'view' | 'open' | 'idle';
  statusText: string | null;
  statusTone: 'success' | 'pending' | 'fail' | 'muted';
  pr: PrSummary | null;
  primaryLabel: string;
  primaryIcon: 'check' | 'external' | 'branch';
  disabled: boolean;
}

function derive(
  branch: string | null,
  pr: PrSummary | null,
  repoSlug: string | null,
): Derived {
  if (!branch || !repoSlug) {
    return { variant: 'idle', statusText: null, statusTone: 'muted', pr: null, primaryLabel: '', primaryIcon: 'branch', disabled: true };
  }

  if (pr && pr.state !== 'CLOSED' && pr.state !== 'MERGED') {
    const checks = pr.statusCheckRollup;
    const review = pr.reviewDecision;
    const mergeable = pr.mergeable;
    if (pr.isDraft) {
      return { variant: 'view', statusText: 'Draft PR', statusTone: 'muted', pr, primaryLabel: 'View PR', primaryIcon: 'external', disabled: false };
    }
    if (checks === 'FAILURE' || checks === 'ERROR') {
      return { variant: 'view', statusText: 'Checks failing', statusTone: 'fail', pr, primaryLabel: 'View PR', primaryIcon: 'external', disabled: false };
    }
    if (mergeable === 'DIRTY') {
      return { variant: 'view', statusText: 'Conflicts', statusTone: 'fail', pr, primaryLabel: 'View PR', primaryIcon: 'external', disabled: false };
    }
    if (checks === 'PENDING' || (!checks && review !== 'APPROVED')) {
      return { variant: 'view', statusText: 'Checks running', statusTone: 'pending', pr, primaryLabel: 'View PR', primaryIcon: 'external', disabled: false };
    }
    return { variant: 'merge', statusText: 'Ready to merge', statusTone: 'success', pr, primaryLabel: 'Squash & merge', primaryIcon: 'check', disabled: false };
  }

  if (isProtectedBranch(branch)) {
    return { variant: 'idle', statusText: null, statusTone: 'muted', pr: null, primaryLabel: '', primaryIcon: 'branch', disabled: true };
  }

  return { variant: 'open', statusText: 'No open PR', statusTone: 'muted', pr: null, primaryLabel: 'Open PR', primaryIcon: 'external', disabled: false };
}

function MergeActionClusterBase({ branchName, repoName, repoRemoteUrl }: MergeActionClusterProps) {
  const repoSlug = repoSlugFromRemote(repoRemoteUrl);
  const [pr, setPr] = useState<PrSummary | null>(null);
  const [merging, setMerging] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    if (!repoSlug || !branchName) {
      setPr(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/panel/prs?repo=${encodeURIComponent(repoSlug)}`)
      .then((r) => r.json())
      .then((data: { prs?: PrSummary[] }) => {
        if (cancelled) return;
        const match = (data.prs ?? []).find((entry) => entry.headRefName === branchName) ?? null;
        setPr(match);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [repoSlug, branchName]);

  const derived = derive(branchName, pr, repoSlug);

  const openInBrowser = useCallback((url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const handlePrimary = useCallback(async () => {
    if (derived.disabled) return;
    if (derived.variant === 'view' && derived.pr?.url) {
      openInBrowser(derived.pr.url);
      return;
    }
    if (derived.variant === 'open' && repoSlug && branchName) {
      const compareUrl = `https://github.com/${repoSlug}/pull/new/${encodeURIComponent(branchName)}`;
      openInBrowser(compareUrl);
      return;
    }
    if (derived.variant === 'merge' && derived.pr && repoSlug) {
      setMerging(true);
      try {
        const res = await fetch(`/api/panel/prs/${derived.pr.number}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'merge', repo: repoSlug }),
        });
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (!res.ok) {
          setToast({ tone: 'error', message: body?.error || 'Merge failed' });
          return;
        }
        setToast({ tone: 'success', message: `Merged #${derived.pr.number}` });
        setPr(null);
      } catch (error) {
        setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Merge failed' });
      } finally {
        setMerging(false);
      }
    }
  }, [branchName, derived, openInBrowser, repoSlug]);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(handle);
  }, [toast]);

  const displayBranch = branchName ? formatBranchDisplayName(branchName) : null;
  if (!displayBranch) return null;

  const toneColor = (tone: Derived['statusTone']): string => (
    tone === 'success' ? '#22c55e'
      : tone === 'pending' ? '#f59e0b'
        : tone === 'fail' ? '#ef4444'
          : 'var(--t-text-muted)'
  );

  return (
    <>
      {/* Centered branch + status + PR link */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 11,
          fontWeight: 440,
          color: 'var(--t-text-faint)',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
        }}
        title={repoName ? `${repoName} · ${branchName}` : branchName ?? undefined}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--t-text-muted)' }}>
          <GitBranch size={11} strokeWidth={1.8} />
          {displayBranch}
        </span>
        {derived.statusText ? (
          <span style={{ color: toneColor(derived.statusTone), fontWeight: 600 }}>
            {derived.statusText}
          </span>
        ) : null}
        {derived.pr?.url ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (derived.pr?.url) openInBrowser(derived.pr.url);
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              border: 'none',
              background: 'transparent',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              padding: 0,
              fontSize: 11,
              fontWeight: 440,
              letterSpacing: '-0.005em',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
          >
            #{derived.pr.number}
            <ExternalLink size={9} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {/* Right-side primary action pill */}
      {derived.variant !== 'idle' ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {toast ? (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: toast.tone === 'success' ? '#22c55e' : '#ef4444',
                letterSpacing: '-0.005em',
              }}
            >
              {toast.message}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handlePrimary}
            disabled={derived.disabled || merging}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 4,
              paddingBottom: 4,
              paddingLeft: 12,
              paddingRight: 10,
              borderRadius: 999,
              border: derived.variant === 'merge'
                ? '1px solid rgba(34, 197, 94, 0.32)'
                : '1px solid var(--t-input-border, var(--t-divider))',
              background: derived.variant === 'merge'
                ? 'rgba(34, 197, 94, 0.16)'
                : 'var(--t-input-bg, transparent)',
              color: derived.variant === 'merge' ? '#22c55e' : 'var(--t-text)',
              cursor: derived.disabled || merging ? 'default' : 'pointer',
              opacity: derived.disabled || merging ? 0.6 : 1,
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: '-0.005em',
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {merging ? (
              <Loader2 size={12} strokeWidth={2} style={{ animation: 'spin 0.9s linear infinite' }} />
            ) : derived.primaryIcon === 'check' ? (
              <CheckCircle2 size={12} strokeWidth={2} />
            ) : derived.primaryIcon === 'external' ? (
              <ExternalLink size={12} strokeWidth={2} />
            ) : (
              <GitBranch size={12} strokeWidth={2} />
            )}
            <span>{derived.primaryLabel}</span>
            {derived.variant === 'merge' && !merging ? (
              <ChevronDown size={11} strokeWidth={2} style={{ marginLeft: 2, opacity: 0.7 }} />
            ) : null}
          </button>
        </div>
      ) : null}
    </>
  );
}

export const MergeActionCluster = memo(MergeActionClusterBase);
