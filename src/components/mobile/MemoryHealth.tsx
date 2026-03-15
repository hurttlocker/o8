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
  const [activeSection, setActiveSection] = useState<'overview' | 'stale' | 'conflicts'>('overview');

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mobile/cortex/health');
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) fetchHealth();
  }, [visible, fetchHealth]);

  const handleResolveConflict = useCallback(async (keepId: number, supersededId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'supersede', factId: keepId, supersededId }),
      });
      // Refresh after resolution
      fetchHealth();
    } catch { /* non-critical */ }
  }, [fetchHealth]);

  const handleReinforce = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reinforce', factId }),
      });
      fetchHealth();
    } catch { /* non-critical */ }
  }, [fetchHealth]);

  const handleRetire = useCallback(async (factId: number) => {
    try {
      await fetch('/api/mobile/cortex/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', factId }),
      });
      fetchHealth();
    } catch { /* non-critical */ }
  }, [fetchHealth]);

  if (!visible) return null;

  const stats = health?.stats;
  const staleCount = health?.staleFacts?.length ?? 0;
  const conflictCount = health?.conflicts?.length ?? 0;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      background: '#000000',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '56px 16px 12px',
        borderBottom: '1px solid #1c1c1e',
      }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
          🧠 Memory Health
        </span>
        <button
          onClick={onClose}
          style={{
            background: '#2c2c2e', border: 'none', borderRadius: 20,
            width: 28, height: 28, display: 'flex', alignItems: 'center',
            justifyContent: 'center', color: '#8e8e93', fontSize: 16, cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #1c1c1e' }}>
        {(['overview', 'stale', 'conflicts'] as const).map((section) => (
          <button
            key={section}
            onClick={() => setActiveSection(section)}
            style={{
              flex: 1, padding: '10px 0', background: 'none', border: 'none',
              fontSize: 13, fontWeight: activeSection === section ? 600 : 400,
              color: activeSection === section ? '#ffffff' : '#636366',
              borderBottom: activeSection === section ? '2px solid #af52de' : '2px solid transparent',
              cursor: 'pointer',
              position: 'relative',
            }}
          >
            {section === 'overview' ? 'Overview' : section === 'stale' ? 'Stale' : 'Conflicts'}
            {section === 'stale' && staleCount > 0 && (
              <span style={{
                position: 'absolute', top: 6, right: '20%',
                fontSize: 9, fontWeight: 700, background: '#ff9f0a', color: '#000',
                borderRadius: 8, padding: '1px 5px', minWidth: 14, textAlign: 'center',
              }}>
                {staleCount}
              </span>
            )}
            {section === 'conflicts' && conflictCount > 0 && (
              <span style={{
                position: 'absolute', top: 6, right: '15%',
                fontSize: 9, fontWeight: 700, background: '#ff3b30', color: '#fff',
                borderRadius: 8, padding: '1px 5px', minWidth: 14, textAlign: 'center',
              }}>
                {conflictCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#636366', fontSize: 13 }}>
            Loading memory health…
          </div>
        )}

        {!loading && !health?.available && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🧠</div>
            <div style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              Cortex Not Installed
            </div>
            <div style={{ color: '#636366', fontSize: 13, lineHeight: '18px' }}>
              {health?.error ?? 'Install Cortex to enable persistent memory across agent sessions.'}
            </div>
          </div>
        )}

        {!loading && health?.available && activeSection === 'overview' && stats && (
          <OverviewSection stats={stats} />
        )}

        {!loading && health?.available && activeSection === 'stale' && (
          <StaleSection
            facts={health.staleFacts}
            onReinforce={handleReinforce}
            onRetire={handleRetire}
          />
        )}

        {!loading && health?.available && activeSection === 'conflicts' && (
          <ConflictsSection
            conflicts={health.conflicts}
            onResolve={handleResolveConflict}
          />
        )}
      </div>
    </div>
  );
}

// ── Overview ──

function OverviewSection({ stats }: { stats: CortexHealthSummary['stats'] }) {
  const totalFacts = stats.facts;
  const { high, medium, low } = stats.confidence_distribution;
  const highPct = totalFacts > 0 ? (high / totalFacts) * 100 : 0;
  const medPct = totalFacts > 0 ? (medium / totalFacts) * 100 : 0;

  return (
    <div>
      {/* Hero metrics */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
        <MetricCard label="Facts" value={formatNumber(stats.facts)} color="#af52de" />
        <MetricCard label="Memories" value={formatNumber(stats.memories)} color="#007aff" />
        <MetricCard label="Storage" value={formatBytes(stats.storage_bytes)} color="#5ac8fa" />
        <MetricCard label="Avg Confidence" value={`${(stats.avg_confidence * 100).toFixed(0)}%`} color="#34c759" />
      </div>

      {/* Confidence distribution bar */}
      <div style={{
        background: '#1c1c1e', borderRadius: 12, padding: '14px 16px', marginBottom: 12,
      }}>
        <div style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500, marginBottom: 8 }}>
          Confidence Distribution
        </div>
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ width: `${highPct}%`, background: '#34c759' }} />
          <div style={{ width: `${medPct}%`, background: '#ff9f0a' }} />
          <div style={{ width: `${100 - highPct - medPct}%`, background: '#ff3b30' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
          <span style={{ color: '#34c759' }}>● High {formatNumber(high)}</span>
          <span style={{ color: '#ff9f0a' }}>● Medium {formatNumber(medium)}</span>
          <span style={{ color: '#ff3b30' }}>● Low {formatNumber(low)}</span>
        </div>
      </div>

      {/* Growth */}
      <div style={{
        background: '#1c1c1e', borderRadius: 12, padding: '14px 16px', marginBottom: 12,
      }}>
        <div style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500, marginBottom: 8 }}>
          Growth (Last 24h)
        </div>
        <div style={{ display: 'flex', gap: 16, fontSize: 13 }}>
          <div>
            <span style={{ color: '#af52de', fontWeight: 600 }}>+{formatNumber(stats.growth.memories_24h)}</span>
            <span style={{ color: '#636366' }}> memories</span>
          </div>
          <div>
            <span style={{ color: '#007aff', fontWeight: 600 }}>+{formatNumber(stats.growth.facts_24h)}</span>
            <span style={{ color: '#636366' }}> facts</span>
          </div>
        </div>
      </div>

      {/* Fact types breakdown */}
      <div style={{
        background: '#1c1c1e', borderRadius: 12, padding: '14px 16px',
      }}>
        <div style={{ fontSize: 12, color: '#8e8e93', fontWeight: 500, marginBottom: 8 }}>
          Fact Types
        </div>
        {Object.entries(stats.facts_by_type)
          .sort(([, a], [, b]) => b - a)
          .map(([type, count]) => (
            <div key={type} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 0', fontSize: 13,
            }}>
              <span style={{ color: '#e5e5ea', textTransform: 'capitalize' }}>{type}</span>
              <span style={{ color: '#636366', fontVariantNumeric: 'tabular-nums' }}>
                {formatNumber(count)}
              </span>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Metric Card ──

function MetricCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{
      background: '#1c1c1e', borderRadius: 12, padding: '14px 16px',
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ fontSize: 11, color: '#8e8e93', fontWeight: 500, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.03em' }}>
        {value}
      </div>
    </div>
  );
}

// ── Stale Section ──

function StaleSection({
  facts,
  onReinforce,
  onRetire,
}: {
  facts: CortexStaleFact[];
  onReinforce: (id: number) => void;
  onRetire: (id: number) => void;
}) {
  if (facts.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>✨</div>
        <div style={{ color: '#636366', fontSize: 13 }}>
          No stale facts. Memory is healthy.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#8e8e93', marginBottom: 12 }}>
        These facts are losing confidence over time. Reinforce to keep, retire to dismiss.
      </div>
      {facts.map((item) => (
        <div key={item.fact.ID} style={{
          background: '#1c1c1e', borderRadius: 12, padding: '14px 16px',
          marginBottom: 8, borderLeft: '3px solid #ff9f0a',
        }}>
          <div style={{ fontSize: 13, color: '#e5e5ea', marginBottom: 8, lineHeight: '18px' }}>
            {item.fact.Subject} {item.fact.Predicate} {item.fact.Object}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: '#ff9f0a' }}>
              {(item.fact.Confidence * 100).toFixed(0)}% confidence
            </span>
            <span style={{ fontSize: 11, color: '#636366' }}>
              {item.fact.FactType}
            </span>
          </div>
          {/* Confidence bar */}
          <div style={{ height: 3, background: '#2c2c2e', borderRadius: 2, marginBottom: 10 }}>
            <div style={{
              height: '100%', width: `${item.fact.Confidence * 100}%`,
              background: item.fact.Confidence > 0.5 ? '#ff9f0a' : '#ff3b30',
              borderRadius: 2,
            }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              onClick={() => onReinforce(item.fact.ID)}
              style={{
                padding: '8px 0', borderRadius: 8, border: 'none',
                background: 'rgba(52, 199, 89, 0.12)', color: '#34c759',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Reinforce
            </button>
            <button
              onClick={() => onRetire(item.fact.ID)}
              style={{
                padding: '8px 0', borderRadius: 8, border: 'none',
                background: 'rgba(142, 142, 147, 0.12)', color: '#8e8e93',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Retire
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Conflicts Section ──

function ConflictsSection({
  conflicts,
  onResolve,
}: {
  conflicts: CortexConflict[];
  onResolve: (keepId: number, supersededId: number) => void;
}) {
  if (conflicts.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>✅</div>
        <div style={{ color: '#636366', fontSize: 13 }}>
          No conflicting facts detected.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: '#8e8e93', marginBottom: 12 }}>
        These facts contradict each other. Pick the correct one.
      </div>
      {conflicts.map((conflict, i) => (
        <div key={`${conflict.fact1.ID}-${conflict.fact2.ID}`} style={{
          background: '#1c1c1e', borderRadius: 12, padding: '14px 16px',
          marginBottom: 12, borderLeft: '3px solid #ff3b30',
        }}>
          <div style={{ fontSize: 11, color: '#ff3b30', fontWeight: 600, marginBottom: 10 }}>
            ⚠️ Conflict #{i + 1}
          </div>

          {/* Fact A */}
          <div style={{
            background: '#2c2c2e', borderRadius: 8, padding: '10px 12px', marginBottom: 8,
          }}>
            <div style={{ fontSize: 11, color: '#8e8e93', marginBottom: 4 }}>Fact A</div>
            <div style={{ fontSize: 13, color: '#e5e5ea', lineHeight: '18px' }}>
              {conflict.fact1.Subject} {conflict.fact1.Predicate} {conflict.fact1.Object}
            </div>
            <div style={{ fontSize: 11, color: '#636366', marginTop: 4 }}>
              {(conflict.fact1.Confidence * 100).toFixed(0)}% · {conflict.fact1.FactType}
            </div>
          </div>

          {/* vs */}
          <div style={{ textAlign: 'center', fontSize: 11, color: '#636366', margin: '4px 0' }}>vs</div>

          {/* Fact B */}
          <div style={{
            background: '#2c2c2e', borderRadius: 8, padding: '10px 12px', marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, color: '#8e8e93', marginBottom: 4 }}>Fact B</div>
            <div style={{ fontSize: 13, color: '#e5e5ea', lineHeight: '18px' }}>
              {conflict.fact2.Subject} {conflict.fact2.Predicate} {conflict.fact2.Object}
            </div>
            <div style={{ fontSize: 11, color: '#636366', marginTop: 4 }}>
              {(conflict.fact2.Confidence * 100).toFixed(0)}% · {conflict.fact2.FactType}
            </div>
          </div>

          {/* Resolution buttons */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button
              onClick={() => onResolve(conflict.fact1.ID, conflict.fact2.ID)}
              style={{
                padding: '8px 0', borderRadius: 8, border: 'none',
                background: 'rgba(0, 122, 255, 0.12)', color: '#007aff',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Keep A
            </button>
            <button
              onClick={() => onResolve(conflict.fact2.ID, conflict.fact1.ID)}
              style={{
                padding: '8px 0', borderRadius: 8, border: 'none',
                background: 'rgba(0, 122, 255, 0.12)', color: '#007aff',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Keep B
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
