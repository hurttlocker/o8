'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, GitBranch, Loader2 } from './lucide-shims';
import { formatBranchDisplayName } from './repo-registry/shared';

// Branch-with-check glyph that matches Superconductor's pill icon: two
// branch nodes joined by an arc, with a check mark inside the lower node.
// Renders crisply at 14px in both light and dark themes.
function BranchMergeIcon({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="4" cy="3" r="1.4" />
      <circle cx="11.5" cy="11.5" r="2.4" fill={color} stroke={color} />
      <path d="M4 4.4 V8.5 A2.6 2.6 0 0 0 6.6 11.1 H8.6" />
      <path d="M10.4 11.5 L11.3 12.4 L13 10.6" stroke="var(--t-bg-card, #ffffff)" strokeWidth={1.4} fill="none" />
    </svg>
  );
}

interface MergeActionClusterProps {
  branchName: string | null;
  repoName: string | null;
  /** GitHub remote URL for the active repo. Used to resolve the slug for
   *  /api/panel/prs and /api/panel/prs/[number] calls. */
  repoRemoteUrl: string | null;
  /** Dev preview override — when set to a non-'auto' value the cluster
   *  short-circuits the derived state and renders the named preset
   *  visual. Lets the operator fine-tune the pill in dev without
   *  needing to land on a real feature branch with a real PR. */
  previewVariant?: MergePreviewVariant;
}

export type MergePreviewVariant =
  | 'auto'
  | 'idle'
  | 'open'
  | 'view-pending'
  | 'view-fail'
  | 'merge-ready';

const PREVIEW_DERIVED: Record<Exclude<MergePreviewVariant, 'auto'>, Derived> = {
  idle: { variant: 'idle', statusText: null, statusTone: 'muted', pr: null, primaryLabel: '', primaryIcon: 'branch', disabled: true },
  open: { variant: 'open', statusText: 'No open PR', statusTone: 'muted', pr: null, primaryLabel: 'Open PR', primaryIcon: 'external', disabled: false },
  'view-pending': {
    variant: 'view',
    statusText: 'Checks running',
    statusTone: 'pending',
    pr: { number: 1234, title: 'preview', headRefName: 'preview', baseRefName: 'main', isDraft: false, mergeable: 'UNKNOWN', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: 'PENDING' },
    primaryLabel: 'View PR',
    primaryIcon: 'external',
    disabled: false,
  },
  'view-fail': {
    variant: 'view',
    statusText: 'Conflicts',
    statusTone: 'fail',
    pr: { number: 1234, title: 'preview', headRefName: 'preview', baseRefName: 'main', isDraft: false, mergeable: 'DIRTY', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: 'FAILURE' },
    primaryLabel: 'View PR',
    primaryIcon: 'external',
    disabled: false,
  },
  'merge-ready': {
    variant: 'merge',
    statusText: 'Ready to merge',
    statusTone: 'success',
    pr: { number: 1234, title: 'preview', headRefName: 'preview', baseRefName: 'main', isDraft: false, mergeable: 'CLEAN', reviewDecision: 'APPROVED', statusCheckRollup: 'SUCCESS' },
    primaryLabel: 'Squash & merge',
    primaryIcon: 'check',
    disabled: false,
  },
};

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

// Desaturated tones — sage/amber/rose instead of neon. The status bar reads
// as ambient information, not a UI alarm. Pill backgrounds use the matching
// hue at low opacity over the chrome glass.
const TONE = {
  success: { text: '#7fa68f', bg: 'rgba(127, 166, 143, 0.14)', border: 'rgba(127, 166, 143, 0.28)' },
  pending: { text: '#a39565', bg: 'rgba(163, 149, 101, 0.14)', border: 'rgba(163, 149, 101, 0.28)' },
  fail:    { text: '#a37b7b', bg: 'rgba(163, 123, 123, 0.14)', border: 'rgba(163, 123, 123, 0.28)' },
  muted:   { text: 'var(--t-text-muted)', bg: 'transparent', border: 'transparent' },
} as const;

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

  if (isProtectedBranch(branch)) {
    return { variant: 'idle', statusText: null, statusTone: 'muted', pr: null, primaryLabel: '', primaryIcon: 'branch', disabled: true };
  }

  return { variant: 'open', statusText: 'No open PR', statusTone: 'muted', pr: null, primaryLabel: 'Open PR', primaryIcon: 'external', disabled: false };
}

