'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { X, Loader2, Brain, ArrowUp, Trash2, Sparkles, CheckCircle2, AlertTriangle, Database, HardDrive, BarChart3, TrendingUp } from 'lucide-react';
import type { CortexHealthSummary, CortexConflict, CortexStaleFact } from '@/lib/cortex/types';

interface MemoryHealthProps { visible: boolean; onClose: () => void }

function formatBytes(b: number) { return b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(0)}KB` : `${(b / 1048576).toFixed(1)}MB`; }
function formatNumber(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }

export default function MemoryHealth({ visible, onClose }: MemoryHealthProps) {
  const [health, setHealth] = useState<CortexHealthSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'stale' | 'conflicts'>('overview');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try { setHealth(await (await fetch('/api/mobile/cortex/health')).json()); }
    catch { setHealth(null); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (visible) fetchHealth(); }, [visible, fetchHealth]);

  const resolve = useCallback(async (action: string, factId: number, supersededId?: number) => {
    try { await fetch('/api/mobile/cortex/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, factId, supersededId }) }); fetchHealth(); } catch {}
  }, [fetchHealth]);

  if (!visible) return null;
  const stats = health?.stats;
  const staleCount = health?.staleFacts?.length ?? 0;
  const conflictCount = health?.conflicts?.length ?? 0;
  const tabs = [
    { key: 'overview' as const, label: 'Overview' },
    { key: 'stale' as const, label: 'Stale', count: staleCount, color: '#b45309' },
    { key: 'conflicts' as const, label: 'Conflicts', count: conflictCount, color: '#dc2626' },
  ];

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'linear-gradient(180deg, #fbfcff 0%, #f5f7fb 100%)',
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '60px 20px 14px' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111827', letterSpacing: '-0.02em', margin: 0 }}>Memory Health</h2>
        <button onClick={onClose} aria-label="Close" style={{
          background: 'rgba(15, 23, 42, 0.05)', border: 'none', borderRadius: 12,
          width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#64748b', cursor: 'pointer', minWidth: 44, minHeight: 44,
        }}><X size={16} strokeWidth={2.2} /></button>
      </div>

      {/* Segmented control */}
      <div style={{ display: 'flex', margin: '0 20px 2px', background: 'rgba(15, 23, 42, 0.04)', borderRadius: 10, padding: 3 }}>
        {tabs.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
            flex: 1, padding: '8px 0',
            background: activeTab === tab.key ? '#ffffff' : 'transparent',
            border: activeTab === tab.key ? '1px solid rgba(15, 23, 42, 0.06)' : '1px solid transparent',
            borderRadius: 8, fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400,
            color: activeTab === tab.key ? '#111827' : '#5b6475',
            cursor: 'pointer', position: 'relative', transition: 'all 0.2s ease',
            boxShadow: activeTab === tab.key ? '0 1px 3px rgba(15, 23, 42, 0.06)' : 'none',
          }}>
            {tab.label}
            {(tab.count ?? 0) > 0 && <span style={{
              position: 'absolute', top: 3, right: '12%', fontSize: 9, fontWeight: 700,
              lineHeight: '14px', background: tab.color, color: '#fff',
              borderRadius: 7, padding: '0 5px', minWidth: 14, textAlign: 'center',
            }}>{tab.count}</span>}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 32px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={24} strokeWidth={2} style={{ margin: '0 auto 16px', color: '#2563eb', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: '#5b6475', fontSize: 14 }}>Loading…</div>
          </div>
        )}
        {!loading && !health?.available && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <Brain size={44} strokeWidth={1.2} style={{ color: '#cbd5e1', margin: '0 auto 16px', display: 'block' }} />
            <div style={{ color: '#111827', fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Cortex Not Installed</div>
            <div style={{ color: '#5b6475', fontSize: 14, lineHeight: '20px' }}>{health?.error ?? 'Install Cortex to enable persistent memory.'}</div>
          </div>
        )}
        {!loading && health?.available && activeTab === 'overview' && stats && <OverviewTab stats={stats} />}
        {!loading && health?.available && activeTab === 'stale' && <StaleTab facts={health.staleFacts} onReinforce={(id) => resolve('reinforce', id)} onRetire={(id) => resolve('retire', id)} />}
        {!loading && health?.available && activeTab === 'conflicts' && <ConflictsTab conflicts={health.conflicts} onResolve={(keep, sup) => resolve('supersede', keep, sup)} />}
      </div>
    </div>
  );
}

function OverviewTab({ stats }: { stats: CortexHealthSummary['stats'] }) {
  const { high, medium, low } = stats.confidence_distribution;
  const total = stats.facts || 1;
  const highPct = (high / total) * 100, medPct = (medium / total) * 100;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        <MetricCard label="Facts" value={formatNumber(stats.facts)} icon={<Database size={16} strokeWidth={1.8} />} color="#2563eb" />
        <MetricCard label="Memories" value={formatNumber(stats.memories)} icon={<Brain size={16} strokeWidth={1.8} />} color="#7c3aed" />
        <MetricCard label="Storage" value={formatBytes(stats.storage_bytes)} icon={<HardDrive size={16} strokeWidth={1.8} />} color="#0891b2" />
        <MetricCard label="Confidence" value={`${(stats.avg_confidence * 100).toFixed(0)}%`} icon={<BarChart3 size={16} strokeWidth={1.8} />} color="#059669" />
      </div>

      <div style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, padding: '18px 16px', marginBottom: 14, backdropFilter: 'blur(12px)' }}>
        <div style={{ fontSize: 13, color: '#5b6475', fontWeight: 500, marginBottom: 12 }}>Confidence Distribution</div>
        <div style={{ display: 'flex', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 12, background: 'rgba(15,23,42,0.06)' }}>
          <div style={{ width: `${highPct}%`, background: '#059669', transition: 'width 0.5s ease' }} />
          <div style={{ width: `${medPct}%`, background: '#b45309', transition: 'width 0.5s ease' }} />
          <div style={{ width: `${100 - highPct - medPct}%`, background: '#dc2626', transition: 'width 0.5s ease' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
          <span style={{ color: '#059669', fontWeight: 500 }}>High {formatNumber(high)}</span>
          <span style={{ color: '#b45309', fontWeight: 500 }}>Med {formatNumber(medium)}</span>
          <span style={{ color: '#dc2626', fontWeight: 500 }}>Low {formatNumber(low)}</span>
        </div>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, padding: '18px 16px', marginBottom: 14, backdropFilter: 'blur(12px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
          <TrendingUp size={14} strokeWidth={1.8} style={{ color: '#2563eb' }} />
          <span style={{ fontSize: 13, color: '#5b6475', fontWeight: 500 }}>Last 24 Hours</span>
        </div>
        <div style={{ display: 'flex', gap: 20 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#7c3aed', letterSpacing: '-0.03em', lineHeight: '30px' }}>+{formatNumber(stats.growth.memories_24h)}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>memories</div>
          </div>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#2563eb', letterSpacing: '-0.03em', lineHeight: '30px' }}>+{formatNumber(stats.growth.facts_24h)}</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>facts</div>
          </div>
        </div>
      </div>

      <div style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' }}>
        <div style={{ fontSize: 13, color: '#5b6475', fontWeight: 500, padding: '14px 16px 8px' }}>By Type</div>
        {Object.entries(stats.facts_by_type).sort(([, a], [, b]) => b - a).map(([type, count], i, arr) => (
          <div key={type} style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px',
            borderBottom: i < arr.length - 1 ? '1px solid rgba(15,23,42,0.05)' : 'none',
          }}>
            <span style={{ fontSize: 14, color: '#111827', textTransform: 'capitalize' }}>{type}</span>
            <span style={{ fontSize: 14, color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{formatNumber(count)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, padding: '16px', backdropFilter: 'blur(12px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <span style={{ color }}>{icon}</span>
        <span style={{ fontSize: 12, color: '#5b6475', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: '#111827', letterSpacing: '-0.03em', lineHeight: '30px', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function StaleTab({ facts, onReinforce, onRetire }: { facts: CortexStaleFact[]; onReinforce: (id: number) => void; onRetire: (id: number) => void }) {
  if (facts.length === 0) return (
    <div style={{ textAlign: 'center', padding: '60px 24px' }}>
      <Sparkles size={40} strokeWidth={1.2} style={{ color: '#059669', margin: '0 auto 16px', display: 'block' }} />
      <div style={{ color: '#5b6475', fontSize: 15 }}>No stale facts. Memory is healthy.</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 13, color: '#5b6475', marginBottom: 14, lineHeight: '19px' }}>
        Facts losing confidence. Reinforce to keep, retire to dismiss.
      </div>
      {facts.map((item) => {
        const pct = (item.fact.Confidence * 100).toFixed(0);
        const color = item.fact.Confidence > 0.5 ? '#b45309' : '#dc2626';
        return (
          <div key={item.fact.ID} style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, padding: '16px', marginBottom: 10, backdropFilter: 'blur(12px)' }}>
            <div style={{ fontSize: 14, color: '#111827', marginBottom: 10, lineHeight: '20px' }}>
              {item.fact.Subject} {item.fact.Predicate} {item.fact.Object}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, color, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
              <span style={{ fontSize: 12, color: '#cbd5e1' }}>·</span>
              <span style={{ fontSize: 12, color: '#94a3b8', textTransform: 'capitalize' }}>{item.fact.FactType}</span>
            </div>
            <div style={{ height: 4, background: 'rgba(15,23,42,0.06)', borderRadius: 2, marginBottom: 14, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${item.fact.Confidence * 100}%`, background: color, borderRadius: 2 }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button onClick={() => onReinforce(item.fact.ID)} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(5,150,105,0.15)',
                background: 'rgba(5,150,105,0.06)', color: '#059669',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}><ArrowUp size={14} /> Reinforce</button>
              <button onClick={() => onRetire(item.fact.ID)} style={{
                padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15,23,42,0.08)',
                background: 'rgba(15,23,42,0.03)', color: '#64748b',
                fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              }}><Trash2 size={14} /> Retire</button>
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
      <CheckCircle2 size={40} strokeWidth={1.2} style={{ color: '#059669', margin: '0 auto 16px', display: 'block' }} />
      <div style={{ color: '#5b6475', fontSize: 15 }}>No conflicts detected.</div>
    </div>
  );
  return (
    <div>
      <div style={{ fontSize: 13, color: '#5b6475', marginBottom: 14 }}>Contradicting facts. Tap to keep the correct one.</div>
      {conflicts.map((c, i) => (
        <div key={`${c.fact1.ID}-${c.fact2.ID}`} style={{ background: 'rgba(255,255,255,0.82)', border: '1px solid rgba(15,23,42,0.08)', borderRadius: 16, padding: '18px 16px', marginBottom: 12, backdropFilter: 'blur(12px)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#dc2626', fontWeight: 600, marginBottom: 14 }}>
            <AlertTriangle size={14} /> Conflict {i + 1}
          </div>
          <FactBox label="A" text={`${c.fact1.Subject} ${c.fact1.Predicate} ${c.fact1.Object}`} confidence={c.fact1.Confidence} type={c.fact1.FactType} />
          <div style={{ textAlign: 'center', fontSize: 12, color: '#cbd5e1', margin: '6px 0', fontWeight: 500 }}>vs</div>
          <FactBox label="B" text={`${c.fact2.Subject} ${c.fact2.Predicate} ${c.fact2.Object}`} confidence={c.fact2.Confidence} type={c.fact2.FactType} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 14 }}>
            <button onClick={() => onResolve(c.fact1.ID, c.fact2.ID)} style={{
              padding: '10px 0', borderRadius: 12, border: '1px solid rgba(37,99,235,0.15)',
              background: 'rgba(37,99,235,0.06)', color: '#2563eb',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            }}>Keep A</button>
            <button onClick={() => onResolve(c.fact2.ID, c.fact1.ID)} style={{
              padding: '10px 0', borderRadius: 12, border: '1px solid rgba(37,99,235,0.15)',
              background: 'rgba(37,99,235,0.06)', color: '#2563eb',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
            }}>Keep B</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function FactBox({ label, text, confidence, type }: { label: string; text: string; confidence: number; type: string }) {
  return (
    <div style={{ background: 'rgba(15,23,42,0.03)', borderRadius: 12, padding: '14px', border: '1px solid rgba(15,23,42,0.05)' }}>
      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, marginBottom: 6, letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: 14, color: '#111827', lineHeight: '20px' }}>{text}</div>
      <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{(confidence * 100).toFixed(0)}% · {type}</div>
    </div>
  );
}
