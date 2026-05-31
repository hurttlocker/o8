'use client';

/**
 * AnalyticsMoatSections — the governance + autonomy surfaces that ride ON TOP
 * of the cost dashboard (cost stays king). Autonomy reads session_outcomes,
 * Governance reads approvals; both come windowed from /api/panel/analytics.
 * Null data → honest empty state, never mocks. Lives as a sibling so the
 * 948-line AnalyticsPage doesn't grow further.
 */

import { memo } from 'react';
import {
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  RAMS_HAIRLINE_SOFT,
  MONO_FONT_STACK,
  SectionLabel,
  HairlineRule,
} from '@/components/desktop/settings/shared';

export interface AutonomyMetrics {
  total: number;
  succeeded: number;
  partial: number;
  failed: number;
  mergedClean: number;
  successRate: number;
  mergedCleanRate: number;
}

export interface GovernanceMetrics {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
  approvalRate: number;
  avgLatencyMs: number;
}

function formatLatency(ms: number): string {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

const Cell = memo(function Cell({ label, value, sub, accent = false }: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div style={{
      flex: 1,
      minWidth: 130,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      paddingTop: 16,
      paddingBottom: 16,
      paddingLeft: 0,
      paddingRight: 24,
    }}>
      <div style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 22,
        fontWeight: 300,
        color: accent ? RAMS_ACCENT : 'var(--t-text)',
        letterSpacing: '-0.03em',
        lineHeight: 1.1,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      <div style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
      }}>
        {label}
      </div>
      {sub ? (
        <div style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          color: RAMS_INK_QUIET,
          letterSpacing: '0.04em',
          marginTop: 2,
        }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
});

function EmptyNote({ text }: { text: string }) {
  return (
    <div style={{
      fontFamily: MONO_FONT_STACK,
      fontSize: 11,
      color: RAMS_INK_QUIET,
      letterSpacing: '0.04em',
      paddingTop: 14,
      paddingBottom: 14,
    }}>
      {text}
    </div>
  );
}

const cellRowStyle = {
  display: 'flex',
  gap: 0,
  flexWrap: 'wrap' as const,
  borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
  marginBottom: 0,
};

export const AnalyticsMoatSections = memo(function AnalyticsMoatSections({
  autonomy,
  governance,
}: {
  autonomy: AutonomyMetrics | null;
  governance: GovernanceMetrics | null;
}) {
  return (
    <>
      {/* ── AUTONOMY — how much shipped without a human in the loop ── */}
      <section style={{ marginBottom: 36 }}>
        <SectionLabel number="01">AUTONOMY</SectionLabel>
        {autonomy && autonomy.total > 0 ? (
          <div style={cellRowStyle}>
            <Cell
              label="merged clean"
              value={`${autonomy.mergedCleanRate.toFixed(0)}%`}
              sub={`${autonomy.mergedClean} of ${autonomy.total} shipped untouched`}
              accent
            />
            <Cell
              label="success rate"
              value={`${autonomy.successRate.toFixed(0)}%`}
              sub={`${autonomy.succeeded} succeeded`}
            />
            <Cell
              label="needed a human"
              value={(autonomy.partial + autonomy.failed).toString()}
              sub={`${autonomy.partial} partial · ${autonomy.failed} failed`}
            />
            <Cell
              label="outcomes"
              value={autonomy.total.toLocaleString()}
              sub="in window"
            />
          </div>
        ) : (
          <EmptyNote text="No completed packets in this window." />
        )}
        <HairlineRule />
      </section>

      {/* ── GOVERNANCE — the operator approval surface as a measurable funnel ── */}
      <section style={{ marginBottom: 36 }}>
        <SectionLabel number="02">GOVERNANCE</SectionLabel>
        {governance && governance.total > 0 ? (
          <div style={cellRowStyle}>
            <Cell
              label="approval rate"
              value={`${governance.approvalRate.toFixed(0)}%`}
              sub={`${governance.approved} approved`}
              accent
            />
            <Cell
              label="pending"
              value={governance.pending.toString()}
              sub="awaiting review"
            />
            <Cell
              label="rejected"
              value={governance.rejected.toString()}
              sub={`${governance.total} total`}
            />
            <Cell
              label="review latency"
              value={formatLatency(governance.avgLatencyMs)}
              sub="avg time to resolve"
            />
          </div>
        ) : (
          <EmptyNote text="No approvals in this window." />
        )}
        <HairlineRule />
      </section>
    </>
  );
});
