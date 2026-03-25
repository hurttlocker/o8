'use client';

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import type { RecallCard } from '@/lib/cortex/types';

interface MemoryStats {
  total_memories: number;
  total_facts: number;
  active_facts: number;
  retired_facts: number;
  db_size_mb: number;
}

interface MemoryPageProps {
  onBack: () => void;
  onInjectText?: (text: string) => void;
}

function classColor(cls: string): string {
  switch (cls) {
    case 'rule': return '#007aff';
    case 'identity': return '#34c759';
    case 'preference': return '#ff9f0a';
    case 'decision': return '#af52de';
    case 'fact': return '#5ac8fa';
    default: return '#8e8e93';
  }
}

const FactRow = memo(function FactRow({ fact, onInject }: { fact: RecallCard; onInject?: (text: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const source = fact.evidence[0]?.sourceFile ?? fact.sourceTier;
  const factColor = classColor(fact.factType);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(e) => { setExpanded(!expanded); e.preventDefault(); }}
      style={{
        padding: '10px 12px',
        borderRadius: 12,
        background: 'rgba(0,122,255,0.04)',
        border: '1px solid rgba(0,122,255,0.08)',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
        transition: 'background 150ms ease',
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: factColor,
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: factColor,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {fact.factType}
        </span>
        {fact.promptEligible ? (
          <span style={{
            fontSize: 10,
            color: '#2563eb',
            background: 'rgba(37,99,235,0.08)',
            borderRadius: 999,
            padding: '2px 6px',
          }}>
            prompt
          </span>
        ) : null}
        <span style={{ fontSize: 10, color: '#8e8e93', marginLeft: 'auto' }}>
          {fact.evidenceCount} evidence
        </span>
        <span style={{
          fontSize: 9, color: '#8e8e93',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {Math.round(fact.relevance * 100)}%
        </span>
      </div>

      {/* Content */}
      <p style={{
        margin: 0, fontSize: 13, lineHeight: 1.4,
        color: '#1c1c1e',
        fontFamily: '-apple-system, system-ui, sans-serif',
        display: '-webkit-box',
        WebkitLineClamp: expanded ? 999 : 3,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {fact.text}
      </p>

      {/* Expanded: source + actions */}
      {expanded ? (
        <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
          <div style={{
            fontSize: 10, color: '#636366',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {source}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 10, color: '#5b6475' }}>{fact.sourceTier}</span>
            <span style={{ fontSize: 10, color: '#5b6475' }}>{fact.memoryKind}</span>
            <span style={{ fontSize: 10, color: '#5b6475' }}>{fact.retrievalVisibility}</span>
          </div>
          {fact.reasons.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {fact.reasons.map((reason) => (
                <span key={reason} style={{
                  fontSize: 10,
                  color: '#5b6475',
                  padding: '3px 7px',
                  borderRadius: 999,
                  background: 'rgba(15, 23, 42, 0.04)',
                }}>
                  {reason.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : null}
          {onInject ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onInject(fact.text); }}
              onTouchEnd={(e) => { e.stopPropagation(); e.preventDefault(); onInject(fact.text); }}
              style={{
                fontSize: 11, fontWeight: 600,
                color: '#007aff',
                background: 'rgba(0,122,255,0.08)',
                border: '1px solid rgba(0,122,255,0.15)',
                borderRadius: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              Inject
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export default function MemoryPage({ onBack, onInjectText }: MemoryPageProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RecallCard[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'search' | 'recent' | 'health'>('recent');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch stats on mount
  useEffect(() => {
    fetch('/api/mobile/cortex/stats')
      .then(r => r.json())
      .then(d => setStats(d.stats ?? d))
      .catch(() => {});
  }, []);

  const loadRecent = useCallback(() => {
    setLoading(true);
    return fetch('/api/mobile/cortex/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'recent important decisions', limit: 10 }),
    })
      .then(r => r.json())
      .then(d => { setResults(d.cards ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  // Fetch recent on mount
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecent();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRecent]);

  const doSearch = useCallback((q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    fetch('/api/mobile/cortex/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, limit: 15 }),
    })
      .then(r => r.json())
      .then(d => { setResults(d.cards ?? []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSearch = useCallback((value: string) => {
    setQuery(value);
    setActiveTab('search');
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(value), 400);
  }, [doSearch]);

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'recent', label: 'Recent' },
    { key: 'search', label: 'Search' },
    { key: 'health', label: 'Health' },
  ];

  return (
    <div style={{
      padding: '0 12px 24px',
      width: '100%',
      boxSizing: 'border-box',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              padding: '6px 14px',
              borderRadius: 10,
              background: 'rgba(0,122,255,0.08)',
              border: '1px solid rgba(0,122,255,0.12)',
              color: '#007aff',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
          <h1 style={{
            fontSize: 28, fontWeight: 800,
            letterSpacing: '-0.03em',
            color: '#0a0a0a',
            fontFamily: '-apple-system, system-ui, sans-serif',
            margin: 0,
          }}>
            Memory
          </h1>
        </div>
        {stats ? (
          <div style={{
            display: 'flex', gap: 12,
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#007aff' }}>
                {(stats.total_memories / 1000).toFixed(1)}k
              </div>
              <div style={{ fontSize: 9, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                memories
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#34c759' }}>
                {(stats.active_facts / 1000).toFixed(1)}k
              </div>
              <div style={{ fontSize: 9, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                facts
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#8e8e93' }}>
                {stats.db_size_mb?.toFixed(0) ?? '?'}MB
              </div>
              <div style={{ fontSize: 9, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                size
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* Search bar */}
      <div style={{
        position: 'relative',
        marginBottom: 12,
      }}>
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search memories..."
          style={{
            width: '100%',
            padding: '10px 14px',
            borderRadius: 12,
            border: '1px solid rgba(0,122,255,0.12)',
            background: 'rgba(0,122,255,0.04)',
            fontSize: 14,
            color: '#1c1c1e',
            fontFamily: '-apple-system, system-ui, sans-serif',
            outline: 'none',
            boxSizing: 'border-box',
            WebkitAppearance: 'none',
          }}
        />
        {loading ? (
          <div style={{
            position: 'absolute', right: 12, top: '50%',
            transform: 'translateY(-50%)',
            width: 16, height: 16,
            border: '2px solid rgba(0,122,255,0.2)',
            borderTop: '2px solid #007aff',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
        ) : null}
      </div>

      {/* Tab bar — iOS segmented control */}
      <div style={{
        display: 'flex',
        background: 'rgba(0,122,255,0.06)',
        borderRadius: 10,
        padding: 2,
        marginBottom: 16,
      }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            onTouchEnd={(e) => { setActiveTab(tab.key); e.preventDefault(); }}
            style={{
              flex: 1,
              padding: '7px 0',
              borderRadius: 8,
              border: 'none',
              background: activeTab === tab.key ? 'rgba(255,255,255,0.9)' : 'transparent',
              color: activeTab === tab.key ? '#007aff' : '#8e8e93',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: '-apple-system, system-ui, sans-serif',
              WebkitTapHighlightColor: 'transparent',
              boxShadow: activeTab === tab.key ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
              transition: 'all 200ms ease',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Results list */}
      {activeTab !== 'health' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.length === 0 && !loading ? (
            <div style={{
              padding: 32, textAlign: 'center',
              color: '#8e8e93', fontSize: 14,
            }}>
              {activeTab === 'search' && query ? 'No results found' : 'Loading recent memories...'}
            </div>
          ) : null}
          {results.map((fact, i) => (
            <FactRow key={`${fact.factId}-${i}`} fact={fact} onInject={onInjectText} />
          ))}
        </div>
      ) : (
        /* Health tab */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {stats ? (
            <>
              <StatRow label="Total Memories" value={stats.total_memories.toLocaleString()} />
              <StatRow label="Total Facts" value={stats.total_facts.toLocaleString()} />
              <StatRow label="Active Facts" value={stats.active_facts.toLocaleString()} color="#34c759" />
              <StatRow label="Retired Facts" value={stats.retired_facts.toLocaleString()} color="#ff3b30" />
              <StatRow label="Database Size" value={`${stats.db_size_mb?.toFixed(1) ?? '?'} MB`} />
            </>
          ) : (
            <div style={{ padding: 32, textAlign: 'center', color: '#8e8e93' }}>
              Loading stats...
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '12px 14px',
      borderRadius: 12,
      background: 'rgba(0,122,255,0.04)',
      border: '1px solid rgba(0,122,255,0.08)',
    }}>
      <span style={{ fontSize: 14, color: '#3c3c43', fontFamily: '-apple-system, system-ui, sans-serif' }}>
        {label}
      </span>
      <span style={{
        fontSize: 16, fontWeight: 700,
        color: color ?? '#0a0a0a',
        fontFamily: '"SF Mono", ui-monospace, monospace',
      }}>
        {value}
      </span>
    </div>
  );
}
