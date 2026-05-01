'use client';

/**
 * Brain quality regression dashboard (#969)
 *
 * Reads qa_eval_runs from /api/panel/qa-evals and renders:
 *   - Per-category sparklines for factual_accuracy + citation_correctness
 *   - Regression highlights (drop > 10pp from rolling avg of prior runs)
 *   - CSV export via a blob <a download>
 *
 * Sparkline + CategoryCard are in ./CategoryCard.tsx to stay under the
 * 800-line ceiling.
 */

import { useEffect, useRef, useState } from 'react';
import { CategoryCard, type CategoryStats } from './CategoryCard';

// ── Constants ──────────────────────────────────────────────────────

const CATEGORIES = ['ownership', 'decisions', 'processes', 'incidents', 'specs', 'cross-repo'] as const;
type Category = typeof CATEGORIES[number];

const REGRESSION_THRESHOLD = 0.10; // 10 percentage points
const ROLLING_WINDOW = 5; // runs to average for regression baseline

// ── Types ──────────────────────────────────────────────────────────

interface EvalRow {
  id: string;
  question_id: string;
  category: string | null;
  factual_accuracy: number | null;
  citation_correctness: number | null;
  hallucination_count: number | null;
  run_at: number;
}

// ── Helpers ────────────────────────────────────────────────────────

