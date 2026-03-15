'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';

interface GraphNode { id: number; label: string; type: string; score: number; source: string; section?: string }
interface GraphEdge { source: number; target: number; relation: string }

interface GraphExplorerProps { visible: boolean; onClose: () => void; initialSubject?: string }

const TYPE_COLORS: Record<string, string> = {
  decision: '#007aff', preference: '#34c759', config: '#ff9f0a', state: '#8e8e93',
  identity: '#af52de', relationship: '#ff2d55', temporal: '#5ac8fa', kv: '#636366',
  rule: '#ff453a', status: '#30d158',
};

export default function GraphExplorer({ visible, onClose, initialSubject }: GraphExplorerProps) {
  const [subject, setSubject] = useState(initialSubject ?? '');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [center, setCenter] = useState('');
  const [loading, setLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const explore = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setLoading(true); setSelectedNode(null);
    try {
      const data = await (await fetch('/api/mobile/cortex/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: query }),
      })).json();
      setCenter(data.center ?? query); setNodes(data.nodes ?? []); setEdges(data.edges ?? []);
    } catch { setNodes([]); setEdges([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (visible && initialSubject) { setSubject(initialSubject); explore(initialSubject); }
  }, [visible, initialSubject, explore]);

  const handleSubmit = useCallback((e: React.FormEvent) => { e.preventDefault(); explore(subject); }, [subject, explore]);
  const handleDrillDown = useCallback((node: GraphNode) => { const q = node.label.slice(0, 60); setSubject(q); explore(q); }, [explore]);

  if (!visible) return null;

  const sectionGroups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const section = node.section || 'General';
    sectionGroups.set(section, [...(sectionGroups.get(section) ?? []), node]);
  }
  const connCount = (id: number) => edges.filter((e) => e.source === id || e.target === id).length;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#000000',
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      {/* Nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '60px 20px 14px' }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: '#ffffff', letterSpacing: '-0.03em', margin: 0 }}>Knowledge Graph</h2>
        <button onClick={onClose} aria-label="Close" style={{
          background: '#2c2c2e', border: 'none', borderRadius: 15, width: 30, height: 30,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aeaeb2',
          fontSize: 14, fontWeight: 700, cursor: 'pointer', minWidth: 44, minHeight: 44,
        }}>✕</button>
      </div>

      {/* Search */}
      <form onSubmit={handleSubmit} style={{ padding: '0 20px 14px' }}>
        <div style={{ display: 'flex', gap: 10, background: '#1c1c1e', borderRadius: 12, padding: '4px 4px 4px 14px', alignItems: 'center' }}>
          <span style={{ fontSize: 14, color: '#48484a', lineHeight: 1, flexShrink: 0 }}>🔍</span>
          <input ref={inputRef} value={subject} onChange={(e) => setSubject(e.target.value)}
            placeholder="Explore a topic…"
            style={{ flex: 1, padding: '10px 0', background: 'transparent', border: 'none', color: '#ffffff', fontSize: 15, outline: 'none', letterSpacing: '-0.01em' }}
          />
          <button type="submit" disabled={!subject.trim() || loading} style={{
            padding: '8px 16px', borderRadius: 9, border: 'none',
            background: subject.trim() && !loading ? '#af52de' : '#2c2c2e',
            color: subject.trim() && !loading ? '#ffffff' : '#48484a',
            fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 36, transition: 'all 0.2s ease',
          }}>{loading ? '…' : 'Go'}</button>
        </div>
      </form>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 32px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <div style={{ width: 24, height: 24, margin: '0 auto 16px', border: '2px solid #3a3a3c', borderTopColor: '#af52de', borderRadius: 12, animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: '#636366', fontSize: 14 }}>Exploring…</div>
          </div>
        )}

        {!loading && nodes.length === 0 && !center && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{ fontSize: 44, marginBottom: 16 }}>🕸️</div>
            <div style={{ color: '#ffffff', fontSize: 17, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>Knowledge Graph</div>
            <div style={{ color: '#636366', fontSize: 14, lineHeight: '20px' }}>
              Search a topic to explore how decisions, preferences, and facts connect.
            </div>
          </div>
        )}

        {!loading && nodes.length === 0 && center && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🔍</div>
            <div style={{ color: '#636366', fontSize: 15, lineHeight: '21px' }}>No connections found for &ldquo;{center}&rdquo;</div>
          </div>
        )}

        {!loading && nodes.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 12, background: '#1c1c1e', color: '#af52de', padding: '5px 12px', borderRadius: 8, fontWeight: 600 }}>{nodes.length} nodes</span>
              <span style={{ fontSize: 12, background: '#1c1c1e', color: '#5ac8fa', padding: '5px 12px', borderRadius: 8, fontWeight: 600 }}>{edges.length} edges</span>
              <span style={{ fontSize: 12, background: '#1c1c1e', color: '#48484a', padding: '5px 12px', borderRadius: 8, fontWeight: 500 }}>{sectionGroups.size} cluster{sectionGroups.size !== 1 ? 's' : ''}</span>
            </div>

            {[...sectionGroups.entries()].map(([section, group]) => (
              <div key={section} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, color: '#636366', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 8 }}>
                  {section.length > 50 ? section.slice(0, 50) + '…' : section}
                </div>
                {group.map((node) => {
                  const color = TYPE_COLORS[node.type] ?? '#8e8e93';
                  const conns = connCount(node.id);
                  const isSel = selectedNode?.id === node.id;
                  return (
                    <div key={node.id}>
                      <div onClick={() => setSelectedNode(isSel ? null : node)} style={{
                        background: isSel ? '#2c2c2e' : '#1c1c1e', borderRadius: 14, padding: '14px 16px', marginBottom: 8,
                        cursor: 'pointer', WebkitTapHighlightColor: 'rgba(255,255,255,0.04)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color, background: `${color}14`, padding: '3px 8px', borderRadius: 6 }}>{node.type}</span>
                          {conns > 0 && <span style={{ fontSize: 11, color: '#48484a' }}>{conns} link{conns !== 1 ? 's' : ''}</span>}
                          <span style={{ fontSize: 11, color: '#3a3a3c', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{(node.score * 100).toFixed(0)}%</span>
                        </div>
                        <div style={{ fontSize: 15, lineHeight: '21px', color: '#f2f2f7', letterSpacing: '-0.01em', display: '-webkit-box', WebkitLineClamp: isSel ? 99 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.label}</div>
                      </div>
                      {isSel && (
                        <div style={{ padding: '0 0 8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                          <button onClick={() => handleDrillDown(node)} style={{
                            padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(175, 82, 222, 0.1)',
                            color: '#af52de', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                          }}>Explore →</button>
                          <button onClick={() => navigator?.clipboard?.writeText(node.label)} style={{
                            padding: '12px 0', borderRadius: 12, border: 'none', background: 'rgba(142, 142, 147, 0.1)',
                            color: '#8e8e93', fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                          }}>Copy</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
