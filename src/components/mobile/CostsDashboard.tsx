'use client';

import { useMemo, memo } from 'react';
import type { CostsDashboardProps } from './types';

/* ── helpers ─────────────────────────────────────────── */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtCost(tokens: number, model: string): string {
  // Rough $/1M token estimates for display
  const rates: Record<string, { input: number; output: number }> = {
    'claude-opus-4-6':            { input: 15, output: 75 },
    'claude-sonnet-4-20250514':   { input: 3,  output: 15 },
    'claude-sonnet-4-5-20250929': { input: 3,  output: 15 },
    'claude-haiku-4-5-20251001':  { input: 1,  output: 5 },
  };
  const rate = rates[model];
  if (!rate) return '';
  // Assume 60/40 input/output split
  const cost = tokens * ((rate.input * 0.6 + rate.output * 0.4) / 1_000_000);
  return cost < 0.01 ? '<$0.01' : `~$${cost.toFixed(2)}`;
}

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#ff3b30',
  'claude-sonnet-4-20250514': '#ff9f0a',
  'claude-sonnet-4-5-20250929': '#ff9f0a',
  'claude-haiku-4-5-20251001': '#34c759',
  'gpt-5.3-codex': '#6366f1',
  'gpt-5.4': '#6366f1',
};

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace('openai-codex/', '')
    .replace(/-20\d{6,8}$/, '')
    .replace('opus-4-6', 'Opus 4.6')
    .replace('sonnet-4-5', 'Sonnet 4.5')
    .replace('sonnet-4', 'Sonnet 4')
    .replace('haiku-4-5', 'Haiku 4.5');
}

/* ── ring chart SVG ──────────────────────────────────── */

function UsageRing({ segments, size = 120 }: {
  segments: { percent: number; color: string; label: string }[];
  size?: number;
}) {
  const r = (size - 16) / 2;
  const circ = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ transform: 'rotate(-90deg)' }}>
      {/* Background track */}
      <circle cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke="rgba(0,122,255,0.06)" strokeWidth={10} />
      {/* Segments */}
      {segments.map((seg) => {
        const len = (seg.percent / 100) * circ;
        const el = (
          <circle
            key={seg.label}
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={seg.color} strokeWidth={10}
            strokeDasharray={`${len} ${circ - len}`}
            strokeDashoffset={-offset}
            strokeLinecap="round"
          />
        );
        offset += len;
        return el;
      })}
    </svg>
  );
}

/* ── main component ──────────────────────────────────── */