function mean(vals: number[]): number {
  if (vals.length === 0) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function detectRegression(sortedAscByTime: number[]): boolean {
  if (sortedAscByTime.length < 2) return false;
  const latest = sortedAscByTime[sortedAscByTime.length - 1];
  const priorWindow = sortedAscByTime.slice(
    Math.max(0, sortedAscByTime.length - 1 - ROLLING_WINDOW),
    sortedAscByTime.length - 1,
  );
  if (priorWindow.length === 0) return false;
  return mean(priorWindow) - latest > REGRESSION_THRESHOLD;
}

function groupByCategory(rows: EvalRow[]): CategoryStats[] {
  return CATEGORIES.map((cat): CategoryStats => {
    const catRows = rows
      .filter((r) => r.category === cat)
      .sort((a, b) => a.run_at - b.run_at);

    const factualVals = catRows.map((r) => r.factual_accuracy).filter((v): v is number => v !== null);
    const citationVals = catRows.map((r) => r.citation_correctness).filter((v): v is number => v !== null);

    return {
      category: cat,
      runs: catRows,
      avgFactual: mean(factualVals),
      avgCitation: mean(citationVals),
      factualRegressed: detectRegression(factualVals),
      citationRegressed: detectRegression(citationVals),
      lastRunAt: catRows.length > 0 ? catRows[catRows.length - 1].run_at : null,
    };
  });
}

function buildCsvUrl(rows: EvalRow[]): string {
  const header = 'id,question_id,category,factual_accuracy,citation_correctness,hallucination_count,run_at_iso\r\n';
  const lines = rows.map((r) => {
    const cells = [
      csvEsc(r.id),
      csvEsc(r.question_id),
      csvEsc(r.category ?? ''),
      r.factual_accuracy !== null ? r.factual_accuracy.toFixed(4) : '',
      r.citation_correctness !== null ? r.citation_correctness.toFixed(4) : '',
      r.hallucination_count !== null ? String(r.hallucination_count) : '',
      csvEsc(new Date(r.run_at).toISOString()),
    ];
    return cells.join(',');
  });
  return URL.createObjectURL(new Blob([header + lines.join('\r\n')], { type: 'text/csv' }));
}

function csvEsc(val: string): string {
  if (/[",\r\n]/.test(val)) return `"${val.replace(/"/g, '""')}"`;
  return val;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ── Page ──────────────────────────────────────────────────────────

export default function QaEvalsPage() {
  const [rows, setRows] = useState<EvalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const csvUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/panel/qa-evals?limit=2000');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { runs: EvalRow[]; error?: string };
        if (cancelled) return;
        if (json.error && json.runs.length === 0) setError(json.error);
        setRows(json.runs);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (csvUrlRef.current) {
      URL.revokeObjectURL(csvUrlRef.current);
      csvUrlRef.current = null;
    }
    if (rows.length > 0) csvUrlRef.current = buildCsvUrl(rows);
  }, [rows]);

  const stats = groupByCategory(rows);
  const regressions = stats.filter((s) => s.factualRegressed || s.citationRegressed);
  const totalRuns = rows.length;
  const overallFactual = mean(rows.map((r) => r.factual_accuracy).filter((v): v is number => v !== null));
  const overallCitation = mean(rows.map((r) => r.citation_correctness).filter((v): v is number => v !== null));

  const summaryItems: Array<{ label: string; value: string; warn?: boolean }> = [
    { label: 'Avg factual accuracy', value: fmtPct(overallFactual), warn: overallFactual < 0.7 },
    { label: 'Avg citation correctness', value: fmtPct(overallCitation), warn: overallCitation < 0.7 },
    { label: 'Categories tracked', value: String(CATEGORIES.length) },
    { label: 'Regressions', value: String(regressions.length), warn: regressions.length > 0 },
  ];

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: 'var(--t-bg, #f5f7fb)',
      paddingTop: 32,
      paddingRight: 32,
      paddingBottom: 32,
      paddingLeft: 32,
      fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
    }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 32 }}>
        <div>
          <div style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--t-text-muted, #5b6475)',
            marginBottom: 6,
          }}>
            Brain quality
          </div>
          <h1 style={{
            fontSize: 24,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: 'var(--t-text, #111827)',
            margin: 0,
          }}>
            QA Eval Regression Dashboard
          </h1>
          {!loading && !error && (
            <div style={{ fontSize: 13, color: 'var(--t-text-muted, #5b6475)', marginTop: 6 }}>
              {totalRuns} run{totalRuns !== 1 ? 's' : ''} recorded
              {regressions.length > 0 && (
                <span style={{ color: '#ef4444', marginLeft: 12 }}>
                  {regressions.length} categor{regressions.length === 1 ? 'y' : 'ies'} regressed
                </span>
              )}
            </div>
          )}
        </div>

        {/* CSV export */}
        {csvUrlRef.current && (
          <a
            href={csvUrlRef.current}
            download="qa-eval-runs.csv"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 8,
              paddingRight: 14,
              paddingBottom: 8,
              paddingLeft: 14,
              borderRadius: 8,
              backgroundColor: 'var(--t-bg-card, rgba(255,255,255,0.82))',
              border: '1px solid var(--t-border, rgba(15,23,42,0.1))',
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--t-text, #111827)',
              textDecoration: 'none',
              cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 2v8m0 0L5 7m3 3 3-3M2 12h12" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Export CSV
          </a>
        )}
      </div>

      {/* Summary bar */}
      {!loading && !error && totalRuns > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
          {summaryItems.map((item) => (
            <div
              key={item.label}
              style={{
                backgroundColor: 'var(--t-bg-card, rgba(255,255,255,0.82))',
                borderRadius: 12,
                paddingTop: 14,
                paddingRight: 20,
                paddingBottom: 14,
                paddingLeft: 20,
                minWidth: 140,
                outline: item.warn ? '1.5px solid #ef4444' : '1px solid var(--t-divider-subtle, rgba(15,23,42,0.05))',
              }}
            >
              <div style={{
                fontSize: 10,
                color: 'var(--t-text-muted, #9ca3af)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: 4,
              }}>
                {item.label}
              </div>
              <div style={{
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: item.warn ? '#ef4444' : 'var(--t-text, #111827)',
              }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{ color: 'var(--t-text-muted, #9ca3af)', fontSize: 14, marginTop: 40, textAlign: 'center' }}>
          Loading eval runs...
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div style={{
          backgroundColor: 'rgba(239,68,68,0.08)',
          borderRadius: 10,
          paddingTop: 16,
          paddingRight: 20,
          paddingBottom: 16,
          paddingLeft: 20,
          color: '#ef4444',
          fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && totalRuns === 0 && (
        <div style={{ textAlign: 'center', paddingTop: 64, color: 'var(--t-text-muted, #9ca3af)', fontSize: 14 }}>
          No eval runs recorded yet. Run the QA eval harness to populate this dashboard.
        </div>
      )}

      {/* Category grid */}
      {!loading && totalRuns > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 16,
        }}>
          {stats.map((stat) => <CategoryCard key={stat.category} stat={stat} />)}
        </div>
      )}

      {/* Regression detail */}
      {!loading && regressions.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={{
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginBottom: 12,
          }}>
            Regression detail
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {regressions.map((stat) => {
              const factualVals = stat.runs.map((r) => r.factual_accuracy).filter((v): v is number => v !== null);
              const citationVals = stat.runs.map((r) => r.citation_correctness).filter((v): v is number => v !== null);
              const priorF = factualVals.slice(Math.max(0, factualVals.length - 1 - ROLLING_WINDOW), factualVals.length - 1);
              const priorC = citationVals.slice(Math.max(0, citationVals.length - 1 - ROLLING_WINDOW), citationVals.length - 1);
              const latestF = factualVals[factualVals.length - 1];
              const latestC = citationVals[citationVals.length - 1];
              return (
                <div
                  key={stat.category}
                  style={{
                    backgroundColor: 'rgba(239,68,68,0.06)',
                    borderRadius: 10,
                    paddingTop: 12,
                    paddingRight: 16,
                    paddingBottom: 12,
                    paddingLeft: 16,
                    fontSize: 13,
                    color: 'var(--t-text, #111827)',
                    display: 'flex',
                    gap: 24,
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontWeight: 600, minWidth: 80 }}>{stat.category}</span>
                  {stat.factualRegressed && priorF.length > 0 && latestF !== undefined && (
                    <span>
                      factual: {fmtPct(mean(priorF))} baseline &#8594; {fmtPct(latestF)} latest
                      ({fmtPct(mean(priorF) - latestF)} drop)
                    </span>
                  )}
                  {stat.citationRegressed && priorC.length > 0 && latestC !== undefined && (
                    <span>
                      citation: {fmtPct(mean(priorC))} baseline &#8594; {fmtPct(latestC)} latest
                      ({fmtPct(mean(priorC) - latestC)} drop)
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
