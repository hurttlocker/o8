'use client';

/**
 * AnalyticsPage — Cost & Usage Dashboard
 *
 * Dieter Rams × Swiss-Korean editorial design language.
 * Numbered sections, hairlines, solid page surface, mono metric callouts.
 * One orange accent (RAMS_ACCENT) scarce per fold. No colored pill backgrounds.
 * Flat text + hairline rows over cards wherever possible.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ClaudeIcon, CodexIcon } from '@/components/desktop/repo-registry/shared';
import { formatTokens } from '@/lib/util/format-tokens';
import type { ReactNode } from 'react';
import {
  APP_FONT_STACK,
  MONO_FONT_STACK,
  RAMS_ACCENT,
  RAMS_HAIRLINE_SOFT,
  RAMS_HAIRLINE,
  RAMS_INK_QUIET,
  RAMS_CONTROL_BG,
  RAMS_CONTROL_BORDER,
  RAMS_CONTROL_ACTIVE_BG,
  RAMS_CONTROL_ACTIVE_BORDER,
  BracketLabel,
  HairlineRule,
  SectionLabel,
  TabHeading,
} from './settings/shared';
import { AnalyticsMoatSections, type AutonomyMetrics, type GovernanceMetrics } from './analytics/AnalyticsMoatSections';

// ── Types ──

interface Totals {
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  sessions: number;
  cacheHitRate: number;
  avgCostPerMessage: number;
  totalTokens: number;
}

interface HourBucket {
  hour: string;
  cost: number;
  messages: number;
  tokens: number;
}

interface ModelBreakdown {
  model: string;
  cost: number;
  messages: number;
  sessions: number;
}

interface BreakdownEntry {
  cost: number;
  messages: number;
  tokens: number;
  sessions: number;
}

interface TopSession {
  id: string;
  agent: string;
  cost: number;
  messages: number;
  model: string;
  active: boolean;
}

interface AnalyticsData {
  totals: Totals;
  byAgent: Record<string, BreakdownEntry>;
  bySurface: Record<string, BreakdownEntry>;
  byModel: ModelBreakdown[];
  hourly: HourBucket[];
  topSessions: TopSession[];
  autonomy: AutonomyMetrics | null;
  governance: GovernanceMetrics | null;
}

// ── Formatting helpers ──

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

/**
 * Return the official brand logo node for a known agent/model family.
 * Returns null so callers can fall back to a neutral dot.
 */
function brandLogoFor(name: string, size = 12): ReactNode | null {
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return <ClaudeIcon size={size} />;
  if (lower.includes('codex') || lower.startsWith('gpt')) return <CodexIcon size={size} />;
  return null;
}

// ── Analytics controls ──

function analyticsControlStyle(active: boolean, disabled = false): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    fontFamily: APP_FONT_STACK,
    fontSize: 12,
    fontWeight: 350,
    color: active ? 'var(--t-text)' : RAMS_INK_QUIET,
    background: active ? RAMS_CONTROL_ACTIVE_BG : RAMS_CONTROL_BG,
    border: `1px solid ${active ? RAMS_CONTROL_ACTIVE_BORDER : RAMS_CONTROL_BORDER}`,
    borderRadius: 10,
    paddingTop: 0,
    paddingBottom: 0,
    paddingLeft: 12,
    paddingRight: 12,
    cursor: disabled ? 'default' : 'pointer',
    letterSpacing: '0',
    opacity: disabled ? 0.6 : 1,
    transition: 'background 160ms ease, border-color 160ms ease, color 160ms ease',
    boxShadow: active ? '0 10px 24px rgba(37, 99, 235, 0.08)' : 'none',
  };
}

// ── Time range picker ──

const TIME_RANGES = [
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
];

// ── Hero Metric Row ──
// Large mono callout value, small uppercase label below. No icon box.

