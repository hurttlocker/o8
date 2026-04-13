'use client';

import type { ClusterData } from './types';

interface HudOverlaysProps {
  stats: Record<string, unknown>;
  clusters: ClusterData[];
  selectedCluster: ClusterData | null;
  focusedCluster: ClusterData | null;
  focusFactsCount: number;
  onSelectCluster: (cluster: ClusterData | null) => void;
  onExitFocus: () => void;
}

export function HudOverlays({
  stats,
  clusters,
  selectedCluster,
  focusedCluster,
  focusFactsCount,
  onSelectCluster,
  onExitFocus,
}: HudOverlaysProps) {
  return (
    <>
      {/* Stats — bottom left */}
      <div style={{
        position: 'absolute',
        bottom: 14,
        left: 14,
        display: 'flex',
        gap: 14,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderRadius: 10,
        background: 'rgba(9, 9, 11, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}>
        {[
          { label: 'Active', value: (stats.activeFacts as number)?.toLocaleString() ?? '0', color: '#22c55e' },
          { label: 'Retired', value: (stats.retiredFacts as number)?.toLocaleString() ?? '0', color: '#64748b' },
          { label: 'Memories', value: (stats.totalMemories as number)?.toLocaleString() ?? '0', color: '#3b82f6' },
          { label: 'Clusters', value: String(clusters.length), color: '#ef4444' },
        ].map(s => (
          <div key={s.label}>
            <div style={{ fontSize: 15, fontWeight: 700, color: s.color, fontFamily: '"SF Mono", ui-monospace, monospace' }}>{s.value}</div>
            <div style={{ fontSize: 9, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Cluster legend — top left */}
      <div style={{
        position: 'absolute',
        top: 14,
        left: 14,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 12,
        borderRadius: 10,
        background: 'rgba(9, 9, 11, 0.85)',
        border: '1px solid rgba(148, 163, 184, 0.08)',
      }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
          Knowledge Clusters
        </div>
        {clusters.map(c => (
          <div
            key={c.type}
            onClick={() => onSelectCluster(selectedCluster?.type === c.type ? null : c)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              paddingTop: 3,
              paddingBottom: 3,
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: 4, background: c.color, boxShadow: `0 0 6px ${c.color}50`, flexShrink: 0 }} />
            <span style={{ fontSize: 11, color: '#cbd5e1' }}>{c.label}</span>
            <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto', fontFamily: '"SF Mono", monospace' }}>
              {c.factCount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>

      {/* Controls hint — bottom right */}
      <div style={{
        position: 'absolute',
        bottom: 14,
        right: 14,
        fontSize: 10,
        color: '#475569',
        textAlign: 'right',
        lineHeight: 1.6,
      }}>
        {focusedCluster ? 'Drag to orbit · Double-click to exit' : 'Drag to orbit · Scroll to zoom · Double-click peak to explore'}
      </div>

      {/* Focus mode back button */}
      {focusedCluster && (
        <button
          type="button"
          onClick={onExitFocus}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 8,
            paddingLeft: 16,
            borderRadius: 10,
            border: `1px solid ${focusedCluster.color}30`,
            background: 'rgba(9, 9, 11, 0.9)',
            backdropFilter: 'blur(12px)',
            color: '#e2e8f0',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
            boxShadow: `0 4px 20px rgba(0,0,0,0.3), 0 0 20px ${focusedCluster.color}10`,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            zIndex: 20,
          }}
        >
          <span style={{ fontSize: 14 }}>←</span>
          <span>Back to Overview</span>
        </button>
      )}

      {/* Focus mode cluster info */}
      {focusedCluster && (
        <div style={{
          position: 'absolute',
          bottom: 60,
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          paddingTop: 10,
          paddingRight: 20,
          paddingBottom: 10,
          paddingLeft: 20,
          borderRadius: 12,
          background: 'rgba(9, 9, 11, 0.9)',
          border: `1px solid ${focusedCluster.color}25`,
          backdropFilter: 'blur(16px)',
          zIndex: 20,
        }}>
          <div style={{ width: 10, height: 10, borderRadius: 5, background: focusedCluster.color, boxShadow: `0 0 10px ${focusedCluster.color}60` }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{focusedCluster.label}</span>
          <span style={{ fontSize: 12, color: '#64748b', fontFamily: '"SF Mono", monospace' }}>
            {focusedCluster.factCount.toLocaleString()} facts
          </span>
          {focusFactsCount > 0 && (
            <span style={{ fontSize: 11, color: '#94a3b8' }}>
              · Showing {focusFactsCount} samples
            </span>
          )}
        </div>
      )}
    </>
  );
}
