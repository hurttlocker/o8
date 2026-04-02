'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { RecallCard } from '@/lib/cortex/types';
import { useTheme } from './ThemeContext';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

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
    case 'rule':
      return '#0a84ff';
    case 'identity':
      return '#30d158';
    case 'preference':
      return '#ff9f0a';
    case 'decision':
      return '#bf5af2';
    case 'fact':
      return '#64d2ff';
    default:
      return '#8e8e93';
  }
}

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

const FactRow = memo(function FactRow({
  fact,
  onInject,
}: {
  fact: RecallCard;
  onInject?: (text: string) => void;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const source = fact.evidence[0]?.sourceFile ?? fact.sourceTier;
  const factColor = classColor(fact.factType);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(event) => {
        setExpanded(!expanded);
        event.preventDefault();
      }}
      style={{
        padding: '12px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: factColor,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color: factColor,
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          {fact.factType}
        </span>
        {fact.promptEligible ? (
          <span
            style={{
              fontSize: 10,
              color: '#64d2ff',
              background: 'rgba(100,210,255,0.12)',
              border: '1px solid rgba(100,210,255,0.16)',
              borderRadius: 999,
              padding: '2px 6px',
            }}
          >
            prompt
          </span>
        ) : null}
        <span style={{ fontSize: 10, color: colors.textSecondary, marginLeft: 'auto' }}>
          {fact.evidenceCount} evidence
        </span>
        <span
          style={{
            fontSize: 9,
            color: colors.textSecondary,
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
        >
          {Math.round(fact.relevance * 100)}%
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.5,
          color: colors.text,
          display: '-webkit-box',
          WebkitLineClamp: expanded ? 999 : 3,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
      >
        {fact.text}
      </p>

      {expanded ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <div
            style={{
              fontSize: 10,
              color: colors.textTertiary,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {source}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span style={{ fontSize: 10, color: colors.textSecondary }}>{fact.sourceTier}</span>
            <span style={{ fontSize: 10, color: colors.textSecondary }}>{fact.memoryKind}</span>
            <span style={{ fontSize: 10, color: colors.textSecondary }}>{fact.retrievalVisibility}</span>
          </div>
          {fact.reasons.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {fact.reasons.map((reason) => (
                <span
                  key={reason}
                  style={{
                    fontSize: 10,
                    color: colors.textSecondary,
                    padding: '4px 8px',
                    borderRadius: 999,
                    background: 'rgba(255,255,255,0.05)',
                    border: `1px solid ${colors.border}`,
                  }}
                >
                  {reason.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          ) : null}
          {onInject ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onInject(fact.text);
              }}
              onTouchEnd={(event) => {
                event.stopPropagation();
                event.preventDefault();
                onInject(fact.text);
              }}
              style={{
                minHeight: 44,
                justifySelf: 'start',
                padding: '0 14px',
                borderRadius: 12,
                border: `1px solid ${colors.blueGlassBorder}`,
                background: colors.blueGlass,
                color: colors.blueAccent,
                fontSize: 12,
                fontWeight: 600,
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

function MetricCard({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  const { colors } = useTheme();

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        padding: '12px 10px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 700, color: valueColor ?? colors.text }}>{value}</div>
      <div
        style={{
          fontSize: 9,
          color: colors.textSecondary,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginTop: 4,
        }}
      >
        {label}
      </div>
    </div>
  );
}

function StatRow({ label, value, color }: { label: string; value: string; color?: string }) {
  const { colors } = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        padding: '13px 14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
      }}
    >
      <span style={{ fontSize: 14, color: colors.textSecondary }}>{label}</span>
      <span
        style={{
          fontSize: 16,
          fontWeight: 700,
          color: color ?? colors.text,
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}
      >
        {value}
      </span>
    </div>
  );
}

export default function MemoryPage({ onBack, onInjectText }: MemoryPageProps) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RecallCard[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'search' | 'recent' | 'health'>('recent');
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/mobile/cortex/stats')
      .then((response) => response.json())
      .then((data) => setStats(data.stats ?? data))
      .catch(() => {});
  }, []);

  const loadRecent = useCallback(() => {
    setLoading(true);
    return fetch('/api/mobile/cortex/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'recent important decisions', limit: 10 }),
    })
      .then((response) => response.json())
      .then((data) => {
        setResults(data.cards ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecent();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRecent]);

  const doSearch = useCallback((value: string) => {
    if (!value.trim()) return;
    setLoading(true);
    fetch('/api/mobile/cortex/recall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: value, limit: 15 }),
    })
      .then((response) => response.json())
      .then((data) => {
        setResults(data.cards ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSearch = useCallback(
    (value: string) => {
      setQuery(value);
      setActiveTab('search');
      if (searchTimeout.current) clearTimeout(searchTimeout.current);
      searchTimeout.current = setTimeout(() => doSearch(value), 400);
    },
    [doSearch]
  );

  const tabs: { key: 'recent' | 'search' | 'health'; label: string }[] = [
    { key: 'recent', label: 'Recent' },
    { key: 'search', label: 'Search' },
    { key: 'health', label: 'Health' },
  ];

  return (
    <div
      style={{
        padding: '0 12px 24px',
        width: '100%',
        boxSizing: 'border-box',
        background: colors.bg,
        minHeight: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
          <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', color: colors.text, margin: 0 }}>
            Memory
          </h1>
        </div>
      </div>

      {stats ? (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <MetricCard label="Memories" value={`${(stats.total_memories / 1000).toFixed(1)}k`} valueColor={colors.blueAccent} />
          <MetricCard label="Active Facts" value={`${(stats.active_facts / 1000).toFixed(1)}k`} valueColor="#30d158" />
          <MetricCard label="DB Size" value={`${stats.db_size_mb?.toFixed(0) ?? '?'}MB`} valueColor={colors.textSecondary} />
        </div>
      ) : null}

      <span style={sectionHeaderStyle(colors)}>Recall</span>
      <div style={{ position: 'relative', marginBottom: 12 }}>
        <input
          type="text"
          value={query}
          onChange={(event) => handleSearch(event.target.value)}
          placeholder="Search memories..."
          style={{
            width: '100%',
            minHeight: 48,
            padding: '0 14px',
            borderRadius: 14,
            border: `1px solid ${colors.cardBorder}`,
            background: colors.cardBg,
            fontSize: 14,
            color: colors.text,
            outline: 'none',
            boxSizing: 'border-box',
            WebkitAppearance: 'none',
          }}
        />
        {loading ? (
          <div
            style={{
              position: 'absolute',
              right: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              fontWeight: 600,
              color: colors.textSecondary,
            }}
          >
            Loading
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          marginBottom: 16,
        }}
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              onTouchEnd={(event) => {
                setActiveTab(tab.key);
                event.preventDefault();
              }}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                background: active ? colors.blueGlass : 'transparent',
                color: active ? colors.text : colors.textSecondary,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab !== 'health' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {results.length === 0 && !loading ? (
            <div
              style={{
                padding: '32px 20px',
                textAlign: 'center',
                color: colors.textSecondary,
                fontSize: 14,
                borderRadius: 14,
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              {activeTab === 'search' && query ? 'No results found' : 'Loading recent memories...'}
            </div>
          ) : null}
          {results.map((fact, index) => (
            <FactRow key={`${fact.factId}-${index}`} fact={fact} onInject={onInjectText} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span style={sectionHeaderStyle(colors)}>Health</span>
          {stats ? (
            <>
              <StatRow label="Total Memories" value={stats.total_memories.toLocaleString()} />
              <StatRow label="Total Facts" value={stats.total_facts.toLocaleString()} />
              <StatRow label="Active Facts" value={stats.active_facts.toLocaleString()} color="#30d158" />
              <StatRow label="Retired Facts" value={stats.retired_facts.toLocaleString()} color="#ff453a" />
              <StatRow label="Database Size" value={`${stats.db_size_mb?.toFixed(1) ?? '?'} MB`} />
            </>
          ) : (
            <div
              style={{
                padding: '32px 20px',
                textAlign: 'center',
                color: colors.textSecondary,
                borderRadius: 14,
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              Loading stats...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
