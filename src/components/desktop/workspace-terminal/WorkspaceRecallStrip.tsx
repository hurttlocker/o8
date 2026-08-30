'use client';

/**
 * #966 — WorkspaceRecallStrip
 *
 * Ambient surface that pushes the most-relevant directives at the operator
 * when they open (or switch to) a workspace. Renders top-3 directive pills
 * in a slim horizontal bar just below the orchestrator toolbar.
 *
 * Data source: GET /api/cortex/directives?repoPath=<path>
 * Refresh triggers:
 *   - repoPath prop change (branch switch, workspace switch)
 *   - o8:cortex-changes window event (same debounce used by ContextRecallCard)
 *
 * Failure policy: errors render nothing — the strip never blocks the
 * orchestrator and never surfaces a toast.
 */

import { useEffect, useRef, useState } from 'react';

const FONT_FAMILY = 'var(--font-sans-system)';

interface DirectiveStub {
  id: string;
  title: string;
  scope: string;
}

interface WorkspaceRecallStripProps {
  repoPath: string | null;
}

function BrainIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.46 2.5 2.5 0 0 1-1.98-3 2.5 2.5 0 0 1-1.32-4.24 3 3 0 0 1 .34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.1-2.48Z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.46 2.5 2.5 0 0 0 1.98-3 2.5 2.5 0 0 0 1.32-4.24 3 3 0 0 0-.34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.1-2.48Z" />
    </svg>
  );
}

function DirectivePill({ directive }: { directive: DirectiveStub }) {
  const isGlobal = directive.scope === 'global';
  return (
    <div
      title={directive.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        paddingLeft: 8,
        paddingRight: 8,
        paddingTop: 0,
        paddingBottom: 0,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: isGlobal ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: isGlobal ? 'var(--t-accent-soft)' : 'var(--t-bg-card)',
        flexShrink: 0,
        maxWidth: 220,
        cursor: 'default',
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: isGlobal ? 'var(--t-accent)' : 'var(--t-text-secondary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.005em',
          fontFamily: FONT_FAMILY,
        }}
      >
        {directive.title}
      </span>
      <span
        style={{
          fontSize: 8,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: isGlobal ? 'var(--t-accent)' : 'var(--t-text-faint)',
          flexShrink: 0,
          opacity: 0.75,
        }}
      >
        {directive.scope}
      </span>
    </div>
  );
}

export function WorkspaceRecallStrip({ repoPath }: WorkspaceRecallStripProps) {
  const [refreshTick, setRefreshTick] = useState(0);
  const requestKey = repoPath ? `${repoPath}:${refreshTick}` : null;
  const [result, setResult] = useState<{ key: string; directives: DirectiveStub[] } | null>(null);
  const directives = requestKey && result?.key === requestKey ? result.directives : null;

  // Fetch top-3 directives scoped to the active repo path
  useEffect(() => {
    if (!repoPath || !requestKey) return;
    let cancelled = false;
    void (async () => {
      try {
        const url = `/api/cortex/directives?repoPath=${encodeURIComponent(repoPath)}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (cancelled) return;
        if (!response.ok) {
          setResult({ key: requestKey, directives: [] });
          return;
        }
        const payload = (await response.json()) as {
          directives?: { id: string; title: string; scope: string }[];
        };
        if (cancelled) return;
        setResult({ key: requestKey, directives: (payload.directives ?? []).slice(0, 3) });
      } catch {
        if (!cancelled) setResult({ key: requestKey, directives: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repoPath, requestKey]);

  // Debounced refresh on cortex-changes window event (directive writes after merges)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setRefreshTick((t) => t + 1);
      }, 250);
    };
    window.addEventListener('o8:cortex-changes', handler);
    return () => {
      window.removeEventListener('o8:cortex-changes', handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Hide when no repo or no directives loaded yet or empty list
  if (!repoPath || !directives || directives.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        paddingTop: 5,
        paddingRight: 12,
        paddingBottom: 5,
        paddingLeft: 12,
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'var(--t-divider-subtle)',
        background: 'transparent',
        flexShrink: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        msOverflowStyle: 'none',
        scrollbarWidth: 'none',
      } as React.CSSProperties}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 9,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: 'var(--t-text-faint)',
          flexShrink: 0,
          fontFamily: FONT_FAMILY,
        }}
      >
        <BrainIcon size={10} />
        <span>Context</span>
      </span>
      <div
        style={{
          width: 1,
          height: 12,
          background: 'var(--t-divider-subtle)',
          flexShrink: 0,
        }}
      />
      {directives.map((d) => (
        <DirectivePill key={d.id} directive={d} />
      ))}
    </div>
  );
}
