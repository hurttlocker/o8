'use client';

import React, { useState, useEffect, useCallback } from 'react';
import type { CortexHealthSummary, CortexConflict, CortexStaleFact } from '@/lib/cortex/types';

interface MemoryHealthProps {
  visible: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function MemoryHealth({ visible, onClose }: MemoryHealthProps) {
  const [health, setHealth] = useState<CortexHealthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'stale' | 'conflicts'>('overview');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try { setHealth(await (await fetch('/api/mobile/cortex/health')).json()); }
    catch { setHealth(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (visible) fetchHealth(); }, [visible, fetchHealth]);

  const resolve = useCallback(async (action: string, factId: number, supersededId?: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, factId, supersededId }),
      });
      fetchHealth();
    } catch { /* non-critical */ }
  }, [fetchHealth]);

  if (!visible) return null;

  const stats = health?.stats;
  const staleCount = health?.staleFacts?.length ?? 0;
  const conflictCount = health?.conflicts?.length ?? 0;
  const tabs = [
    { key: 'overview' as const, label: 'Overview' },
    { key: 'stale' as const, label: 'Stale', count: staleCount, color: '#ff9f0a' },
    { key: 'conflicts' as const, label: 'Conflicts', count: conflictCount, color: '#ff453a' },
  ];

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: '#000000', zIndex: 1000,
      display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Nav bar */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '60px 20px 14px',
      }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.03em', margin: 0 }}>
          Memory Health
        </h2>
        <button onClick={onClose} aria-label="Close" style={{
          background: '#2c2c2e', border: 'none', borderRadius: 15,
          width: 30, height: 30, display: 'flex', alignItems: 'center',
          justifyContent: 'center', color: '#aeaeb2', fontSize: 14,
          fontWeight: 700, cursor: 'pointer', minWidth: 44, minHeight: 44,
        }}>✕</button>
      </div>

      {/* Segmented control */}
      <div style={{
        display: 'flex', margin: '0 20px 2px', background: '#1c1c1e',
        borderRadius: 10, padding: 2,
      }}>
        {tabs.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            flex: 1, padding: '8px 0',
            background: activeTab === tab.key ? '#3a3a3c' : 'transparent',
            border: 'none', borderRadius: 8,
            fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400,
            color: activeTab === tab.key ? '#ffffff' : '#636366',
            cursor: 'pointer', letterSpacing: '-0.01em', position: 'relative',
            transition: 'all 0.2s ease',
          }}>
            {tab.label}
            {(tab.count ?? 0) > 0 && (
              <span style={{
                position: 'absolute', top: 4, right: '12%',
                fontSize: 9, fontWeight: 700, lineHeight: '14px',
                background: tab.color, color: tab.key === 'conflicts' ? '#fff' : '#000',
                borderRadius: 7, padding: '0 5px', minWidth: 14, textAlign: 'center',
              }}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 32px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{
              width: 24, height: 24, margin: '0 auto 16px',
              border: '2px solid #3a3a3c', borderTopColor: '#af52de',
              borderRadius: 12, animation: 'spin 0.8s linear infinite',
            }} />
            <div style={{ color: '#636366', fontSize: 14 }}>Loading…</div>
          </div>
        )}

        {!loading && !health?.available && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>🧠</div>
            <div style={{ color: '#ffffff', fontSize: 17, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>
              Cortex Not Installed
            </div>
            <div style={{ color: '#636366', fontSize: 14, lineHeight: '20px' }}>
              {health?.error ?? 'Install Cortex to enable persistent memory.'}
            </div>
          </div>
        )}

        {!loading && health?.available && activeTab === 'overview' && stats && <OverviewTab stats={stats} />}
        {!loading && health?.available && activeTab === 'stale' && (
          <StaleTab facts={health.staleFacts} onReinforce={(id) => resolve('reinforce', id)} onRetire={(id) => resolve('retire', id)} />
        )}
        {!loading && health?.available && activeTab === 'conflicts' && (
          <ConflictsTab conflicts={health.conflicts} onResolve={(keep, sup) => resolve('supersede', keep, sup)} />
        )}
      </div>
    </div>
  );
}

