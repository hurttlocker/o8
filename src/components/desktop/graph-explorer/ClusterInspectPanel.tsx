'use client';

import { ArrowUpIcon, RefreshIcon, TrashIcon } from './icons';
import type { ClusterData, SearchResult } from './types';

interface ClusterInspectPanelProps {
  cluster: ClusterData;
  searchResults: SearchResult[];
  onClose: () => void;
}

export function ClusterInspectPanel({ cluster, searchResults, onClose }: ClusterInspectPanelProps) {
  const actions = [
    { Icon: RefreshIcon, label: 'Reinforce All', color: '#22c55e' },
    { Icon: TrashIcon, label: 'Retire Stale', color: '#ef4444' },
    { Icon: ArrowUpIcon, label: 'Supersede', color: '#f59e0b' },
  ];
  const matchingFacts = searchResults.filter(r => r.type === cluster.type);

  return (
    <div
      style={{
        position: 'absolute',
        top: 60,
        right: 14,
        width: 280,
        maxHeight: 'calc(100% - 120px)',
        overflowY: 'auto',
        paddingTop: 16,
        paddingRight: 18,
        paddingBottom: 16,
        paddingLeft: 18,
        borderRadius: 14,
        background: 'rgba(9, 9, 11, 0.95)',
        backdropFilter: 'blur(20px)',
        border: `1px solid ${cluster.color}30`,
        boxShadow: `0 8px 40px rgba(0,0,0,0.4), 0 0 30px ${cluster.color}10`,
      }}
    >
      <button type="button" onClick={onClose} style={{
        position: 'absolute', top: 10, right: 10, width: 24, height: 24, borderRadius: 12,
        border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(148,163,184,0.08)',
        color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12,
      }}>✕</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, background: cluster.color, boxShadow: `0 0 10px ${cluster.color}60` }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{cluster.label}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        <div style={{ padding: 8, borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: cluster.color, fontFamily: '"SF Mono", monospace' }}>
            {cluster.factCount.toLocaleString()}
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>Facts</div>
        </div>
        <div style={{ padding: 8, borderRadius: 8, background: 'rgba(148,163,184,0.06)' }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0', fontFamily: '"SF Mono", monospace' }}>
            {cluster.avgConfidence.toFixed(0)}%
          </div>
          <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase' }}>Avg Confidence</div>
        </div>
      </div>

      <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        Actions
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {actions.map(action => (
          <button key={action.label} type="button" style={{
            display: 'flex', alignItems: 'center', gap: 5,
            paddingTop: 6, paddingRight: 10, paddingBottom: 6, paddingLeft: 10,
            borderRadius: 8, border: `1px solid ${action.color}30`,
            background: `${action.color}10`, color: action.color,
            fontSize: 11, fontWeight: 500, cursor: 'pointer',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}>
            <action.Icon size={12} color={action.color} />
            {action.label}
          </button>
        ))}
      </div>

      {matchingFacts.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Matching Facts
          </div>
          {matchingFacts.slice(0, 8).map((r, i) => (
            <div key={i} style={{
              fontSize: 11, color: '#cbd5e1', lineHeight: 1.5,
              paddingTop: 6, paddingBottom: 6,
              borderBottom: '1px solid rgba(148,163,184,0.06)',
            }}>
              {r.text}
              <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                {r.confidence.toFixed(0)}% · {r.source}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
