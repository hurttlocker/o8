'use client';

/**
 * AnalyticsPage — Cost & Usage Dashboard
 *
 * Full-width workspace view showing spend, token usage,
 * and agent efficiency metrics across all supported surfaces:
 * Codex CLI, Claude Code, and IDE LLM Chat.
 *
 * Layout:
 *   Hero metrics row → Hourly/Daily chart → Surface breakdown →
 *   Agent breakdown → Model breakdown → Top sessions
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, Cpu, DollarSign, Layers, TrendingUp, Zap } from 'lucide-react';
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
}

// ── Formatting helpers ──
function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const AGENT_COLORS: Record<string, string> = {
  Mister: '#111827',
  Niot: '#2563eb',
  Hawk: '#f59e0b',
  'Codex CLI': '#10b981',
  'Claude Code': '#7c3aed',
  'IDE LLM Chat': '#ec4899',
};

const SURFACE_COLORS: Record<string, string> = {
  'Codex CLI': '#2563eb',
  'Claude Code': '#f59e0b',
  'IDE LLM Chat': '#7c3aed',
};

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#7c3aed',
  'claude-sonnet-4': '#2563eb',
  'claude-sonnet-4-5': '#3b82f6',
  'claude-haiku-4-5': '#14b8a6',
  'claude-haiku-3-5': '#22c55e',
  'gemini-3-pro-preview': '#f59e0b',
  'gemini-3-flash-preview': '#fb923c',
  'codex': '#10b981',
  'gpt-5': '#10b981',
  'delivery-mirror': '#6b7280',
};

function getModelColor(model: string): string {
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (model.includes(key)) return color;
  }
  return '#9ca3af';
}

// ── Hero Metric Card ──
const MetricCard = memo(function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div style={{
      flex: 1,
      minWidth: 140,
      background: 'var(--t-panel)',
      border: '1px solid var(--t-divider-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 8,
          background: `${color}12`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} strokeWidth={2} color={color} />
        </div>
        <span style={{
          fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {label}
        </span>
      </div>
      <div style={{
        fontSize: 26, fontWeight: 700, color: 'var(--t-text)',
        letterSpacing: '-0.03em', fontFamily: '"SF Mono", ui-monospace, monospace',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value}
      </div>
      {sub && (
        <span style={{ fontSize: 11, color: 'var(--t-text-faint)' }}>
          {sub}
        </span>
      )}
    </div>
  );
});

// ── Hourly/Daily Bar Chart (pure inline SVG) ──
const SpendChart = memo(function SpendChart({ data }: { data: HourBucket[] }) {
  // Aggregate to daily when more than 48 buckets
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
  const chartHeight = 160;
  const chartWidth = chartData.length * (barWidth + 2);
  const isDaily = data.length > 48;

  return (
    <div style={{
      background: 'var(--t-panel)',
      border: '1px solid var(--t-divider-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <BarChart3 size={14} strokeWidth={2} color="#2563eb" />
          <span style={{
            fontSize: 13, fontWeight: 700, color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}>
            {isDaily ? 'Daily Spend' : 'Hourly Spend'}
          </span>
        </div>
        <span style={{
          fontSize: 11, color: 'var(--t-text-faint)',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {chartData.length} {isDaily ? 'days' : 'hours'}
        </span>
      </div>
      <div style={{ overflowX: 'auto', scrollbarWidth: 'none' } as React.CSSProperties} className="hide-scrollbar">
        <svg width={Math.max(chartWidth, 300)} height={chartHeight + 24} viewBox={`0 0 ${Math.max(chartWidth, 300)} ${chartHeight + 24}`}>
          {[0, 0.25, 0.5, 0.75, 1].map(pct => (
            <line
              key={pct}
              x1={0} x2={Math.max(chartWidth, 300)}
              y1={chartHeight * (1 - pct)} y2={chartHeight * (1 - pct)}
              stroke="var(--t-divider-subtle)" strokeWidth="1" strokeDasharray="4,4"
            />
          ))}
          {chartData.map((d, i) => {
            const h = (d.cost / maxCost) * chartHeight;
            const x = i * (barWidth + 2);
            const labelInterval = Math.max(1, Math.floor(chartData.length / 8));
            return (
              <g key={i}>
                <rect
                  x={x} y={chartHeight - h}
                  width={barWidth} height={Math.max(h, 1)}
                  rx={barWidth > 12 ? 4 : 2}
                  fill="#2563eb"
                  opacity={0.7}
                >
                  <title>{`${d.hour}\n${formatCost(d.cost)} · ${d.messages} msgs · ${formatTokens(d.tokens)} tokens`}</title>
                </rect>
                {(i % labelInterval === 0) && (
                  <text
                    x={x + barWidth / 2} y={chartHeight + 16}
                    textAnchor="middle"
                    fontSize={9} fill="var(--t-text-faint)"
                    fontFamily='"SF Mono", ui-monospace, monospace'
                  >
                    {isDaily ? d.hour.slice(5) : (d.hour.split(' ')[1] || d.hour.slice(-5))}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
});

// ── Breakdown Card (shared for Agent, Surface) ──
const BreakdownCard = memo(function BreakdownCard({
  title,
  icon: Icon,
  iconColor,
  entries,
  totalCost,
  colorMap,
}: {
  title: string;
  icon: typeof Cpu;
  iconColor: string;
  entries: Array<[string, BreakdownEntry]>;
  totalCost: number;
  colorMap: Record<string, string>;
}) {
  if (entries.length === 0) return null;

  return (
    <div style={{
      background: 'var(--t-panel)',
      border: '1px solid var(--t-divider-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Icon size={14} strokeWidth={2} color={iconColor} />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          {title}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {entries.map(([name, data]) => {
          const pct = totalCost > 0 ? (data.cost / totalCost) * 100 : 0;
          const tokenPct = entries.reduce((s, [, d]) => s + d.tokens, 0);
          const tokPct = tokenPct > 0 ? (data.tokens / tokenPct) * 100 : 0;
          const color = colorMap[name] || '#9ca3af';
          const barPct = Math.max(pct, tokPct); // Use whichever is larger for bar visibility
          return (
            <div key={name}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>{name}</span>
                  <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
                    {data.sessions} session{data.sessions !== 1 ? 's' : ''}
                  </span>
                </div>
                <span style={{
                  fontSize: 13, fontWeight: 700, color: 'var(--t-text)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  {data.cost > 0 ? formatCost(data.cost) : formatTokens(data.tokens) + ' tok'}
                </span>
              </div>
              <div style={{ height: 6, borderRadius: 3, background: 'var(--t-bg-subtle)', overflow: 'hidden' }}>
                <div style={{
                  width: `${Math.max(barPct, 1)}%`,
                  height: '100%',
                  borderRadius: 3,
                  background: color,
                  opacity: 0.7,
                  transition: 'width 300ms cubic-bezier(0.32, 0.72, 0, 1)',
                }} />
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {data.messages.toLocaleString()} msgs
                </span>
                <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {formatTokens(data.tokens)} tokens
                </span>
                {data.cost > 0 && (
                  <span style={{ fontSize: 10, color: 'var(--t-text-faint)', fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                    {pct.toFixed(1)}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── Model Breakdown ──
const ModelBreakdownCard = memo(function ModelBreakdownCard({ byModel }: { byModel: ModelBreakdown[] }) {
  if (byModel.length === 0) return null;

  return (
    <div style={{
      background: 'var(--t-panel)',
      border: '1px solid var(--t-divider-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Zap size={14} strokeWidth={2} color="#7c3aed" />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          By Model
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {byModel.map((m) => {
          const color = getModelColor(m.model);
          return (
            <div key={m.model} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 10px',
              borderRadius: 10,
              background: 'var(--t-bg-subtle)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: 3, background: color }} />
                <span style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--t-text)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  {m.model}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
                  {m.sessions} sess · {m.messages} msgs
                </span>
                <span style={{
                  fontSize: 12, fontWeight: 700, color: 'var(--t-text)',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                }}>
                  {m.cost > 0 ? formatCost(m.cost) : `${m.messages} calls`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── Top Sessions Table ──
const TopSessionsCard = memo(function TopSessionsCard({ sessions }: { sessions: TopSession[] }) {
  if (sessions.length === 0) return null;

  return (
    <div style={{
      background: 'var(--t-panel)',
      border: '1px solid var(--t-divider-subtle)',
      borderRadius: 14,
      padding: '16px 18px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <TrendingUp size={14} strokeWidth={2} color="var(--t-accent)" />
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em' }}>
          Top Sessions by Spend
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {sessions.map((s, i) => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px',
            borderRadius: 10,
            background: i % 2 === 0 ? 'var(--t-bg-subtle)' : 'transparent',
          }}>
            <span style={{
              width: 18, fontSize: 10, fontWeight: 700,
              color: 'var(--t-text-faint)', textAlign: 'right',
            }}>
              {i + 1}
            </span>
            <div style={{
              width: 8, height: 8, borderRadius: 4,
              background: s.active ? '#34c759' : (AGENT_COLORS[s.agent] || '#9ca3af'),
              boxShadow: s.active ? '0 0 6px rgba(52, 211, 153, 0.4)' : 'none',
            }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text)', width: 80 }}>
              {s.agent}
            </span>
            <span style={{
              fontSize: 10, color: 'var(--t-text-faint)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              flex: 1,
            }}>
              {s.id.slice(0, 8)}…
            </span>
            <span style={{ fontSize: 10, color: 'var(--t-text-faint)' }}>
              {s.messages} msgs
            </span>
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--t-text)',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              width: 70, textAlign: 'right',
            }}>
              {s.cost > 0 ? formatCost(s.cost) : `${s.messages}×`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

// ── Time Range Picker ──
const timeRanges = [
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '24h', hours: 24 },
  { label: '48h', hours: 48 },
  { label: '7d', hours: 168 },
];

// ══════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════

export const AnalyticsPage = memo(function AnalyticsPage() {
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
    <div style={{
      flex: 1,
      overflowY: 'auto',
      padding: '24px 32px',
      scrollbarWidth: 'none',
      background: 'var(--t-bg-subtle)',
    } as React.CSSProperties}
    className="hide-scrollbar"
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Activity size={18} strokeWidth={2} color="var(--t-accent)" />
          <span style={{
            fontSize: 20, fontWeight: 800, color: 'var(--t-text)',
            letterSpacing: '-0.03em',
          }}>
            Analytics
          </span>
        </div>
        {/* Time range picker */}
        <div style={{
          display: 'flex', gap: 2,
          background: 'var(--t-panel)',
          border: '1px solid var(--t-divider-subtle)',
          borderRadius: 8,
          padding: 2,
        }}>
          {timeRanges.map(r => (
            <button
              key={r.hours}
              type="button"
              onClick={() => setSelectedRange(r.hours)}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: 'none',
                background: selectedRange === r.hours ? 'var(--t-accent)' : 'transparent',
                color: selectedRange === r.hours ? '#fff' : 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                transition: 'all 120ms',
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {loading && !data ? (
        <div style={{ textAlign: 'center', color: 'var(--t-text-muted)', padding: 40 }}>
          Loading analytics…
        </div>
      ) : data && data.totals.messages === 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 12, padding: '80px 32px', color: 'var(--t-text-faint)',
        }}>
          <BarChart3 size={40} strokeWidth={1.5} style={{ opacity: 0.3 }} />
          <span style={{ fontSize: 15, fontWeight: 600 }}>No activity in this period</span>
          <span style={{ fontSize: 12 }}>Try a wider time range or wait for agent activity.</span>
        </div>
      ) : data ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 960 }}>
          {/* Hero metrics — row 1 */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <MetricCard
              icon={DollarSign}
              label="Total Spend"
              value={formatCost(data.totals.cost)}
              sub={`${data.totals.sessions} sessions`}
              color="#22c55e"
            />
            <MetricCard
              icon={Zap}
              label="Messages"
              value={data.totals.messages.toLocaleString()}
              sub={`~${Math.round(data.totals.messages / Math.max(data.hourly.length, 1))}/hr avg`}
              color="#2563eb"
            />
            <MetricCard
              icon={Clock}
              label="Cost/Hour"
              value={formatCost(data.totals.cost / Math.max(data.hourly.length, 1))}
              sub={`over ${data.hourly.length} hours`}
              color="#f59e0b"
            />
          </div>

          {/* Hero metrics — row 2 */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <MetricCard
              icon={TrendingUp}
              label="Input Tokens"
              value={formatTokens(data.totals.inputTokens)}
              sub={`${formatTokens(data.totals.cacheWriteTokens)} cache writes`}
              color="#f59e0b"
            />
            <MetricCard
              icon={TrendingUp}
              label="Output Tokens"
              value={formatTokens(data.totals.outputTokens)}
              sub={`${formatTokens(data.totals.totalTokens)} total tokens`}
              color="#7c3aed"
            />
            <MetricCard
              icon={Activity}
              label="Cache Hit Rate"
              value={`${data.totals.cacheHitRate.toFixed(1)}%`}
              sub={`${formatTokens(data.totals.cacheTokens)} cache reads saved`}
              color="#22c55e"
            />
          </div>

          {/* Spend chart */}
          <SpendChart data={data.hourly} />

          {/* Surface breakdown */}
          {surfaceEntries.length > 0 && (
            <BreakdownCard
              title="By Surface"
              icon={Layers}
              iconColor="#2563eb"
              entries={surfaceEntries}
              totalCost={data.totals.cost}
              colorMap={SURFACE_COLORS}
            />
          )}

          {/* Two-column: Agent + Model */}
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <BreakdownCard
                title="By Agent"
                icon={Cpu}
                iconColor="#111827"
                entries={agentEntries}
                totalCost={data.totals.cost}
                colorMap={AGENT_COLORS}
              />
            </div>
            <div style={{ flex: 1 }}>
              <ModelBreakdownCard byModel={data.byModel} />
            </div>
          </div>

          {/* Top sessions */}
          <TopSessionsCard sessions={data.topSessions} />
        </div>
      ) : null}
    </div>
  );
});

export default AnalyticsPage;