export const CostsDashboard = memo(function CostsDashboard({
  snapshot,
  onBack,
  onSessionSelect,
  compactLine,
}: CostsDashboardProps) {
  const ocSessions = useMemo(() =>
    snapshot.sessions.filter(s => s.runtime === 'openclaw' && s.tokenUsage),
    [snapshot.sessions]
  );
  const codexSessions = useMemo(() =>
    snapshot.sessions.filter(s => s.runtime === 'codex'),
    [snapshot.sessions]
  );
  const ccSessions = useMemo(() =>
    snapshot.sessions.filter(s => s.runtime === 'claude-code'),
    [snapshot.sessions]
  );

  const totalTokens = ocSessions.reduce((s, x) => s + (x.tokenUsage?.totalTokens ?? 0), 0);
  const totalRemaining = ocSessions.reduce((s, x) => s + (x.tokenUsage?.remainingTokens ?? 0), 0);
  const hasCapacity = ocSessions.some(s => (s.tokenUsage?.remainingTokens ?? 0) > 0);
  const totalCapacity = hasCapacity ? totalTokens + totalRemaining : 0;
  const usedPct = totalCapacity > 0 ? Math.round((totalTokens / totalCapacity) * 100) : 0;

  // Group by model
  const byModel = useMemo(() => {
    const map = new Map<string, { sessions: typeof ocSessions; tokens: number; capacity: number }>();
    for (const s of ocSessions) {
      const m = s.model ?? 'unknown';
      const e = map.get(m) ?? { sessions: [], tokens: 0, capacity: 0 };
      e.sessions.push(s);
      e.tokens += s.tokenUsage?.totalTokens ?? 0;
      e.capacity += (s.tokenUsage?.totalTokens ?? 0) + (s.tokenUsage?.remainingTokens ?? 0);
      map.set(m, e);
    }
    return map;
  }, [ocSessions]);

  const ringSegments = Array.from(byModel.entries()).map(([model, data]) => ({
    percent: totalCapacity > 0 ? (data.tokens / totalCapacity) * 100 : 0,
    color: MODEL_COLORS[model] ?? '#6366f1',
    label: model,
  }));

  const totalEstimate = Array.from(byModel.entries())
    .reduce((sum, [model, data]) => {
      const cost = fmtCost(data.tokens, model);
      const num = parseFloat(cost.replace(/[^0-9.]/g, ''));
      return sum + (isNaN(num) ? 0 : num);
    }, 0);

  return (
    <div style={{
      padding: '0 14px 40px',
      display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        paddingTop: 8, marginBottom: 16,
      }}>
        <div>
          <h2 style={{
            margin: 0, fontSize: 28, fontWeight: 800,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: '#0a0a0a', letterSpacing: '-0.03em',
          }}>
            Costs
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: 13, color: '#8e8e93', fontWeight: 500 }}>
            {ocSessions.length + codexSessions.length + ccSessions.length} active session{ocSessions.length + codexSessions.length + ccSessions.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button type="button" onClick={onBack} style={{
          padding: '6px 14px', borderRadius: 10,
          background: 'rgba(0,122,255,0.08)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(0,122,255,0.12)',
          color: '#007aff', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
        }}>
          Done
        </button>
      </div>

      {/* Hero card — ring + totals */}
      <div style={{
        padding: '20px',
        borderRadius: 20,
        background: 'rgba(0,122,255,0.03)',
        border: '1px solid rgba(0,122,255,0.08)',
        backdropFilter: 'blur(20px) saturate(1.6)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
        display: 'flex', alignItems: 'center', gap: 20,
        marginBottom: 16,
      }}>
        <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
          <UsageRing segments={ringSegments} />
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: '#0a0a0a', letterSpacing: '-0.02em' }}>
              {usedPct}%
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: '#8e8e93' }}>used</span>
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#0a0a0a', letterSpacing: '-0.02em' }}>
            {fmtTokens(totalTokens)}
          </div>
          <div style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500, marginTop: 2 }}>
            tokens used
          </div>
          {totalCapacity > 0 && (
            <div style={{ fontSize: 11, color: '#c7c7cc', marginTop: 4 }}>
              of {fmtTokens(totalCapacity)} capacity
            </div>
          )}
          {totalEstimate > 0 && (
            <div style={{
              marginTop: 8, padding: '4px 10px',
              borderRadius: 8,
              background: 'rgba(0,122,255,0.06)',
              display: 'inline-block',
              fontSize: 13, fontWeight: 700, color: '#007aff',
            }}>
              ~${totalEstimate.toFixed(2)} est.
            </div>
          )}
        </div>
      </div>

      {/* By model */}
      <span style={{
        display: 'block', fontSize: 12, fontWeight: 700,
        color: '#8e8e93', textTransform: 'uppercase',
        letterSpacing: '0.05em', padding: '0 4px',
        marginBottom: 8,
      }}>
        By Model
      </span>

      {Array.from(byModel.entries()).map(([model, data]) => {
        const pct = data.capacity > 0 ? Math.round((data.tokens / data.capacity) * 100) : 0;
        const color = MODEL_COLORS[model] ?? '#6366f1';
        const cost = fmtCost(data.tokens, model);

        return (
          <div key={model} style={{
            padding: '14px 16px',
            borderRadius: 16,
            background: 'rgba(0,122,255,0.02)',
            border: '1px solid rgba(0,122,255,0.06)',
            marginBottom: 8,
          }}>
            {/* Model header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{
                width: 10, height: 10, borderRadius: '50%',
                background: color,
                boxShadow: `0 0 6px ${color}40`,
              }} />
              <span style={{
                flex: 1, fontSize: 15, fontWeight: 700,
                color: '#0a0a0a',
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}>
                {shortModel(model)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color }}>
                {pct}%
              </span>
            </div>

            {/* Progress bar */}
            <div style={{
              height: 6, borderRadius: 3,
              background: 'rgba(0,0,0,0.04)',
              overflow: 'hidden', marginBottom: 8,
            }}>
              <div style={{
                height: '100%', borderRadius: 3,
                background: `linear-gradient(90deg, ${color}, ${color}cc)`,
                width: `${pct}%`,
                transition: 'width 400ms ease',
              }} />
            </div>

            {/* Meta row */}
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 11, color: '#8e8e93', fontWeight: 500,
            }}>
              <span>{fmtTokens(data.tokens)} tokens</span>
              <span>
                {data.sessions.length} session{data.sessions.length !== 1 ? 's' : ''}
                {cost && ` · ${cost}`}
              </span>
            </div>

            {/* Session rows */}
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.sessions.map((session) => {
                const sPct = session.context?.usedPercent ?? 0;
                const tone = sPct >= 85 ? '#ff3b30' : sPct >= 70 ? '#ff9f0a' : sPct >= 50 ? '#ffcc00' : '#34c759';

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onSessionSelect(session.id)}
                    style={{
                      width: '100%',
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 10px',
                      borderRadius: 10,
                      background: 'rgba(0,0,0,0.02)',
                      border: 'none',
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                      textAlign: 'left',
                    }}
                  >
                    {/* Context ring mini */}
                    <svg width="24" height="24" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(0,0,0,0.04)" strokeWidth="3" />
                      <circle cx="12" cy="12" r="9" fill="none" stroke={tone} strokeWidth="3"
                        strokeDasharray={`${(sPct / 100) * 56.55} ${56.55}`}
                        strokeLinecap="round"
                        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }} />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        fontSize: 13, fontWeight: 600, color: '#0a0a0a',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        display: 'block',
                      }}>
                        {session.isCurrentSession ? 'This chat' : compactLine(session.name, 'Session', 28)}
                      </span>
                    </div>
                    <span style={{
                      fontSize: 11, fontWeight: 600, color: '#8e8e93', flexShrink: 0,
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                    }}>
                      {fmtTokens(session.tokenUsage?.totalTokens ?? 0)}
                    </span>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: tone, flexShrink: 0,
                      minWidth: 32, textAlign: 'right',
                    }}>
                      {sPct}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Codex sessions */}
      {codexSessions.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: 16,
          background: 'rgba(99,102,241,0.03)',
          border: '1px solid rgba(99,102,241,0.08)',
          marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#6366f1',
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: '#0a0a0a' }}>
              Codex
            </span>
            <span style={{ fontSize: 13, color: '#8e8e93', marginLeft: 'auto' }}>
              {codexSessions.length} session{codexSessions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <p style={{
            margin: 0, fontSize: 12, color: '#8e8e93', lineHeight: 1.4,
          }}>
            Billed through ChatGPT Pro — token-level usage not available.
          </p>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {codexSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSessionSelect(s.id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 10,
                  background: 'rgba(0,0,0,0.02)', border: 'none',
                  cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                  textAlign: 'left',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: s.status === 'running' ? '#34c759' : '#8e8e93',
                }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#0a0a0a',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {compactLine(s.name, 'Session', 28)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Claude Code sessions */}
      {ccSessions.length > 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: 16,
          background: 'rgba(175,82,222,0.03)',
          border: '1px solid rgba(175,82,222,0.08)',
          marginBottom: 8,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: '#af52de',
            }} />
            <span style={{ fontSize: 15, fontWeight: 700, color: '#0a0a0a' }}>
              Claude Code
            </span>
            <span style={{ fontSize: 13, color: '#8e8e93', marginLeft: 'auto' }}>
              {ccSessions.length} session{ccSessions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <p style={{
            margin: 0, fontSize: 12, color: '#8e8e93', lineHeight: 1.4,
          }}>
            Billed through Anthropic Max — token-level usage not available.
          </p>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ccSessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSessionSelect(s.id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: 10,
                  background: 'rgba(0,0,0,0.02)', border: 'none',
                  cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                  textAlign: 'left',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: s.status === 'running' ? '#34c759' : '#8e8e93',
                }} />
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: '#0a0a0a',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {compactLine(s.name, 'Session', 28)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {ocSessions.length === 0 && codexSessions.length === 0 && ccSessions.length === 0 && (
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none"
            stroke="rgba(0,122,255,0.2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
            style={{ margin: '0 auto 12px' }}>
            <line x1="12" y1="1" x2="12" y2="23" />
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          <p style={{ fontSize: 15, fontWeight: 600, color: '#8e8e93', margin: 0 }}>
            No usage data yet
          </p>
          <p style={{ fontSize: 12, color: '#c7c7cc', margin: '4px 0 0' }}>
            Token costs will appear here as agents work.
          </p>
        </div>
      )}
    </div>
  );
});
