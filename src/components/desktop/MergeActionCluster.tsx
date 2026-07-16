'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, Loader2 } from './lucide-shims';
import { GitBranch } from './tabler-shims';
import { formatBranchDisplayName } from './repo-registry/shared';
import { openExternalUrl } from '@/lib/desktop/open-external';

// Branch-with-check glyph that matches Superconductor's pill icon: two
// branch nodes joined by an arc, with a check mark inside the lower node.
// Renders crisply at 14px in both light and dark themes.
function BranchMergeIcon({
  size = 14,
  color = 'currentColor',
  checkColor = 'var(--t-tone-success-contrast)',
}: {
  size?: number;
  color?: string;
  checkColor?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="11.5" cy="11.5" r="2.4" fill={color} stroke={color} />
      <path d="M4 4.4 V8.5 A2.6 2.6 0 0 0 6.6 11.1 H8.6" />
      <path d="M10.4 11.5 L11.3 12.4 L13 10.6" stroke={checkColor} strokeWidth={1.4} fill="none" />
    </svg>
  );
}

interface MergeActionClusterProps {
  branchName: string | null;
  repoName: string | null;
  /** Compact status bar mode keeps the branch label and hides action chrome. */
  compact?: boolean;
  /** GitHub remote URL for the active repo. Used to resolve the slug for
   *  /api/panel/prs and /api/panel/prs/[number] calls. */
  repoRemoteUrl: string | null;
  /**
   * The repo's default branch. Sitting on it is the resting state, not news —
   * the cluster renders nothing there and lets the terminal control take the
   * centre. It reappears the moment the branch is somewhere worth naming: a PR
   * branch, or an agent's worktree branch (Q 2026-07-16).
   *
   * Passed in rather than assumed to be "main": repos whose default is `master`
   * or `develop` would otherwise show a branch chip permanently, which is the
   * exact noise this removes.
   */
  defaultBranch?: string | null;
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

type MergeMethod = 'squash' | 'merge' | 'rebase';

const MERGE_METHOD_LABELS: Record<MergeMethod, { primary: string; menuLabel: string; description: string }> = {
  squash: { primary: 'Squash & merge', menuLabel: 'Squash and merge', description: 'Combine all commits into one' },
  merge: { primary: 'Create merge commit', menuLabel: 'Create a merge commit', description: 'Keep all commits, add a merge commit' },
  rebase: { primary: 'Rebase & merge', menuLabel: 'Rebase and merge', description: 'Replay commits onto the base, no merge commit' },
};

const TONE = {
  success: {
    text: 'var(--t-tone-success)',
    bg: 'var(--t-tone-success-bg)',
    border: 'var(--t-tone-success-border)',
    contrast: 'var(--t-tone-success-contrast)',
  },
  pending: {
    text: 'var(--t-tone-pending)',
    bg: 'var(--t-tone-pending-bg)',
    border: 'var(--t-tone-pending-border)',
    contrast: 'var(--t-text)',
  },
  fail: {
    text: 'var(--t-tone-fail)',
    bg: 'var(--t-tone-fail-bg)',
    border: 'var(--t-tone-fail-border)',
    contrast: 'var(--t-text)',
  },
  muted: {
    text: 'var(--t-text-muted)',
    bg: 'transparent',
    border: 'transparent',
    contrast: 'var(--t-text)',
  },
} as const;

function repoSlugFromRemote(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const normalized = remoteUrl
    .replace(/\.git$/, '')
    .replace(/^git@github\.com:/, 'https://github.com/');
  const match = normalized.match(/github\.com\/([^/]+\/[^/]+)$/);
  return match?.[1] ?? null;
}

interface Derived {
  variant: 'merge' | 'view' | 'idle';
  statusText: string | null;
  statusTone: 'success' | 'pending' | 'fail' | 'muted';
  pr: PrSummary | null;
  primaryLabel: string;
  primaryIcon: 'check' | 'external' | 'branch';
  disabled: boolean;
}

/**
 * True when the cluster has nothing worth saying: the branch IS the repo's
 * default and no PR is open against it.
 *
 * Exported for tests — the whole point is that it stays quiet on `main` and
 * speaks up everywhere else, and both halves are easy to get wrong.
 */
export function isRestingOnDefaultBranch(
  branch: string | null,
  defaultBranch: string | null | undefined,
  derived: Pick<Derived, 'variant' | 'pr'>,
): boolean {
  if (!branch || !defaultBranch) return false;
  if (branch !== defaultBranch) return false;
  // An open PR against the default branch is real news — keep the chrome.
  return derived.variant === 'idle' && !derived.pr;
}

function derive(
  branch: string | null,
  pr: PrSummary | null,
  repoSlug: string | null,
  mergeMethod: MergeMethod,
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
    return {
      variant: 'merge',
      statusText: 'Ready to merge',
      statusTone: 'success',
      pr,
      primaryLabel: MERGE_METHOD_LABELS[mergeMethod].primary,
      primaryIcon: 'check',
      disabled: false,
    };
  }