const MetricCell = memo(function MetricCell({
  label,
  value,
  sub,
  accent = false,
}: {
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
          fontWeight: 400,
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

// ── Spend Chart (inline SVG) ──
// Single RAMS_ACCENT orange series. Hairline grid. No color rainbows.

const SpendChart = memo(function SpendChart({ data }: { data: HourBucket[] }) {
  const chartData = useMemo(() => {
    if (data.length <= 48) return data;
    const dailyMap = new Map<string, HourBucket>();
    for (const bucket of data) {
      const day = bucket.hour.split(' ')[0] ?? bucket.hour;
      const existing = dailyMap.get(day);
      if (existing) {
        existing.cost += bucket.cost;
        existing.messages += bucket.messages;
        existing.tokens += bucket.tokens;
      } else {
        dailyMap.set(day, { hour: day, cost: bucket.cost, messages: bucket.messages, tokens: bucket.tokens });
      }
    }
    return Array.from(dailyMap.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  }, [data]);

  if (chartData.length === 0) return null;

  const maxCost = Math.max(...chartData.map(d => d.cost), 0.01);
  const barWidth = Math.max(8, Math.min(28, 700 / chartData.length - 2));
  const chartHeight = 140;
  const chartWidth = chartData.length * (barWidth + 2);
  const isDaily = data.length > 48;

  return (
    <div style={{ overflowX: 'auto', scrollbarWidth: 'none' } as React.CSSProperties}>
      <div style={{
        fontFamily: MONO_FONT_STACK,
        fontSize: 10,
        fontWeight: 400,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: RAMS_INK_QUIET,
        marginBottom: 10,
      }}>
        {isDaily ? 'daily spend' : 'hourly spend'}
        <span style={{ marginLeft: 12, opacity: 0.6 }}>
          {chartData.length} {isDaily ? 'days' : 'hours'}
        </span>
      </div>
      <svg
        width={Math.max(chartWidth, 300)}
        height={chartHeight + 24}
        viewBox={`0 0 ${Math.max(chartWidth, 300)} ${chartHeight + 24}`}
      >
        {/* Hairline grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => (
          <line
            key={pct}
            x1={0}
            x2={Math.max(chartWidth, 300)}
            y1={chartHeight * (1 - pct)}
            y2={chartHeight * (1 - pct)}
            stroke={RAMS_HAIRLINE_SOFT}
            strokeWidth="1"
          />
        ))}
        {/* Bars — single orange series */}
        {chartData.map((d, i) => {
          const h = (d.cost / maxCost) * chartHeight;
          const x = i * (barWidth + 2);
          const labelInterval = Math.max(1, Math.floor(chartData.length / 8));
          return (
            <g key={i}>
              <rect
                x={x}
                y={chartHeight - h}
                width={barWidth}
                height={Math.max(h, 1)}
                rx={barWidth > 12 ? 3 : 2}
                fill={RAMS_ACCENT}
                opacity={0.72}
              >
                <title>{`${d.hour}\n${formatCost(d.cost)} · ${d.messages} msgs · ${formatTokens(d.tokens)} tokens`}</title>
              </rect>
              {(i % labelInterval === 0) && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  fontSize={9}
                  fill={RAMS_INK_QUIET}
                  fontFamily={MONO_FONT_STACK}
                >
                  {isDaily ? d.hour.slice(5) : (d.hour.split(' ')[1] || d.hour.slice(-5))}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
});

// ── Breakdown Rows (Surface / Agent) ──
// Flat hairline rows, no card backgrounds. Bar uses RAMS_ACCENT, muted track.

const BreakdownRows = memo(function BreakdownRows({
  entries,
  totalCost,
}: {
  entries: Array<[string, BreakdownEntry]>;
  totalCost: number;
}) {
  if (entries.length === 0) return null;
  const tokenTotal = entries.reduce((s, [, d]) => s + d.tokens, 0);

  return (
    <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
      {entries.map(([name, data]) => {
        const pct = totalCost > 0 ? (data.cost / totalCost) * 100 : 0;
        const tokPct = tokenTotal > 0 ? (data.tokens / tokenTotal) * 100 : 0;
        const barPct = Math.max(pct, tokPct);
        const brand = brandLogoFor(name, 13);

        return (
          <div
            key={name}
            style={{
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 0,
              paddingRight: 0,
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginBottom: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {brand ? (
                  <span style={{ display: 'inline-flex', flexShrink: 0 }}>{brand}</span>
                ) : (
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    background: RAMS_INK_QUIET,
                    flexShrink: 0,
                    display: 'inline-block',
                  }} />
                )}
                <span style={{
                  fontFamily: APP_FONT_STACK,
                  fontSize: 13,
                  fontWeight: 400,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.005em',
                }}>
                  {name}
                </span>
                <BracketLabel tone="quiet">
                  {data.sessions} sess
                </BracketLabel>
              </div>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 13,
                fontWeight: 300,
                color: 'var(--t-text)',
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0,
              }}>
                {data.cost > 0 ? formatCost(data.cost) : formatTokens(data.tokens) + ' tok'}
              </span>
            </div>
            {/* Progress bar — orange, muted track */}
            <div style={{
              height: 2,
              borderRadius: 1,
              background: RAMS_HAIRLINE_SOFT,
              overflow: 'hidden',
              marginBottom: 6,
            }}>
              <div style={{
                width: '100%',
                height: '100%',
                borderRadius: 1,
                background: RAMS_ACCENT,
                opacity: 0.7,
                transform: `scaleX(${Math.max(barPct, 1) / 100})`,
                transformOrigin: 'left',
                transition: 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)',
              }} />
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 10,
                color: RAMS_INK_QUIET,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.04em',
              }}>
                {data.messages.toLocaleString()} msgs
              </span>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 10,
                color: RAMS_INK_QUIET,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.04em',
              }}>
                {formatTokens(data.tokens)} tok
              </span>
              {data.cost > 0 && (
                <span style={{
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 10,
                  color: RAMS_INK_QUIET,
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '0.04em',
                }}>
                  {pct.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ── Model Breakdown Rows ──

const ModelRows = memo(function ModelRows({ byModel }: { byModel: ModelBreakdown[] }) {
  if (byModel.length === 0) return null;

  return (
    <div style={{ borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
      {byModel.map((m) => {
        const brand = brandLogoFor(m.model, 12);
        return (
          <div
            key={m.model}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              paddingTop: 11,
              paddingBottom: 11,
              paddingLeft: 0,
              paddingRight: 0,
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
              {brand ? (
                <span style={{ display: 'inline-flex', flexShrink: 0 }}>{brand}</span>
              ) : (
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: RAMS_INK_QUIET,
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
              )}
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 11,
                fontWeight: 400,
                color: 'var(--t-text)',
                letterSpacing: '0.04em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {m.model}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 10,
                color: RAMS_INK_QUIET,
                letterSpacing: '0.04em',
              }}>
                {m.sessions} sess · {m.messages} msgs
              </span>
              <span style={{
                fontFamily: MONO_FONT_STACK,
                fontSize: 12,
                fontWeight: 300,
                color: 'var(--t-text)',
                fontVariantNumeric: 'tabular-nums',
                minWidth: 60,
                textAlign: 'right',
              }}>
                {m.cost > 0 ? formatCost(m.cost) : `${m.messages} calls`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ── Top Sessions Table ──
// Flat hairline rows, mono session ID, no zebra-stripe backgrounds.

const TopSessionsRows = memo(function TopSessionsRows({ sessions }: { sessions: TopSession[] }) {
  if (sessions.length === 0) return null;

  return (
    <>
      {/* Column headers */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 0,
        paddingBottom: 8,
        paddingLeft: 0,
        paddingRight: 0,
        borderBottom: `1px solid ${RAMS_HAIRLINE}`,
      }}>
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          width: 20,
        }}>#</span>
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          width: 80,
        }}>agent</span>
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          flex: 1,
        }}>session id</span>
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          width: 50,
          textAlign: 'right',
        }}>msgs</span>
        <span style={{
          fontFamily: MONO_FONT_STACK,
          fontSize: 10,
          fontWeight: 400,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: RAMS_INK_QUIET,
          width: 70,
          textAlign: 'right',
        }}>spend</span>
      </div>
      {sessions.map((s, i) => {
        const brand = brandLogoFor(s.agent, 12);
        return (
          <div
            key={s.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 0,
              paddingRight: 0,
              borderBottom: `1px solid ${RAMS_HAIRLINE_SOFT}`,
            }}
          >
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              color: RAMS_INK_QUIET,
              width: 20,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {i + 1}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 80 }}>
              {brand ? (
                <span style={{ display: 'inline-flex', flexShrink: 0 }}>{brand}</span>
              ) : (
                <span style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: s.active ? RAMS_ACCENT : RAMS_INK_QUIET,
                  flexShrink: 0,
                  display: 'inline-block',
                }} />
              )}
              <span style={{
                fontFamily: APP_FONT_STACK,
                fontSize: 12,
                fontWeight: 400,
                color: 'var(--t-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {s.agent}
              </span>
            </div>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              color: RAMS_INK_QUIET,
              flex: 1,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '0.04em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {s.id.slice(0, 8)}…
            </span>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 11,
              color: RAMS_INK_QUIET,
              width: 50,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {s.messages}
            </span>
            <span style={{
              fontFamily: MONO_FONT_STACK,
              fontSize: 12,
              fontWeight: 300,
              color: 'var(--t-text)',
              width: 70,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {s.cost > 0 ? formatCost(s.cost) : `${s.messages}×`}
            </span>
          </div>
        );
      })}
    </>
  );
});

// ══════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════

export const AnalyticsPage = memo(function AnalyticsPage({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedRange, setSelectedRange] = useState(24);

  const fetchData = useCallback(async (hours: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/panel/analytics?hours=${hours}`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchData(selectedRange);
    const interval = setInterval(() => fetchData(selectedRange), 60_000);
    return () => clearInterval(interval);
  }, [selectedRange, fetchData]);

  const agentEntries = useMemo(() => {
    if (!data?.byAgent) return [];
    return Object.entries(data.byAgent).sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  }, [data?.byAgent]);

  const surfaceEntries = useMemo(() => {
    if (!data?.bySurface) return [];
    return Object.entries(data.bySurface)
      .filter(([, d]) => d.messages > 0 || d.sessions > 0)
      .sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens);
  }, [data?.bySurface]);

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: embedded ? 'visible' : 'auto',
        paddingTop: embedded ? 0 : 8,
        paddingLeft: embedded ? 0 : 32,
        paddingRight: embedded ? 0 : 32,
        paddingBottom: embedded ? 0 : 40,
        scrollbarWidth: 'none',
        background: embedded ? 'transparent' : 'var(--t-chat-surface-bg)',
        color: 'var(--t-chat-surface-text)',
        fontFamily: APP_FONT_STACK,
      } as React.CSSProperties}
    >
      <div style={{ maxWidth: embedded ? 980 : 940, marginLeft: 'auto', marginRight: 'auto' }}>
        {/* Breadcrumb + heading */}
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 28,
        }}>
          <TabHeading
            title="analytics"
            subtitle="Spend stays king. Autonomy + governance on top — how much shipped clean, and the approval funnel."
          />
          {/* Time range picker */}
          <div style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            paddingTop: 6,
            flexShrink: 0,
            flexWrap: 'wrap',
          }}>
            {TIME_RANGES.map(r => (
              <button
                key={r.hours}
                type="button"
                onClick={() => setSelectedRange(r.hours)}
                style={{
                  ...analyticsControlStyle(selectedRange === r.hours),
                  minWidth: 44,
                  fontFamily: MONO_FONT_STACK,
                  fontSize: 11,
                  letterSpacing: '0.08em',
                }}
              >
                {r.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { void fetchData(selectedRange); }}
              disabled={loading}
              style={{
                ...analyticsControlStyle(false, loading),
                minWidth: 82,
              }}
            >
              {loading ? 'Loading' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* The cross-user admin/founder analytics (all accounts, sign-ins, spend)
            moved off the desktop to the web console — admin-gated on o8.run.
            This tab now shows only THIS install's own cost/autonomy/governance. */}

        {/* ── Loading / empty / data ── */}

        {loading && !data ? (
          <div style={{
            fontFamily: MONO_FONT_STACK,
            fontSize: 11,
            color: RAMS_INK_QUIET,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            paddingTop: 40,
          }}>
            loading…
          </div>
        ) : data && data.totals.messages === 0 ? (
          <div style={{
            paddingTop: 48,
            paddingBottom: 48,
          }}>
            <BracketLabel tone="quiet">no data</BracketLabel>
            <p style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 13,
              fontWeight: 400,
              color: 'var(--t-text-secondary)',
              lineHeight: 1.55,
              marginTop: 10,
              marginBottom: 0,
            }}>
              No activity recorded in this period. Try a wider time range or wait for agent activity.
            </p>
          </div>
        ) : data ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

            {/* ── 01 / 02 — AUTONOMY + GOVERNANCE lead the page (moat-forward); cost below ── */}
            <AnalyticsMoatSections autonomy={data.autonomy ?? null} governance={data.governance ?? null} />

            {/* ── 03 — TOTALS (cost) ── */}
            <section style={{ marginBottom: 36 }}>
              <SectionLabel number="03">TOTALS</SectionLabel>
              {/* Row 1: spend / messages / cost-per-hour */}
              <div style={{
                display: 'flex',
                gap: 0,
                flexWrap: 'wrap',
                borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                marginBottom: 0,
              }}>
                <MetricCell
                  label="total spend"
                  value={formatCost(data.totals.cost)}
                  sub={`${data.totals.sessions} sessions`}
                  accent
                />
                <MetricCell
                  label="messages"
                  value={data.totals.messages.toLocaleString()}
                  sub={`~${Math.round(data.totals.messages / Math.max(data.hourly.length, 1))}/hr avg`}
                />
                <MetricCell
                  label="cost / hour"
                  value={formatCost(data.totals.cost / Math.max(data.hourly.length, 1))}
                  sub={`over ${data.hourly.length} hrs`}
                />
              </div>
              <HairlineRule />
              {/* Row 2: tokens */}
              <div style={{
                display: 'flex',
                gap: 0,
                flexWrap: 'wrap',
                borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}`,
                marginBottom: 16,
              }}>
                <MetricCell
                  label="input tokens"
                  value={formatTokens(data.totals.inputTokens)}
                  sub={`${formatTokens(data.totals.cacheWriteTokens)} cache writes`}
                />
                <MetricCell
                  label="output tokens"
                  value={formatTokens(data.totals.outputTokens)}
                  sub={`${formatTokens(data.totals.totalTokens)} total`}
                />
                <MetricCell
                  label="cache hit rate"
                  value={`${data.totals.cacheHitRate.toFixed(1)}%`}
                  sub={`${formatTokens(data.totals.cacheTokens)} reads saved`}
                />
              </div>
              <HairlineRule />
            </section>

            {/* ── 04 — SPEND OVER TIME ── */}
            {data.hourly.length > 0 && (
              <section style={{ marginBottom: 36 }}>
                <SectionLabel number="04">SPEND OVER TIME</SectionLabel>
                <SpendChart data={data.hourly} />
                <div style={{ marginTop: 20 }}>
                  <HairlineRule />
                </div>
              </section>
            )}

            {/* ── 05 — BY SURFACE ── */}
            {surfaceEntries.length > 0 && (
              <section style={{ marginBottom: 36 }}>
                <SectionLabel number="05">BY SURFACE</SectionLabel>
                <BreakdownRows
                  entries={surfaceEntries}
                  totalCost={data.totals.cost}
                />
                <div style={{ marginTop: 20 }}>
                  <HairlineRule />
                </div>
              </section>
            )}

            {/* ── 06 — BY AGENT + BY MODEL (two columns) ── */}
            <section style={{ marginBottom: 36 }}>
              <div style={{
                display: 'flex',
                gap: 48,
                flexWrap: 'wrap',
                alignItems: 'flex-start',
              }}>
                {agentEntries.length > 0 && (
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <SectionLabel number="06">BY AGENT</SectionLabel>
                    <BreakdownRows
                      entries={agentEntries}
                      totalCost={data.totals.cost}
                    />
                  </div>
                )}
                {data.byModel.length > 0 && (
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <SectionLabel number={agentEntries.length > 0 ? '07' : '06'}>BY MODEL</SectionLabel>
                    <ModelRows byModel={data.byModel} />
                  </div>
                )}
              </div>
              <div style={{ marginTop: 20 }}>
                <HairlineRule />
              </div>
            </section>

            {/* ── 07 / 08 — TOP SESSIONS ── */}
            {data.topSessions.length > 0 && (
              <section style={{ marginBottom: 36 }}>
                <SectionLabel number={agentEntries.length > 0 && data.byModel.length > 0 ? '08' : '07'}>
                  TOP SESSIONS BY SPEND
                </SectionLabel>
                <TopSessionsRows sessions={data.topSessions} />
                <div style={{ marginTop: 20 }}>
                  <HairlineRule />
                </div>
              </section>
            )}

          </div>
        ) : null}
      </div>
    </div>
  );
});

export default AnalyticsPage;
