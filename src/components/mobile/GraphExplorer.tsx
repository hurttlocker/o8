'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, Search, GitBranch, Copy, ArrowRight } from 'lucide-react';

interface GraphNode { id: number; label: string; type: string; score: number; source: string; section?: string }
interface GraphEdge { source: number; target: number; relation: string }
interface GraphExplorerProps { visible: boolean; onClose: () => void; initialSubject?: string }

const TYPE_COLORS: Record<string, string> = {
  decision: '#2563eb', preference: '#059669', config: '#b45309', state: '#5b6475',
  identity: '#7c3aed', relationship: '#dc2626', temporal: '#0891b2', kv: '#64748b',
  rule: '#dc2626', status: '#059669',
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
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'linear-gradient(180deg, #fbfcff 0%, #f5f7fb 100%)',
      zIndex: 1000, display: 'flex', flexDirection: 'column',
      animation: 'slideInRight 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '60px 20px 14px' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#111827', letterSpacing: '-0.02em', margin: 0 }}>Knowledge Graph</h2>
        <button onClick={onClose} aria-label="Close" style={{
          background: 'rgba(15,23,42,0.05)', border: 'none', borderRadius: 12,
          width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#64748b', cursor: 'pointer', minWidth: 44, minHeight: 44,
        }}><X size={16} strokeWidth={2.2} /></button>
      </div>

      <form onSubmit={handleSubmit} style={{ padding: '0 20px 14px' }}>
        <div style={{
          display: 'flex', gap: 8, background: 'rgba(255,255,255,0.9)',
          border: '1px solid rgba(15,23,42,0.08)', borderRadius: 14,
          padding: '4px 4px 4px 14px', alignItems: 'center',
          boxShadow: '0 2px 8px rgba(15,23,42,0.04)', backdropFilter: 'blur(12px)',
        }}>
          <Search size={15} strokeWidth={2} style={{ color: '#94a3b8', flexShrink: 0 }} />
          <input ref={inputRef} value={subject} onChange={(e) => setSubject(e.target.value)}
            placeholder="Explore a topic…"
            style={{ flex: 1, padding: '10px 0', background: 'transparent', border: 'none', color: '#111827', fontSize: 15, outline: 'none' }} />
          <button type="submit" disabled={!subject.trim() || loading} style={{
            padding: '8px 16px', borderRadius: 10, border: 'none',
            background: subject.trim() && !loading ? '#2563eb' : 'rgba(15,23,42,0.04)',
            color: subject.trim() && !loading ? '#ffffff' : '#94a3b8',
            fontSize: 14, fontWeight: 600, cursor: 'pointer', minHeight: 36, transition: 'all 0.2s ease',
          }}>{loading ? '…' : 'Go'}</button>
        </div>
      </form>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 32px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Loader2 size={24} strokeWidth={2} style={{ margin: '0 auto 16px', color: '#2563eb', animation: 'spin 0.8s linear infinite' }} />
            <div style={{ color: '#5b6475', fontSize: 14 }}>Exploring…</div>
          </div>
        )}

        {!loading && nodes.length === 0 && !center && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <GitBranch size={44} strokeWidth={1.2} style={{ color: '#cbd5e1', margin: '0 auto 16px', display: 'block' }} />
            <div style={{ color: '#111827', fontSize: 17, fontWeight: 600, marginBottom: 8 }}>Knowledge Graph</div>
            <div style={{ color: '#5b6475', fontSize: 14, lineHeight: '20px' }}>
              Search a topic to explore how decisions, preferences, and facts connect.
            </div>
          </div>
        )}

        {!loading && nodes.length === 0 && center && (
          <div style={{ textAlign: 'center', padding: '60px 24px' }}>
            <Search size={40} strokeWidth={1.2} style={{ color: '#cbd5e1', margin: '0 auto 16px', display: 'block' }} />
            <div style={{ color: '#5b6475', fontSize: 15 }}>No connections found for &ldquo;{center}&rdquo;</div>
          </div>
        )}

        {!loading && nodes.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
              <span style={{ fontSize: 12, background: 'rgba(37,99,235,0.08)', color: '#2563eb', padding: '5px 12px', borderRadius: 8, fontWeight: 600, border: '1px solid rgba(37,99,235,0.12)' }}>{nodes.length} nodes</span>
              <span style={{ fontSize: 12, background: 'rgba(8,145,178,0.08)', color: '#0891b2', padding: '5px 12px', borderRadius: 8, fontWeight: 600, border: '1px solid rgba(8,145,178,0.12)' }}>{edges.length} edges</span>
              <span style={{ fontSize: 12, background: 'rgba(15,23,42,0.04)', color: '#5b6475', padding: '5px 12px', borderRadius: 8, fontWeight: 500 }}>{sectionGroups.size} cluster{sectionGroups.size !== 1 ? 's' : ''}</span>
            </div>

            {[...sectionGroups.entries()].map(([section, group]) => (
              <div key={section} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
                  {section.length > 50 ? section.slice(0, 50) + '…' : section}
                </div>
                {group.map((node) => {
                  const color = TYPE_COLORS[node.type] ?? '#5b6475';
                  const conns = connCount(node.id);
                  const isSel = selectedNode?.id === node.id;
                  return (
                    <div key={node.id}>
                      <div onClick={() => setSelectedNode(isSel ? null : node)} style={{
                        background: isSel ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.82)',
                        border: `1px solid ${isSel ? 'rgba(37,99,235,0.15)' : 'rgba(15,23,42,0.08)'}`,
                        borderRadius: 16, padding: '14px 16px', marginBottom: 8,
                        cursor: 'pointer', boxShadow: isSel ? '0 4px 12px rgba(37,99,235,0.08)' : '0 2px 8px rgba(15,23,42,0.04)',
                        backdropFilter: 'blur(12px)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color, background: `${color}14`, padding: '3px 8px', borderRadius: 6 }}>{node.type}</span>
                          {conns > 0 && <span style={{ fontSize: 11, color: '#94a3b8' }}>{conns} link{conns !== 1 ? 's' : ''}</span>}
                          <span style={{ fontSize: 11, color: '#cbd5e1', marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>{(node.score * 100).toFixed(0)}%</span>
                        </div>
                        <div style={{ fontSize: 14, lineHeight: '20px', color: '#111827', display: '-webkit-box', WebkitLineClamp: isSel ? 99 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.label}</div>
                      </div>
                      {isSel && (
                        <div style={{ padding: '0 0 8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <button onClick={() => handleDrillDown(node)} style={{
                            padding: '10px 0', borderRadius: 12, border: '1px solid rgba(37,99,235,0.15)',
                            background: 'rgba(37,99,235,0.06)', color: '#2563eb',
                            fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          }}><ArrowRight size={14} /> Explore</button>
                          <button onClick={() => navigator?.clipboard?.writeText(node.label)} style={{
                            padding: '10px 0', borderRadius: 12, border: '1px solid rgba(15,23,42,0.08)',
                            background: 'rgba(15,23,42,0.03)', color: '#64748b',
                            fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 44,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                          }}><Copy size={14} /> Copy</button>
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