  // No open PR → render nothing but the branch chip. Absence of a PR isn't a
  // status worth announcing, and o8-dispatched work merges via the review
  // beacon's Merge, not a GitHub PR. The rare "open a GitHub PR" path lives as
  // "Create pull request" in the workspace panel. (Q ruling 2026-07-11 — no
  // state is the state.)
  return { variant: 'idle', statusText: null, statusTone: 'muted', pr: null, primaryLabel: '', primaryIcon: 'branch', disabled: true };
}

function MergeActionClusterBase({ branchName, repoName, repoRemoteUrl, compact = false, defaultBranch = null }: MergeActionClusterProps) {
  const repoSlug = compact ? null : repoSlugFromRemote(repoRemoteUrl);
  const [pr, setPr] = useState<PrSummary | null>(null);
  const [merging, setMerging] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'fail'; message: string } | null>(null);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>('squash');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);

  // Restore last-used merge method per repo so the operator's preference
  // sticks. Falls back to squash on first render.
  useEffect(() => {
    if (!repoSlug || typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(`o8-merge-method:${repoSlug}`);
    if (stored === 'squash' || stored === 'merge' || stored === 'rebase') {
      setMergeMethod(stored);
    }
  }, [repoSlug]);

  const persistMergeMethod = useCallback((method: MergeMethod) => {
    setMergeMethod(method);
    if (repoSlug && typeof window !== 'undefined') {
      window.localStorage.setItem(`o8-merge-method:${repoSlug}`, method);
    }
  }, [repoSlug]);

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

  // Close the merge-method menu on outside click.
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (!menuAnchorRef.current) return;
      if (!menuAnchorRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const derived = derive(branchName, pr, repoSlug, mergeMethod);

  const openInBrowser = useCallback((url: string) => {
    if (typeof window !== 'undefined') {
      openExternalUrl(url);
    }
  }, []);

  const performMerge = useCallback(async (method: MergeMethod) => {
    if (!derived.pr || !repoSlug) return;
    setMenuOpen(false);
    setMerging(true);
    try {
      const res = await fetch(`/api/panel/prs/${derived.pr.number}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'merge', repo: repoSlug, mergeMethod: method }),
      });
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        setToast({ tone: 'fail', message: body?.error || 'Merge failed' });
        return;
      }
      setToast({ tone: 'success', message: `Merged #${derived.pr.number}` });
      setPr(null);
    } catch (error) {
      setToast({ tone: 'fail', message: error instanceof Error ? error.message : 'Merge failed' });
    } finally {
      setMerging(false);
    }
  }, [derived.pr, repoSlug]);

  const handlePrimary = useCallback(() => {
    if (derived.disabled) return;
    if (derived.variant === 'view' && derived.pr?.url) {
      openInBrowser(derived.pr.url);
      return;
    }
    if (derived.variant === 'merge') {
      void performMerge(mergeMethod);
    }
  }, [derived, mergeMethod, openInBrowser, performMerge]);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(handle);
  }, [toast]);

  const displayBranch = branchName ? formatBranchDisplayName(branchName) : null;
  if (!displayBranch) return null;
  // On the default branch with nothing open against it, there's nothing to say
  // — "main" is where you always are. Anything else (a PR branch, an agent's
  // worktree) is worth naming, and an open PR keeps its merge chrome even if
  // the branch somehow matches. (Q 2026-07-16 — same spirit as the 2026-07-11
  // ruling below: no state is the state.)
  if (isRestingOnDefaultBranch(branchName, defaultBranch, derived)) return null;

  const tone = TONE[derived.statusTone];
  const successTone = TONE.success;

  if (compact) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          height: 30,
          paddingTop: 2,
          paddingBottom: 4,
          paddingLeft: 8,
          paddingRight: 8,
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <span
          // Harmonized with the composer-below ChipShell vocabulary — see the
          // non-compact branch span below.
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            minWidth: 0,
            maxWidth: 'min(46vw, 240px)',
            overflow: 'hidden',
            color: 'var(--t-text-secondary)',
            fontSize: 12,
            fontWeight: 360,
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
          }}
          title={repoName ? `${repoName} · ${branchName}` : branchName ?? undefined}
        >
          <GitBranch size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: 'var(--t-text-faint)' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayBranch}</span>
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: 30,
        minWidth: 0,
        maxWidth: '100%',
        overflow: 'hidden',
        flexShrink: 1,
        paddingTop: 2,
        paddingBottom: 4,
        paddingLeft: 12,
        paddingRight: 12,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <span
        // Harmonized with the composer-below ChipShell vocabulary (size 12 /
        // weight 360 / text-secondary label / text-faint icon / -0.005em) so the
        // status row and the o8·Work-locally chip row read as one design system.
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          minWidth: 0,
          maxWidth: 180,
          overflow: 'hidden',
          fontSize: 12,
          fontWeight: 360,
          color: 'var(--t-text-secondary)',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
        }}
        title={repoName ? `${repoName} · ${branchName}` : branchName ?? undefined}
      >
        <GitBranch size={13} strokeWidth={1.8} style={{ flexShrink: 0, color: 'var(--t-text-faint)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayBranch}</span>
      </span>

      {derived.statusText ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: tone.text,
            letterSpacing: 0,
            whiteSpace: 'nowrap',
          }}
        >
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
            letterSpacing: 0,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-muted)'; }}
        >
          #{derived.pr.number}
          <ExternalLink size={9} strokeWidth={2} />
        </button>
      ) : null}

      {toast ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: toast.tone === 'success' ? successTone.text : TONE.fail.text,
            letterSpacing: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {toast.message}
        </span>
      ) : null}

      {derived.variant === 'view' || derived.variant === 'merge' ? (
        <div ref={menuAnchorRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={handlePrimary}
            disabled={derived.disabled || merging}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              height: 22,
              paddingTop: 0,
              paddingBottom: 0,
              paddingLeft: 10,
              paddingRight: derived.variant === 'merge' ? 9 : 10,
              borderTopLeftRadius: 6,
              borderBottomLeftRadius: 6,
              borderTopRightRadius: derived.variant === 'merge' ? 0 : 6,
              borderBottomRightRadius: derived.variant === 'merge' ? 0 : 6,
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderLeftWidth: 1,
              borderRightWidth: derived.variant === 'merge' ? 0 : 1,
              borderStyle: 'solid',
              borderColor: derived.variant === 'merge' ? successTone.border : 'var(--t-input-border, var(--t-divider))',
              background: derived.variant === 'merge' ? successTone.bg : 'var(--t-input-bg, transparent)',
              color: derived.variant === 'merge' ? successTone.text : 'var(--t-text)',
              cursor: derived.disabled || merging ? 'default' : 'pointer',
              opacity: derived.disabled || merging ? 0.6 : 1,
              fontSize: 11.5,
              fontWeight: 600,
              letterSpacing: 0,
              fontFamily: 'var(--font-sans-system)',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {merging ? (
              <Loader2 size={12} strokeWidth={2} style={{ animation: 'spin 0.9s linear infinite' }} />
            ) : derived.primaryIcon === 'check' ? (
              <BranchMergeIcon size={13} color={successTone.text} checkColor={successTone.contrast} />
            ) : derived.primaryIcon === 'external' ? (
              <ExternalLink size={12} strokeWidth={2} />
            ) : (
              <GitBranch size={12} strokeWidth={2} />
            )}
            <span>{derived.primaryLabel}</span>
          </button>

          {derived.variant === 'merge' ? (
            <button
              type="button"
              onClick={() => setMenuOpen((current) => !current)}
              disabled={merging}
              aria-label="Choose merge method"
              style={{
                position: 'relative',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                paddingTop: 0,
                paddingBottom: 0,
                paddingLeft: 0,
                paddingRight: 0,
                borderTopRightRadius: 6,
                borderBottomRightRadius: 6,
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopWidth: 1,
                borderBottomWidth: 1,
                borderRightWidth: 1,
                borderLeftWidth: 0,
                borderStyle: 'solid',
                borderColor: successTone.border,
                background: successTone.bg,
                color: successTone.text,
                cursor: merging ? 'default' : 'pointer',
                opacity: merging ? 0.6 : 1,
              }}
            >
              {/* Subtle vertical divider to mirror Superconductor's split pill. */}
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 4,
                  bottom: 4,
                  width: 1,
                  background: successTone.border,
                }}
              />
              <ChevronDown size={11} strokeWidth={2} />
            </button>
          ) : null}

          {menuOpen ? (
            <div
              role="menu"
              style={{
                position: 'absolute',
                bottom: 'calc(100% + 6px)',
                right: 0,
                minWidth: 240,
                background: 'var(--t-panel-solid)',
                border: '1px solid var(--t-panel-border)',
                borderRadius: 10,
                boxShadow: 'var(--t-panel-shadow)',
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 4,
                paddingRight: 4,
                zIndex: 60,
                fontFamily: 'var(--font-sans-system)',
                color: 'var(--t-text)',
              }}
            >
              {(['squash', 'merge', 'rebase'] as const).map((method) => {
                const meta = MERGE_METHOD_LABELS[method];
                const isActive = method === mergeMethod;
                return (
                  <button
                    key={method}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      persistMergeMethod(method);
                      void performMerge(method);
                    }}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      width: '100%',
                      paddingTop: 6,
                      paddingBottom: 6,
                      paddingLeft: 10,
                      paddingRight: 10,
                      borderRadius: 7,
                      border: 'none',
                      background: isActive ? 'var(--t-panel-hover)' : 'transparent',
                      color: 'var(--t-text)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-panel-hover)'; }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = isActive ? 'var(--t-panel-hover)' : 'transparent';
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0 }}>{meta.menuLabel}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--t-text-muted)', letterSpacing: 0, marginTop: 1 }}>{meta.description}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const MergeActionCluster = memo(MergeActionClusterBase);
