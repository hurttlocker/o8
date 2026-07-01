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
  tier?: 'triage' | 'action';
  signals: { loc: number; symbolCount: number; outboundImports: number; inbound: number; churn: number };
}

type DispatchState = { status: 'busy' } | { status: 'done'; runtime: string; tier: string } | { status: 'error'; error: string };

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
  const [dispatched, setDispatched] = useState<Record<string, DispatchState>>({});
  const loadedRepoRef = useRef<string | null>(null);

  const dispatch = useCallback(async (path: string) => {
    if (!repoPath) return;
    setDispatched((prev) => ({ ...prev, [path]: { status: 'busy' } }));
    try {
      const res = await fetch('/api/panel/targets/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, path }),
      });
      const json = await res.json();
      setDispatched((prev) => ({
        ...prev,
        [path]: json.ok
          ? { status: 'done', runtime: json.runtime ?? 'agent', tier: json.tier ?? '' }
          : { status: 'error', error: json.error ?? 'dispatch failed' },
      }));
    } catch (err) {
      setDispatched((prev) => ({ ...prev, [path]: { status: 'error', error: err instanceof Error ? err.message : 'failed' } }));
    }
  }, [repoPath]);

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
      {/* Header. Right padding reserves room for the floating Ask-o8 icon that
          O8Panel renders over the top-right of non-excluded tabs (position
          absolute, right:12, 26px button → occupies the rightmost 38px; +6 gap
          = 44). Without this the Re-scan button sits under the sparkle (#1309). */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        paddingTop: 10, paddingRight: 44, paddingBottom: 10, paddingLeft: 14,
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

                {/* Path + tier chip + rationale */}
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                    <span style={{
                      fontSize: 11.5, color: 'var(--t-text)', letterSpacing: '-0.005em',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    }} title={t.path}>{t.path}</span>
                    {t.tier ? <TierChip tier={t.tier} /> : null}
                  </div>
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

                {/* Dispatch */}
                <DispatchAction state={dispatched[t.path]} onDispatch={() => void dispatch(t.path)} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TierChip({ tier }: { tier: 'triage' | 'action' }) {
  const action = tier === 'action';
  return (
    <span
      title={action ? 'Premium action tier — a real agent at high effort' : 'Cheap triage tier — small, bounded work'}
      style={{
        flexShrink: 0, fontSize: 8.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
        paddingTop: 1, paddingBottom: 1, paddingLeft: 5, paddingRight: 5, borderRadius: 5,
        color: action ? 'var(--t-accent)' : 'var(--t-text-muted)',
        background: action ? 'var(--t-accent-soft)' : 'transparent',
        borderWidth: 1, borderStyle: 'solid', borderColor: action ? 'var(--t-accent-border, transparent)' : 'var(--t-divider-subtle)',
      }}
    >{tier}</span>
  );
}

function DispatchAction({ state, onDispatch }: { state?: DispatchState; onDispatch: () => void }) {
  if (state?.status === 'done') {
    return <span style={{ flexShrink: 0, fontSize: 9.5, fontWeight: 400, color: 'var(--t-accent)', width: 66, textAlign: 'right' }} title={`Dispatched to ${state.runtime} (${state.tier})`}>→ {state.runtime}</span>;
  }
  if (state?.status === 'error') {
    return <span style={{ flexShrink: 0, fontSize: 9.5, color: 'var(--t-text-faint)', width: 66, textAlign: 'right' }} title={state.error}>failed</span>;
  }
  return (
    <button
      type="button"
      onClick={onDispatch}
      disabled={state?.status === 'busy'}
      title="Point an agent at this file (routes to the tier's runtime/model)"
      style={{
        flexShrink: 0, width: 66, fontSize: 10, fontWeight: 400,
        color: state?.status === 'busy' ? 'var(--t-text-muted)' : 'var(--t-text)',
        background: 'var(--t-input-bg)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider-subtle)',
        borderRadius: 6, paddingTop: 3, paddingBottom: 3, cursor: state?.status === 'busy' ? 'default' : 'pointer',
      }}
    >{state?.status === 'busy' ? 'Sending…' : 'Dispatch'}</button>
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
