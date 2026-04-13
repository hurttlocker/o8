'use client';

import { CATEGORY_COLORS } from './config';
import { SearchIcon, XIcon } from './icons';
import type { ClusterData, SearchResult } from './types';

interface SearchOverlayProps {
  searchQuery: string;
  searchResults: SearchResult[];
  searchOpen: boolean;
  clusters: ClusterData[];
  onSearchInput: (q: string) => void;
  onSearchFocus: () => void;
  onSearchBlur: () => void;
  onResultClick: (result: SearchResult) => void;
}

export function SearchOverlay({
  searchQuery,
  searchResults,
  searchOpen,
  clusters,
  onSearchInput,
  onSearchFocus,
  onSearchBlur,
  onResultClick,
}: SearchOverlayProps) {
  return (
    <div style={{
      position: 'absolute',
      top: 14,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 400,
      maxWidth: '65%',
      zIndex: 30,
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingRight: 14,
        paddingBottom: 8,
        paddingLeft: 14,
        borderRadius: searchOpen ? '12px 12px 0 0' : 12,
        background: 'rgba(9, 9, 11, 0.92)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(148, 163, 184, 0.12)',
        borderBottom: searchOpen ? '1px solid rgba(148, 163, 184, 0.06)' : undefined,
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}>
        <SearchIcon size={14} color="#64748b" />
        <input
          type="text"
          placeholder="Search memories…"
          value={searchQuery}
          onChange={(e) => onSearchInput(e.target.value)}
          onFocus={onSearchFocus}
          onBlur={onSearchBlur}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontSize: 13,
            color: '#e2e8f0',
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        />
        {searchQuery && (
          <>
            <span style={{ fontSize: 10, color: '#64748b', fontFamily: '"SF Mono", monospace', whiteSpace: 'nowrap' }}>
              {searchResults.length} results
            </span>
            <button type="button" onClick={() => onSearchInput('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 0, flexShrink: 0, display: 'flex' }}>
              <XIcon size={14} color="#64748b" />
            </button>
          </>
        )}
      </div>

      {searchOpen && searchResults.length > 0 && (
        <div style={{
          background: 'rgba(9, 9, 11, 0.95)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(148, 163, 184, 0.10)',
          borderTop: 'none',
          borderRadius: '0 0 12px 12px',
          maxHeight: 320,
          overflowY: 'auto',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        }}>
          {(() => {
            const grouped = new Map<string, SearchResult[]>();
            for (const r of searchResults) {
              const arr = grouped.get(r.type) ?? [];
              arr.push(r);
              grouped.set(r.type, arr);
            }
            return Array.from(grouped.entries()).map(([type, results]) => {
              const cluster = clusters.find(c => c.type === type);
              const color = CATEGORY_COLORS[type] ?? '#94a3b8';
              return (
                <div key={type}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    paddingTop: 8,
                    paddingRight: 14,
                    paddingBottom: 4,
                    paddingLeft: 14,
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: 3, background: color, boxShadow: `0 0 6px ${color}50`, flexShrink: 0 }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {cluster?.label ?? type}
                    </span>
                    <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto' }}>
                      {results.length}
                    </span>
                  </div>
                  {results.slice(0, 5).map((r, i) => (
                    <div
                      key={i}
                      onMouseDown={(e) => { e.preventDefault(); onResultClick(r); }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        paddingTop: 7,
                        paddingRight: 14,
                        paddingBottom: 7,
                        paddingLeft: 28,
                        cursor: 'pointer',
                        borderBottom: '1px solid rgba(148, 163, 184, 0.04)',
                        transition: 'background 120ms',
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(148, 163, 184, 0.06)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                    >
                      <div style={{
                        width: 4,
                        height: 4,
                        borderRadius: 2,
                        background: r.confidence > 70 ? '#22c55e' : r.confidence > 40 ? '#f59e0b' : '#64748b',
                        flexShrink: 0,
                      }} />
                      <span style={{
                        fontSize: 12,
                        color: '#cbd5e1',
                        lineHeight: 1.4,
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}>
                        {r.text}
                      </span>
                      <span style={{
                        fontSize: 10,
                        color: '#475569',
                        fontFamily: '"SF Mono", monospace',
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                      }}>
                        {r.confidence.toFixed(0)}%
                      </span>
                    </div>
                  ))}
                </div>
              );
            });
          })()}
          <div style={{
            paddingTop: 6,
            paddingRight: 14,
            paddingBottom: 8,
            paddingLeft: 14,
            fontSize: 10,
            color: '#475569',
            textAlign: 'center',
            borderTop: '1px solid rgba(148, 163, 184, 0.06)',
          }}>
            Click a result to explore its cluster
          </div>
        </div>
      )}
    </div>
  );
}
