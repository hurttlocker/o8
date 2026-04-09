'use client';

/**
 * LedgerView -- Session outcomes ledger tab in the Memory view.
 *
 * Fetches from /api/cortex/ledger and renders scrollable cards.
 * Each card: repo + runtime + outcome badges, summary, bottom row metadata.
 */

import { useCallback, useEffect, useState } from 'react';
import { ListIcon, RefreshIcon } from '@/components/desktop/directives-icons';

const MONO_FONT = '"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

interface LedgerOutcome {
  id: string;
  repoPath: string;
  repoName: string;
  branch: string | null;
  runtime: string;
  outcome: 'succeeded' | 'failed' | 'partial' | 'interrupted';
  summary: string;
  attempts: number;
  durationMs: number | null;
  totalTokens: number;
  costUsd: number;
  model: string | null;
  reviewApproved: number | null;
  reviewFindingsCount: number;
  startedAt: string;
  completedAt: string;
}

interface LedgerResponse {
  outcomes: LedgerOutcome[];
  totals: { count: number; costUsd: number };
}

// Runtime + outcome palettes (hardcoded per design constants; no theme tokens).
const RUNTIME_COLOR: Record<string, { fg: string; bg: string; border: string }> = {
  codex: { fg: '#2563eb', bg: 'rgba(37, 99, 235, 0.12)', border: 'rgba(37, 99, 235, 0.32)' },
  'claude-code': { fg: '#8b5cf6', bg: 'rgba(139, 92, 246, 0.12)', border: 'rgba(139, 92, 246, 0.32)' },
};

const OUTCOME_COLOR: Record<LedgerOutcome['outcome'], { fg: string; bg: string; border: string }> = {
  succeeded: { fg: '#16a34a', bg: 'rgba(34, 197, 94, 0.12)', border: 'rgba(34, 197, 94, 0.34)' },
  failed: { fg: '#dc2626', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(239, 68, 68, 0.34)' },
  partial: { fg: '#d97706', bg: 'rgba(245, 158, 11, 0.14)', border: 'rgba(245, 158, 11, 0.34)' },
  interrupted: { fg: '#6b7280', bg: 'rgba(156, 163, 175, 0.16)', border: 'rgba(156, 163, 175, 0.34)' },
};

function runtimeStyle(runtime: string) {
  return RUNTIME_COLOR[runtime] || { fg: 'var(--t-text-muted)', bg: 'var(--t-bg-card)', border: 'var(--t-divider)' };
}

function outcomeStyle(outcome: string) {
  return OUTCOME_COLOR[(outcome as LedgerOutcome['outcome'])] || OUTCOME_COLOR.interrupted;
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${Math.max(0, sec)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function formatCost(usd: number): string {
  if (!usd || usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function LedgerView({ active }: { active: boolean }): React.ReactElement {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLedger = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/cortex/ledger');
      if (!res.ok) { setError('Failed to load ledger'); return; }
      const json = (await res.json()) as LedgerResponse;
      setData(json);
      setError(null);
    } catch (e) {
      console.error('[ledger-view] fetch error:', e);
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) { fetchLedger(); }
  }, [active, fetchLedger]);

  if (loading && !data) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--t-text-muted)', fontSize: 13,
      }}>
        Loading ledger...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--t-text-muted)', fontSize: 13,
      }}>
        {error}
      </div>
    );
  }

  const outcomes = data?.outcomes ?? [];

  if (outcomes.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        color: 'var(--t-text-muted)', fontSize: 13, gap: 8,
        paddingLeft: 24, paddingRight: 24, textAlign: 'center',
      }}>
        <ListIcon size={24} color="var(--t-text-faint)" />
        <span>No session outcomes yet.</span>
        <span style={{ fontSize: 12, color: 'var(--t-text-faint)' }}>
          Dispatch a task to populate the ledger.
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      {/* Totals strip */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 10, paddingBottom: 10, paddingLeft: 16, paddingRight: 16,
        borderBottom: '1px solid var(--t-divider-subtle)',
        fontSize: 11, color: 'var(--t-text-muted)',
        fontFamily: MONO_FONT, letterSpacing: '-0.01em',
      }}>
        <span>{data?.totals.count ?? 0} total · {formatCost(data?.totals.costUsd ?? 0)}</span>
        <button
          type="button"
          onClick={fetchLedger}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            paddingTop: 4, paddingBottom: 4, paddingLeft: 8, paddingRight: 8,
            borderRadius: 8,
            border: '1px solid var(--t-divider)',
            background: 'transparent',
            color: 'var(--t-text-muted)',
            fontSize: 11, fontFamily: 'system-ui, sans-serif',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.6 : 1,
            minHeight: 24,
          }}
        >
          <RefreshIcon size={10} color="currentColor" />
          Refresh
        </button>
      </div>

      {/* Cards */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12,
      }}>
        {outcomes.map((o) => <LedgerCard key={o.id} outcome={o} />)}
      </div>
    </div>
  );
}

function LedgerCard({ outcome }: { outcome: LedgerOutcome }) {
  const r = runtimeStyle(outcome.runtime);
  const oc = outcomeStyle(outcome.outcome);
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      paddingTop: 10, paddingBottom: 10, paddingLeft: 12, paddingRight: 12,
      borderRadius: 14,
      border: '1px solid var(--t-divider)',
      background: 'var(--t-bg-card)',
    }}>
      {/* Top row: repo + runtime + outcome */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        minWidth: 0,
      }}>
        <span style={{
          fontSize: 13, fontWeight: 600, color: 'var(--t-text)',
          letterSpacing: '-0.01em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          flex: 1, minWidth: 0,
        }}>
          {outcome.repoName}
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          paddingTop: 2, paddingBottom: 2, paddingLeft: 8, paddingRight: 8,
          borderRadius: 10,
          background: r.bg,
          border: `1px solid ${r.border}`,
          color: r.fg,
          fontSize: 10, fontWeight: 600,
          fontFamily: 'system-ui, sans-serif',
          letterSpacing: '-0.01em',
          textTransform: 'lowercase',
          flexShrink: 0,
        }}>
          {outcome.runtime}
        </span>
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          paddingTop: 2, paddingBottom: 2, paddingLeft: 8, paddingRight: 8,
          borderRadius: 10,
          background: oc.bg,
          border: `1px solid ${oc.border}`,
          color: oc.fg,
          fontSize: 10, fontWeight: 600,
          fontFamily: 'system-ui, sans-serif',
          letterSpacing: '-0.01em',
          textTransform: 'capitalize',
          flexShrink: 0,
        }}>
          {outcome.outcome}
        </span>
      </div>

      {/* Summary (2 lines max) */}
      <div style={{
        fontSize: 12, color: 'var(--t-text-secondary)',
        letterSpacing: '-0.01em', lineHeight: 1.45,
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        wordBreak: 'break-word',
      } as React.CSSProperties}>
        {outcome.summary || 'No summary'}
      </div>

      {/* Bottom row: model · cost · attempts · time */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--t-text-faint)',
        fontFamily: MONO_FONT, letterSpacing: '-0.01em',
        flexWrap: 'wrap',
      }}>
        <span style={{
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
        }}>
          {outcome.model || '—'}
        </span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{formatCost(outcome.costUsd)}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{outcome.attempts} attempt{outcome.attempts !== 1 ? 's' : ''}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>{formatRelativeTime(outcome.completedAt)}</span>
      </div>
    </div>
  );
}
