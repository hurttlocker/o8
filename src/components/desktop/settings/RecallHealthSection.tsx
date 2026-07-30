'use client';

/**
 * #749 — Substrate eval gate. Read-only Diagnostics surface that surfaces
 * the substrate (SQLite + directives dir) row counts and recall query
 * latency, so we can answer "is SQLite still fine, or is it time to
 * evaluate a swap?" without guessing.
 *
 * The thresholds rendered here are the same ones written in
 * `docs/operations/substrate-eval-gate.md`. The endpoint at
 * `/api/cortex/diagnostics` returns both for parity.
 *
 * Issues-style rows: uppercase mono label on the left, value + helper on
 * the right, dot for status. No native form controls.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
} from './shared';
import { GroupHeader, GroupFootnote } from './grouped';

// ── Types ──

interface RecallTimingSummary {
  totalSamples: number;
  windowedSamples: number;
  windowMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  errorCount: number;
  byLabel: Array<{
    label: string;
    samples: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  }>;
}

interface DiagnosticsResponse {
  ok: true;
  outcomesCount: number;
  directivesCount: number;
  timing: RecallTimingSummary;
  timing7d: RecallTimingSummary;
  thresholds: { outcomesEval: number; p95Ms: number; sustainedDays: number };
  health: 'green' | 'amber' | 'red';
  notes: string[];
}

// ── Helpers ──

function formatMs(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

function formatCount(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0';
  return value.toLocaleString();
}

function dotColorForHealth(health: 'green' | 'amber' | 'red') {
  if (health === 'red') return '#ef4444';
  if (health === 'amber') return '#f59e0b';
  return RAMS_INK_QUIET;
}

// ── Component ──

export function RecallHealthSection() {
  const [data, setData] = useState<DiagnosticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/cortex/diagnostics');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as DiagnosticsResponse;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read diagnostics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <GroupHeader>Recall health</GroupHeader>

      <div style={{
        borderRadius: 14,
        border: '1px solid var(--t-panel-border)',
        background: 'var(--t-bg-card)',
        overflow: 'hidden',
        paddingLeft: 14,
        paddingRight: 14,
        paddingBottom: 4,
      }}>
        <Row
          label="Outcomes count"
          value={data ? formatCount(data.outcomesCount) : (loading ? '…' : '—')}
          hint={data ? `Eval at ${formatCount(data.thresholds.outcomesEval)}` : undefined}
          dot={data && data.outcomesCount >= data.thresholds.outcomesEval
            ? '#ef4444'
            : data && data.outcomesCount >= data.thresholds.outcomesEval * 0.5
              ? '#f59e0b'
              : RAMS_INK_QUIET}
        />
        <Row
          label="Directives count"
          value={data ? formatCount(data.directivesCount) : (loading ? '…' : '—')}
          hint="Markdown files in the directives/ dir"
          dot={RAMS_INK_QUIET}
        />
        <Row
          label="Recall p50 (24h)"
          value={data ? formatMs(data.timing.p50Ms) : (loading ? '…' : '—')}
          hint={data ? `${formatCount(data.timing.windowedSamples)} samples` : undefined}
          dot={RAMS_INK_QUIET}
        />
        <Row
          label="Recall p95 (24h)"
          value={data ? formatMs(data.timing.p95Ms) : (loading ? '…' : '—')}
          hint={data ? `Eval at ${data.thresholds.p95Ms}ms` : undefined}
          dot={data && data.timing.p95Ms >= data.thresholds.p95Ms
            ? '#ef4444'
            : data && data.timing.p95Ms >= data.thresholds.p95Ms * 0.75
              ? '#f59e0b'
              : RAMS_INK_QUIET}
        />
        <Row
          label="Recall p99 (24h)"
          value={data ? formatMs(data.timing.p99Ms) : (loading ? '…' : '—')}
          hint={data ? `max ${formatMs(data.timing.maxMs)}` : undefined}
          dot={RAMS_INK_QUIET}
        />
        <Row
          label="Recall p95 (7d)"
          value={data ? formatMs(data.timing7d.p95Ms) : (loading ? '…' : '—')}
          hint={data
            ? `Eval at ${data.thresholds.p95Ms}ms sustained ${data.thresholds.sustainedDays}d`
            : undefined}
          dot={data && data.timing7d.p95Ms >= data.thresholds.p95Ms
            ? '#ef4444'
            : data && data.timing7d.p95Ms >= data.thresholds.p95Ms * 0.75
              ? '#f59e0b'
              : RAMS_INK_QUIET}
        />
        <Row
          label="Substrate health"
          value={data ? data.health.toUpperCase() : (loading ? '…' : '—')}
          hint={data ? data.notes[0] : undefined}
          dot={data ? dotColorForHealth(data.health) : RAMS_INK_QUIET}
        />

        {data && data.timing.byLabel.length > 0 ? (
          <div style={{ marginTop: 14, paddingBottom: 10 }}>
            <ByLabelTable rows={data.timing.byLabel} />
          </div>
        ) : null}

        {error ? (
          <div style={{
            paddingTop: 12,
            paddingBottom: 12,
            fontSize: 13,
            color: 'var(--t-text)',
            lineHeight: 1.55,
          }}>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#ef4444',
              marginRight: 8,
            }}>
              [error]
            </span>
            {error}
          </div>
        ) : null}
      </div>

      <GroupFootnote>
        Read-only instrumentation. See{' '}
        <span style={{ fontFamily: MONO_FONT_STACK, fontSize: 11 }}>
          docs/operations/substrate-eval-gate.md
        </span>{' '}
        for the threshold definitions and decision procedure.
      </GroupFootnote>
    </div>
  );
}

// ── Row primitive — Issues-style ──

function Row({
  label,
  value,
  hint,
  dot,
}: {
  label: string;
  value: string;
  hint?: string;
  dot: string;
}) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
    }}>
      <span style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: dot,
        flexShrink: 0,
      }} />
      <span style={{
        fontFamily: APP_FONT_STACK,
        fontSize: 11,
        fontWeight: 400,
        color: RAMS_INK_QUIET,
        textTransform: 'uppercase',
        letterSpacing: '0.14em',
        minWidth: 180,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 13,
        fontWeight: 400,
        color: 'var(--t-text)',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: MONO_FONT_STACK,
        letterSpacing: '0.02em',
      }}>
        {value}
      </span>
      {hint ? (
        <span style={{
          fontFamily: APP_FONT_STACK,
          fontSize: 11,
          fontWeight: 400,
          letterSpacing: '0.04em',
          color: 'var(--t-text-secondary)',
          textAlign: 'right',
        }}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function ByLabelTable({
  rows,
}: {
  rows: Array<{ label: string; samples: number; p50Ms: number; p95Ms: number; p99Ms: number }>;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
        gap: 12,
        paddingTop: 6,
        paddingBottom: 6,
        borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
        fontFamily: APP_FONT_STACK,
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
      }}>
        <span>Call site</span>
        <span style={{ textAlign: 'right' }}>Samples</span>
        <span style={{ textAlign: 'right' }}>p50</span>
        <span style={{ textAlign: 'right' }}>p95</span>
        <span style={{ textAlign: 'right' }}>p99</span>
      </div>
      {rows.map((row) => (
        <div key={row.label} style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: 12,
          paddingTop: 8,
          paddingBottom: 8,
          borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
          fontFamily: MONO_FONT_STACK,
          fontSize: 11.5,
          letterSpacing: '0.02em',
          color: 'var(--t-text)',
        }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </span>
          <span style={{ textAlign: 'right' }}>{row.samples.toLocaleString()}</span>
          <span style={{ textAlign: 'right' }}>{formatMs(row.p50Ms)}</span>
          <span style={{ textAlign: 'right' }}>{formatMs(row.p95Ms)}</span>
          <span style={{ textAlign: 'right' }}>{formatMs(row.p99Ms)}</span>
        </div>
      ))}
    </div>
  );
}
