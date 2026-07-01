'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Targeting Machine — the "where to point your agents" surface (v1, milestone 3).
 *
 * A cheap, always-available triage: a ranked list of files, each with an impact
 * (blast radius) + opportunity (room to improve) score and a one-line rationale.
 * Free + instant + offline (deterministic heuristic over pre-computed skeleton
 * signals). The Dispatch button + tier chip + triage-model rationale land in
 * later steps; this milestone renders the ranked list for a real repo.
 *
 * Inline styles only (Critical Rule). Matches the packet-row density/tokens.
 */

interface TargetRow {
  path: string;
  impact: number;
  opportunity: number;
  score: number;
  rationale: string;
  signals: { loc: number; symbolCount: number; outboundImports: number; inbound: number; churn: number };
}

interface TargetsResponse {
  ok: boolean;
  count?: number;
  scoredAt?: string;
  targets?: TargetRow[];
  reason?: string;
  message?: string;
  error?: string;
}

function scoreColor(score: number): string {
  if (score >= 16) return 'var(--t-accent)';
  if (score >= 9) return 'var(--t-text)';
  return 'var(--t-text-muted)';
}

/** A tiny 1–5 pip bar for impact / opportunity. */
function PipBar({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }} title={`${label} ${value}/5`}>
      <span style={{ fontSize: 8.5, fontWeight: 300, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--t-text-muted)' }}>{label}</span>
      <div style={{ display: 'flex', gap: 1.5 }}>
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} style={{ width: 3, height: 9, borderRadius: 1, background: i <= value ? 'var(--t-text-secondary)' : 'var(--t-divider-subtle)' }} />
        ))}
      </div>
    </div>
  );
}

export function TargetsPanel({ repoPath, active }: { repoPath?: string | null; active?: boolean }) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [data, setData] = useState<TargetsResponse | null>(null);
  const loadedRepoRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!repoPath) return;
    setState('loading');
    try {
      const res = await fetch(`/api/panel/targets?repoPath=${encodeURIComponent(repoPath)}`);
      const json = (await res.json()) as TargetsResponse;
      setData(json);
      setState(json.ok ? 'ready' : 'error');
    } catch (err) {
      setData({ ok: false, error: err instanceof Error ? err.message : 'request failed' });
      setState('error');
    }
  }, [repoPath]);

  // Auto-load once when the tab becomes active for a repo (re-load on repo change).
  useEffect(() => {
    if (!active || !repoPath) return;
    if (loadedRepoRef.current === repoPath) return;
    loadedRepoRef.current = repoPath;
    void load();
  }, [active, repoPath, load]);

  const targets = data?.targets ?? [];
  const scoredAt = data?.scoredAt ? new Date(data.scoredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--t-bg)' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        paddingTop: 10, paddingRight: 14, paddingBottom: 10, paddingLeft: 14,
        borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider)',
      }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 400, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>Targeting</span>
          <span style={{ fontSize: 10.5, fontWeight: 300, letterSpacing: '-0.05px', color: 'var(--t-text-faint)' }}>
            {state === 'ready' && targets.length > 0
              ? `${targets.length} files ranked${scoredAt ? ` · ${scoredAt}` : ''} — point your agents here`
              : 'Where to point your agents'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={!repoPath || state === 'loading'}
          title="Re-run the triage"
          style={{
            fontSize: 11, fontWeight: 400, color: state === 'loading' ? 'var(--t-text-muted)' : 'var(--t-text)',
            background: 'var(--t-input-bg)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)',
            borderRadius: 7, paddingTop: 4, paddingBottom: 4, paddingLeft: 10, paddingRight: 10,
            cursor: repoPath && state !== 'loading' ? 'pointer' : 'default', flexShrink: 0,
          }}
        >
          {state === 'loading' ? 'Scanning…' : 'Re-scan'}
        </button>
      </div>

      {/* Body */}
      <div className="cortex-themed-scroll cortex-scroll-fade-y" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {!repoPath ? (
          <EmptyState title="No repo selected" detail="Select a repository to triage where your agents should aim." />
        ) : state === 'loading' && targets.length === 0 ? (
          <EmptyState title="Scanning…" detail="Ranking files by impact × opportunity from the cached signals." />
        ) : state === 'error' ? (
          <EmptyState title="Triage failed" detail={data?.error || 'Something went wrong scoring this repo.'} />
        ) : targets.length === 0 ? (
          <EmptyState
            title="No targets yet"
            detail={data?.message || 'No skeleton cache for this repo yet — open/scan it first, then re-run the triage.'}
          />
        ) : (
          targets.map((t, i) => (
            <div
              key={t.path}
              data-target-row
              style={{ borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)' }}
            >
              <div style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                paddingTop: 8, paddingRight: 14, paddingBottom: 8, paddingLeft: 12,
              }}>
                {/* Rank */}
                <span style={{
                  fontSize: 10.5, fontWeight: 500, color: 'var(--t-text-faint)', width: 20, flexShrink: 0,
                  paddingTop: 1, textAlign: 'right',
                }}>{i + 1}</span>

                {/* Path + rationale */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{
                    fontSize: 11.5, color: 'var(--t-text)', letterSpacing: '-0.005em',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  }} title={t.path}>{t.path}</span>
                  <span style={{
                    fontSize: 10.5, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)',
                  }}>{t.rationale}</span>
                </div>

                {/* Impact / opportunity / score */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 1 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end' }}>
                    <PipBar label="Imp" value={t.impact} />
                    <PipBar label="Opp" value={t.opportunity} />
                  </div>
                  <span style={{
                    fontSize: 15, fontWeight: 500, color: scoreColor(t.score), width: 22, textAlign: 'right',
                    letterSpacing: '-0.02em',
                  }} title={`impact ${t.impact} × opportunity ${t.opportunity}`}>{t.score}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 8, minHeight: 180, textAlign: 'center', paddingTop: 24, paddingBottom: 24, paddingLeft: 28, paddingRight: 28,
    }}>
      <div style={{ fontSize: 13, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{title}</div>
      <div style={{ maxWidth: 340, fontSize: 12, fontWeight: 300, lineHeight: 1.45, color: 'var(--t-text-faint)' }}>{detail}</div>
    </div>
  );
}
