'use client';

/**
 * CategoryCard + Sparkline sub-components for the QA eval regression dashboard (#969).
 */

export const SPARKLINE_W = 140;
export const SPARKLINE_H = 36;

// ── Sparkline ─────────────────────────────────────────────────────

interface SparklineProps {
  values: number[];
  color: string;
  regressed: boolean;
}

/** Normalise values into SVG y-coordinates. */
function toPoints(vals: number[]): string {
  if (vals.length === 0) return '';
  const padX = 4;
  const padY = 4;
  const w = SPARKLINE_W - padX * 2;
  const h = SPARKLINE_H - padY * 2;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals
    .map((v, i) => {
      const x = padX + (vals.length === 1 ? w / 2 : (i / (vals.length - 1)) * w);
      const y = padY + h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function Sparkline({ values, color, regressed }: SparklineProps) {
  const pts = toPoints(values);
  const lineColor = regressed ? '#ef4444' : color;
  const lastPtStr = pts ? pts.split(' ').pop() : null;
  const lastCoords = lastPtStr ? lastPtStr.split(',').map(Number) : null;

  return (
    <svg
      width={SPARKLINE_W}
      height={SPARKLINE_H}
      style={{ display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      {pts && (
        <polyline
          points={pts}
          fill="none"
          stroke={lineColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={0.9}
        />
      )}
      {lastCoords && (
        <circle cx={lastCoords[0]} cy={lastCoords[1]} r={2.5} fill={lineColor} />
      )}
      {values.length === 0 && (
        <text
          x={SPARKLINE_W / 2}
          y={SPARKLINE_H / 2 + 4}
          textAnchor="middle"
          style={{ fontSize: 10, fill: 'var(--t-text-muted, #9ca3af)' }}
        >
          no data
        </text>
      )}
    </svg>
  );
}

// ── CategoryCard ──────────────────────────────────────────────────

export interface CategoryStats {
  category: string;
  runs: Array<{
    factual_accuracy: number | null;
    citation_correctness: number | null;
    run_at: number;
  }>;
  avgFactual: number;
  avgCitation: number;
  factualRegressed: boolean;
  citationRegressed: boolean;
  lastRunAt: number | null;
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtDate(ts: number | null): string {
  if (!ts) return '--';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function CategoryCard({ stat }: { stat: CategoryStats }) {
  const factualVals = stat.runs
    .map((r) => r.factual_accuracy)
    .filter((v): v is number => v !== null);
  const citationVals = stat.runs
    .map((r) => r.citation_correctness)
    .filter((v): v is number => v !== null);

  const hasRegression = stat.factualRegressed || stat.citationRegressed;

  return (
    <div style={{
      backgroundColor: 'var(--t-bg-card, rgba(255,255,255,0.82))',
      borderRadius: 14,
      paddingTop: 16,
      paddingRight: 20,
      paddingBottom: 16,
      paddingLeft: 20,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      position: 'relative',
      outline: hasRegression ? '1.5px solid #ef4444' : '1px solid rgba(0,0,0,0.06)',
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--t-text-muted, #5b6475)',
        }}>
          {stat.category}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasRegression && (
            <span style={{
              fontSize: 10,
              fontWeight: 600,
              color: '#ef4444',
              backgroundColor: 'rgba(239,68,68,0.1)',
              paddingTop: 2,
              paddingRight: 6,
              paddingBottom: 2,
              paddingLeft: 6,
              borderRadius: 6,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              regression
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--t-text-muted, #9ca3af)' }}>
            {stat.runs.length} run{stat.runs.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Metric rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Factual accuracy */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100 }}>
            <span style={{ fontSize: 10, color: 'var(--t-text-muted, #9ca3af)', letterSpacing: '0.04em' }}>
              FACTUAL ACC.
            </span>
            <span style={{
              fontSize: 18,
              fontWeight: 600,
              color: stat.factualRegressed ? '#ef4444' : 'var(--t-text, #111827)',
              letterSpacing: '-0.02em',
            }}>
              {factualVals.length > 0 ? fmtPct(stat.avgFactual) : '--'}
            </span>
          </div>
          <Sparkline values={factualVals} color="#2563eb" regressed={stat.factualRegressed} />
        </div>

        {/* Citation correctness */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100 }}>
            <span style={{ fontSize: 10, color: 'var(--t-text-muted, #9ca3af)', letterSpacing: '0.04em' }}>
              CITATION CORR.
            </span>
            <span style={{
              fontSize: 18,
              fontWeight: 600,
              color: stat.citationRegressed ? '#ef4444' : 'var(--t-text, #111827)',
              letterSpacing: '-0.02em',
            }}>
              {citationVals.length > 0 ? fmtPct(stat.avgCitation) : '--'}
            </span>
          </div>
          <Sparkline values={citationVals} color="#22c55e" regressed={stat.citationRegressed} />
        </div>
      </div>

      {/* Footer */}
      <div style={{ fontSize: 11, color: 'var(--t-text-muted, #9ca3af)' }}>
        Last run: {fmtDate(stat.lastRunAt)}
      </div>
    </div>
  );
}