function OverviewTab({ stats }: { stats: CortexHealthSummary['stats'] }) {
  const { high, medium, low } = stats.confidence_distribution;
  const total = stats.facts || 1;
  const highPct = (high / total) * 100;
  const medPct = (medium / total) * 100;

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <MetricCard label="Facts" value={formatNumber(stats.facts)} icon="🧬" />
        <MetricCard label="Memories" value={formatNumber(stats.memories)} icon="💾" />
        <MetricCard label="Storage" value={formatBytes(stats.storage_bytes)} icon="📦" />
        <MetricCard label="Confidence" value={`${(stats.avg_confidence * 100).toFixed(0)}%`} icon="📈" />
      </div>

      <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '18px 16px', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: '#8e8e93', fontWeight: 500, marginBottom: 12, letterSpacing: '-0.01em' }}>
          Confidence Distribution
        </div>
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 12, background: '#2c2c2e' }}>
          <div style={{ width: `${highPct}%`, background: '#34c759', transition: 'width 0.5s ease' }} />
          <div style={{ width: `${medPct}%`, background: '#ff9f0a', transition: 'width 0.5s ease' }} />
          <div style={{ width: `${100 - highPct - medPct}%`, background: '#ff453a', transition: 'width 0.5s ease' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: '#34c759', fontWeight: 500 }}>High {formatNumber(high)}</span>
          <span style={{ color: '#ff9f0a', fontWeight: 500 }}>Med {formatNumber(medium)}</span>
          <span style={{ color: '#ff453a', fontWeight: 500 }}>Low {formatNumber(low)}</span>
        </div>
      </div>

      <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '18px 16px', marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: '#8e8e93', fontWeight: 500, marginBottom: 10, letterSpacing: '-0.01em' }}>Last 24 Hours</div>
        <div style={{ display: 'flex', gap: 20 }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#af52de', letterSpacing: '-0.03em', lineHeight: '32px' }}>+{formatNumber(stats.growth.memories_24h)}</div>
            <div style={{ fontSize: 12, color: '#48484a', marginTop: 2 }}>memories</div>
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#007aff', letterSpacing: '-0.03em', lineHeight: '32px' }}>+{formatNumber(stats.growth.facts_24h)}</div>
            <div style={{ fontSize: 12, color: '#48484a', marginTop: 2 }}>facts</div>
          </div>
        </div>
      </div>

      <div style={{ background: '#1c1c1e', borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ fontSize: 13, color: '#8e8e93', fontWeight: 500, padding: '14px 16px 8px', letterSpacing: '-0.01em' }}>By Type</div>
        {Object.entries(stats.facts_by_type).sort(([, a], [, b]) => b - a).map(([type, count], i, arr) => (
          <div key={type} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px',
            borderBottom: i < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
            <span style={{ fontSize: 15, color: '#f2f2f7', textTransform: 'capitalize', letterSpacing: '-0.01em' }}>{type}</span>
            <span style={{ fontSize: 15, color: '#48484a', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div style={{ background: '#1c1c1e', borderRadius: 14, padding: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 14, lineHeight: 1 }}>{icon}</span>
        <span style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500, letterSpacing: '-0.01em' }}>{label}</span>
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.03em', lineHeight: '32px', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function StaleTab({ facts, onReinforce, onRetire }: { facts: CortexStaleFact[]; onReinforce: (id: number) => void; onRetire: (id: number) => void }) {
  if (facts.length === 0) return (
    <div style={{ textAlign: 'center', padding: '60px 24px' }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>✨</div>
      <div style={{ color: '#636366', fontSize: 15, lineHeight: '21px', letterSpacing: '-0.01em' }}>No stale facts. Memory is healthy.</div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 13, color: '#636366', marginBottom: 14, lineHeight: '19px', letterSpacing: '-0.01em' }}>
        Facts losing confidence. Reinforce to keep, retire to dismiss.
      </div>
      {facts.map((item) => {
        const pct = (item.fact.Confidence * 100).toFixed(0);
        const color = item.fact.Confidence > 0.5 ? '#ff9f0a' : '#ff453a';
        return (
          <div key={item.fact.ID} style={{ background: '#1c1c1e', borderRadius: 14, padding: '16px', marginBottom: 10 }}>
            <div style={{ fontSize: 15, color: '#f2f2f7', marginBottom: 10, lineHeight: '21px', letterSpacing: '-0.01em' }}>
              {item.fact.Subject} {item.fact.Predicate} {item.fact.Object}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
              <span style={{ fontSize: 12, color: '#3a3a3c' }}>·</span>
              <span style={{ fontSize: 12, color: '#48484a', textTransform: 'capitalize' }}>{item.fact.FactType}</span>
            </div>
            <div style={{ height: 6, background: '#2c2c2e', borderRadius: 3, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${item.fact.Confidence * 100}%`, background: color, borderRadius: 3 }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <button onClick={() => onReinforce(item.fact.ID)} style={{
                padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(52, 199, 89, 0.1)',
                color: '#34c759', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
              }}>Reinforce</button>
              <button onClick={() => onRetire(item.fact.ID)} style={{
                padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(142, 142, 147, 0.1)',
                color: '#8e8e93', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
              }}>Retire</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ConflictsTab({ conflicts, onResolve }: { conflicts: CortexConflict[]; onResolve: (keep: number, sup: number) => void }) {
  if (conflicts.length === 0) return (
    <div style={{ textAlign: 'center', padding: '60px 24px' }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>✅</div>
      <div style={{ color: '#636366', fontSize: 15, lineHeight: '21px', letterSpacing: '-0.01em' }}>No conflicts detected.</div>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 13, color: '#636366', marginBottom: 14, lineHeight: '19px', letterSpacing: '-0.01em' }}>
        Contradicting facts. Tap to keep the correct one.
      </div>
      {conflicts.map((c, i) => (
        <div key={`${c.fact1.ID}-${c.fact2.ID}`} style={{ background: '#1c1c1e', borderRadius: 14, padding: '18px 16px', marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: '#ff453a', fontWeight: 600, marginBottom: 14 }}>Conflict {i + 1}</div>
          <FactBox label="A" text={`${c.fact1.Subject} ${c.fact1.Predicate} ${c.fact1.Object}`} confidence={c.fact1.Confidence} type={c.fact1.FactType} />
          <div style={{ textAlign: 'center', fontSize: 12, color: '#3a3a3c', margin: '6px 0', fontWeight: 500 }}>vs</div>
          <FactBox label="B" text={`${c.fact2.Subject} ${c.fact2.Predicate} ${c.fact2.Object}`} confidence={c.fact2.Confidence} type={c.fact2.FactType} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 14 }}>
            <button onClick={() => onResolve(c.fact1.ID, c.fact2.ID)} style={{
              padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(0, 122, 255, 0.1)',
              color: '#007aff', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            }}>Keep A</button>
            <button onClick={() => onResolve(c.fact2.ID, c.fact1.ID)} style={{
              padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(0, 122, 255, 0.1)',
              color: '#007aff', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            }}>Keep B</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function FactBox({ label, text, confidence, type }: { label: string; text: string; confidence: number; type: string }) {
  return (
    <div style={{ background: '#2c2c2e', borderRadius: 12, padding: '14px' }}>
      <div style={{ fontSize: 11, color: '#636366', fontWeight: 600, marginBottom: 6, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: 15, color: '#f2f2f7', lineHeight: '21px', letterSpacing: '-0.01em' }}>{text}</div>
      <div style={{ fontSize: 12, color: '#48484a', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{(confidence * 100).toFixed(0)}% · {type}</div>
    </div>
  );
}
