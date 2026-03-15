'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';

interface GraphNode {
  id: number;
  label: string;
  type: string;
  score: number;
  source: string;
  section?: string;
}

interface GraphEdge {
  source: number;
  target: number;
  relation: string;
}

interface GraphExplorerProps {
  visible: boolean;
  onClose: () => void;
  initialSubject?: string;
}

const TYPE_COLORS: Record<string, string> = {
  decision: '#007aff',
  preference: '#34c759',
  config: '#ff9f0a',
  state: '#8e8e93',
  identity: '#af52de',
  relationship: '#ff2d55',
  temporal: '#5ac8fa',
  kv: '#636366',
  rule: '#ff3b30',
  status: '#30d158',
};

export default function GraphExplorer({ visible, onClose, initialSubject }: GraphExplorerProps) {
  const [subject, setSubject] = useState(initialSubject ?? '');
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [center, setCenter] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const explore = useCallback(async (query: string) => {
    if (!query.trim()) return;
    setLoading(true);
    setSelectedNode(null);

    try {
      const res = await fetch('/api/mobile/cortex/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: query }),
      });
      const data = await res.json();
      setCenter(data.center ?? query);
      setNodes(data.nodes ?? []);
      setEdges(data.edges ?? []);
    } catch {
      setNodes([]);
      setEdges([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible && initialSubject) {
      setSubject(initialSubject);
      explore(initialSubject);
    }
  }, [visible, initialSubject, explore]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    explore(subject);
  }, [subject, explore]);

  const handleNodeTap = useCallback((node: GraphNode) => {
    setSelectedNode((prev) => prev?.id === node.id ? null : node);
  }, []);

  const handleDrillDown = useCallback((node: GraphNode) => {
    const newSubject = node.label.slice(0, 60);
    setSubject(newSubject);
    explore(newSubject);
  }, [explore]);

  if (!visible) return null;

  // Group nodes by section for visual clustering
  const sectionGroups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const section = node.section || 'General';
    const group = sectionGroups.get(section) ?? [];
    group.push(node);
    sectionGroups.set(section, group);
  }

  const connectionCount = (nodeId: number) =>
    edges.filter((e) => e.source === nodeId || e.target === nodeId).length;

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
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '56px 16px 12px', borderBottom: '1px solid #1c1c1e',
      }}>
        <span style={{ fontSize: 17, fontWeight: 600, color: '#ffffff', letterSpacing: '-0.02em' }}>
          🕸️ Knowledge Graph
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

      {/* Search bar */}
      <form onSubmit={handleSubmit} style={{ padding: '12px 16px', borderBottom: '1px solid #1c1c1e' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Explore a topic…"
            style={{
              flex: 1, padding: '10px 14px', borderRadius: 10,
              background: '#1c1c1e', border: '1px solid #2c2c2e',
              color: '#ffffff', fontSize: 14, outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={!subject.trim() || loading}
            style={{
              padding: '10px 16px', borderRadius: 10, border: 'none',
              background: subject.trim() ? '#af52de' : '#2c2c2e',
              color: '#ffffff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {loading ? '…' : 'Explore'}
          </button>
        </div>
      </form>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', WebkitOverflowScrolling: 'touch' }}>
        {loading && (
          <div style={{ textAlign: 'center', padding: '40px 0', color: '#636366', fontSize: 13 }}>
            Exploring knowledge graph…
          </div>
        )}

        {!loading && nodes.length === 0 && center && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🕸️</div>
            <div style={{ color: '#636366', fontSize: 13 }}>
              No connections found for "{center}"
            </div>
          </div>
        )}

        {!loading && nodes.length === 0 && !center && (
          <div style={{ textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>🕸️</div>
            <div style={{ color: '#ffffff', fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
              Knowledge Graph Explorer
            </div>
            <div style={{ color: '#636366', fontSize: 13, lineHeight: '18px' }}>
              Search for a topic to see how decisions, preferences, and facts connect to each other.
            </div>
          </div>
        )}

        {/* Graph summary */}
        {!loading && nodes.length > 0 && (
          <>
            <div style={{
              display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap',
            }}>
              <span style={{
                fontSize: 11, background: '#1c1c1e', color: '#af52de',
                padding: '4px 10px', borderRadius: 8, fontWeight: 500,
              }}>
                {nodes.length} nodes
              </span>
              <span style={{
                fontSize: 11, background: '#1c1c1e', color: '#5ac8fa',
                padding: '4px 10px', borderRadius: 8, fontWeight: 500,
              }}>
                {edges.length} connections
              </span>
              <span style={{
                fontSize: 11, background: '#1c1c1e', color: '#636366',
                padding: '4px 10px', borderRadius: 8, fontWeight: 500,
              }}>
                {sectionGroups.size} clusters
              </span>
            </div>

            {/* Clustered node list */}
            {[...sectionGroups.entries()].map(([section, groupNodes]) => (
              <div key={section} style={{ marginBottom: 16 }}>
                <div style={{
                  fontSize: 11, color: '#8e8e93', fontWeight: 600,
                  textTransform: 'uppercase', letterSpacing: '0.04em',
                  marginBottom: 8, padding: '0 4px',
                }}>
                  {section.length > 60 ? section.slice(0, 60) + '…' : section}
                </div>

                {groupNodes.map((node) => {
                  const color = TYPE_COLORS[node.type] ?? '#8e8e93';
                  const connections = connectionCount(node.id);
                  const isSelected = selectedNode?.id === node.id;

                  return (
                    <div key={node.id}>
                      <div
                        onClick={() => handleNodeTap(node)}
                        style={{
                          background: isSelected ? '#2c2c2e' : '#1c1c1e',
                          borderRadius: 10, padding: '12px 14px', marginBottom: 6,
                          borderLeft: `3px solid ${color}`,
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{
                            fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                            color, background: `${color}18`, padding: '1px 5px', borderRadius: 3,
                          }}>
                            {node.type}
                          </span>
                          {connections > 0 && (
                            <span style={{ fontSize: 10, color: '#636366' }}>
                              {connections} connection{connections !== 1 ? 's' : ''}
                            </span>
                          )}
                          <span style={{
                            fontSize: 10, color: '#48484a', marginLeft: 'auto',
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {(node.score * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div style={{
                          fontSize: 13, lineHeight: '18px', color: '#e5e5ea',
                          display: '-webkit-box', WebkitLineClamp: isSelected ? 99 : 2,
                          WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        }}>
                          {node.label}
                        </div>
                      </div>

                      {/* Expanded: drill-down button */}
                      {isSelected && (
                        <div style={{ padding: '0 14px 8px', display: 'flex', gap: 8 }}>
                          <button
                            onClick={() => handleDrillDown(node)}
                            style={{
                              flex: 1, padding: '8px 0', borderRadius: 8, border: 'none',
                              background: 'rgba(175, 82, 222, 0.12)', color: '#af52de',
                              fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            }}
                          >
                            Explore this →
                          </button>
                          <button
                            onClick={() => {
                              if (typeof navigator !== 'undefined' && navigator.clipboard) {
                                navigator.clipboard.writeText(node.label);
                              }
                            }}
                            style={{
                              padding: '8px 12px', borderRadius: 8, border: 'none',
                              background: 'rgba(142, 142, 147, 0.12)', color: '#8e8e93',
                              fontSize: 12, fontWeight: 600, cursor: 'pointer',
                            }}
                          >
                            Copy
                          </button>
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