function MergeActionClusterBase({ branchName, repoName, repoRemoteUrl, previewVariant = 'auto' }: MergeActionClusterProps) {
  const repoSlug = repoSlugFromRemote(repoRemoteUrl);
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

  const derived = previewVariant !== 'auto'
    ? PREVIEW_DERIVED[previewVariant]
    : derive(branchName, pr, repoSlug, mergeMethod);

  const openInBrowser = useCallback((url: string) => {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
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
    if (derived.variant === 'open' && repoSlug && branchName) {
      const compareUrl = `https://github.com/${repoSlug}/pull/new/${encodeURIComponent(branchName)}`;
      openInBrowser(compareUrl);
      return;
    }
    if (derived.variant === 'merge') {
      void performMerge(mergeMethod);
    }
  }, [branchName, derived, mergeMethod, openInBrowser, performMerge, repoSlug]);

  useEffect(() => {
    if (!toast) return;
    const handle = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(handle);
  }, [toast]);

  const displayBranch = branchName ? formatBranchDisplayName(branchName) : null;
  if (!displayBranch) return null;

  const tone = TONE[derived.statusTone];
  const successTone = TONE.success;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        height: 30,
        flexShrink: 0,
        paddingTop: 2,
        paddingBottom: 4,
        paddingLeft: 12,
        paddingRight: 12,
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11,
          fontWeight: 440,
          color: 'var(--t-text-muted)',
          letterSpacing: '-0.005em',
          whiteSpace: 'nowrap',
        }}
        title={repoName ? `${repoName} · ${branchName}` : branchName ?? undefined}
      >
        <GitBranch size={11} strokeWidth={1.8} />
        {displayBranch}
      </span>

      {derived.statusText ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: tone.text,
            letterSpacing: '-0.005em',
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

      {toast ? (
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: toast.tone === 'success' ? successTone.text : TONE.fail.text,
            letterSpacing: '-0.005em',
          }}
        >
          {toast.message}
        </span>
      ) : null}

      {derived.variant !== 'idle' ? (
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
              letterSpacing: '-0.005em',
              fontFamily: 'var(--font-sans-system)',
              transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {merging ? (
              <Loader2 size={12} strokeWidth={2} style={{ animation: 'spin 0.9s linear infinite' }} />
            ) : derived.primaryIcon === 'check' ? (
              <BranchMergeIcon size={13} color={successTone.text} />
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
                // Overlay chrome — always dark + light text regardless of theme.
                background: 'rgba(20, 24, 30, 0.96)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: 10,
                boxShadow: '0 18px 44px rgba(0, 0, 0, 0.32)',
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 4,
                paddingRight: 4,
                zIndex: 60,
                fontFamily: 'var(--font-sans-system)',
                color: 'rgba(255, 255, 255, 0.94)',
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
                      background: isActive ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
                      color: 'rgba(255, 255, 255, 0.94)',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                    }}
                    onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255, 255, 255, 0.08)'; }}
                    onMouseLeave={(event) => {
                      event.currentTarget.style.background = isActive ? 'rgba(255, 255, 255, 0.08)' : 'transparent';
                    }}
                  >
                    <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '-0.005em' }}>{meta.menuLabel}</span>
                    <span style={{ fontSize: 10.5, color: 'rgba(226, 232, 240, 0.62)', letterSpacing: '-0.005em', marginTop: 1 }}>{meta.description}</span>
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
