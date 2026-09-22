'use client';

import { useId, useMemo, useState } from 'react';

import type { ArchitectureDeltaResult } from '@/lib/review/architecture-delta-types';
import {
  buildArchitectureGraph,
  initialArchitecturePrefix,
  type ArchitectureGraphEdge,
  type ArchitectureGraphNode,
  type ArchitectureGraphState,
} from './architecture-delta-graph';
import { UI_FONT } from './constants';

const MONO_FONT = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const NODE_WIDTH = 178;
const NODE_HEIGHT = 64;

const STATE_COLOR: Record<ArchitectureGraphState, string> = {
  added: 'var(--t-terminal-ansi-bright-green, #22c55e)',
  removed: 'var(--t-brand-red, #ef4444)',
  changed: 'var(--t-accent, #2563eb)',
  mixed: 'var(--t-brand-orange, #f97316)',
  context: 'var(--t-text-faint)',
};

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

function edgeColor(edge: ArchitectureGraphEdge) {
  return STATE_COLOR[edge.state];
}

function edgePath(from: ArchitectureGraphNode, to: ArchitectureGraphNode) {
  const startX = from.x + NODE_WIDTH;
  const startY = from.y + NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + NODE_HEIGHT / 2;
  if (endX > startX) {
    const middleX = startX + (endX - startX) / 2;
    return `M ${startX} ${startY} H ${middleX} V ${endY} H ${endX}`;
  }
  const laneY = Math.min(startY, endY) - 18;
  return `M ${startX} ${startY} H ${startX + 22} V ${laneY} H ${endX - 22} V ${endY} H ${endX}`;
}

function sourceLabel(edge: ArchitectureGraphEdge) {
  return edge.sourceEdges.map((item) => `${item.from} → ${item.to}`).join('\n');
}

export function ArchitectureDeltaGraph({
  result,
  onSelectFile,
}: {
  result: ArchitectureDeltaResult;
  onSelectFile: (path: string) => void;
}) {
  const initialPrefix = useMemo(() => initialArchitecturePrefix(result.nodes), [result.nodes]);
  const [prefix, setPrefix] = useState<string[]>(initialPrefix);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Selection>(null);
  const markerPrefix = useId().replaceAll(':', '');
  const graph = useMemo(
    () => buildArchitectureGraph(result.nodes, result.edges, prefix),
    [prefix, result.edges, result.nodes],
  );
  const nodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);
  const selectedNode = selection?.kind === 'node' ? nodeById.get(selection.id) ?? null : null;
  const selectedEdge = selection?.kind === 'edge'
    ? graph.edges.find((edge) => edge.id === selection.id) ?? null
    : null;
  const selectedFocusPath = (selectedNode && !selectedNode.directory
    ? selectedNode.sourceNodes.find((node) => node.focusPath)?.focusPath
    : null)
    ?? selectedEdge?.sourceEdges.find((edge) => edge.focusPath)?.focusPath
    ?? null;
  const connectedEdgeIds = selectedNode
    ? new Set(graph.edges.filter((edge) => (
      edge.from === selectedNode.id || edge.to === selectedNode.id
    )).map((edge) => edge.id))
    : new Set<string>();
  const drillInto = (node: ArchitectureGraphNode) => {
    if (!node.directory) return;
    setPrefix(node.id.split('/'));
    setSelection(null);
    setZoom(1);
  };
  const goUp = () => {
    if (prefix.length <= initialPrefix.length) return;
    setPrefix(prefix.slice(0, -1));
    setSelection(null);
    setZoom(1);
  };
  const cycleCount = graph.nodes.filter((node) => node.cyclic).length;
  return (
    <div style={{ fontFamily: UI_FONT }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, minHeight: 36 }}>
        <button
          type="button"
          onClick={goUp}
          disabled={prefix.length <= initialPrefix.length}
          aria-label="Go up one architecture level"
          style={{ width: 44, height: 44, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: prefix.length <= initialPrefix.length ? 'var(--t-text-faint)' : 'var(--t-text)', cursor: prefix.length <= initialPrefix.length ? 'default' : 'pointer', fontFamily: UI_FONT, fontSize: 16 }}
        >
          ←
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ color: 'var(--t-text-faint)', fontSize: 9, fontWeight: 300, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Viewing layer</div>
          <div title={prefix.join('/') || 'Repository'} style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontFamily: MONO_FONT, fontSize: 11 }}>
            {prefix.join(' / ') || 'Repository'}
          </div>
        </div>
        {cycleCount > 0 ? (
          <span style={{ paddingTop: 3, paddingRight: 7, paddingBottom: 3, paddingLeft: 7, border: '1px solid var(--t-brand-orange, #f97316)', borderRadius: 999, color: 'var(--t-brand-orange, #f97316)', fontSize: 9, whiteSpace: 'nowrap' }}>
            {cycleCount} in cycle
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setZoom((value) => Math.max(0.72, Number((value - 0.14).toFixed(2))))}
          aria-label="Zoom architecture map out"
          style={{ width: 44, height: 44, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 17 }}
        >
          −
        </button>
        <button
          type="button"
          onClick={() => setZoom(1)}
          aria-label="Reset architecture map zoom"
          style={{ minWidth: 44, height: 44, paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 8, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text-secondary)', cursor: 'pointer', fontFamily: MONO_FONT, fontSize: 9 }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => setZoom((value) => Math.min(1.42, Number((value + 0.14).toFixed(2))))}
          aria-label="Zoom architecture map in"
          style={{ width: 44, height: 44, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 17 }}
        >
          +
        </button>
      </div>
      <div style={{ maxHeight: 350, overflow: 'auto', border: '1px solid var(--t-divider-subtle)', borderRadius: 10, background: 'var(--t-input-bg)' }}>
        <svg
          role="group"
          aria-label={`Architecture dependency map with ${graph.nodes.length} visible nodes and ${graph.edges.length} visible relationships`}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          width={Math.round(graph.width * zoom)}
          height={Math.round(graph.height * zoom)}
          style={{ display: 'block', minWidth: Math.round(graph.width * zoom), minHeight: Math.round(graph.height * zoom), touchAction: 'pan-x pan-y' }}
        >
          <defs>
            {(['added', 'removed', 'changed', 'mixed', 'context'] as ArchitectureGraphState[]).map((state) => (
              <marker key={state} id={`${markerPrefix}-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={STATE_COLOR[state]} />
              </marker>
            ))}
          </defs>
          <g>
            {graph.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const active = selectedEdge?.id === edge.id || connectedEdgeIds.has(edge.id);
              const d = edgePath(from, to);
              return (
                <g key={edge.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={18}
                    role="button"
                    tabIndex={0}
                    aria-label={`${edge.state} relationship from ${edge.from} to ${edge.to}`}
                    onClick={() => setSelection({ kind: 'edge', id: edge.id })}
                    onFocus={() => setSelection({ kind: 'edge', id: edge.id })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setSelection({ kind: 'edge', id: edge.id });
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>{sourceLabel(edge)}</title>
                  </path>
                  <path
                    d={d}
                    fill="none"
                    stroke={edgeColor(edge)}
                    strokeWidth={active ? 3 : 1.5}
                    strokeDasharray={edge.state === 'removed' ? '5 4' : undefined}
                    opacity={selection && !active ? 0.24 : edge.state === 'context' ? 0.48 : 0.9}
                    markerEnd={`url(#${markerPrefix}-${edge.state})`}
                    pointerEvents="none"
                  />
                </g>
              );
            })}
            {graph.nodes.map((node) => {
              const selected = selectedNode?.id === node.id;
              const color = STATE_COLOR[node.state];
              return (
                <g
                  key={node.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`${node.directory ? 'Component' : 'Module'} ${node.id}, ${node.state}`}
                  transform={`translate(${node.x} ${node.y})`}
                  onClick={() => setSelection({ kind: 'node', id: node.id })}
                  onFocus={() => setSelection({ kind: 'node', id: node.id })}
                  onDoubleClick={() => drillInto(node)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') setSelection({ kind: 'node', id: node.id });
                  }}
                  style={{ cursor: 'pointer' }}
                >
                  <title>{node.id}</title>
                  <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="9" fill="var(--t-canvas-bg)" stroke={color} strokeWidth={selected ? 3 : node.state === 'context' ? 1 : 2} />
                  <rect x="0" y="0" width="5" height={NODE_HEIGHT} rx="2.5" fill={color} />
                  <text x="16" y="25" fill="var(--t-text)" fontFamily={UI_FONT} fontSize="12.5" fontWeight="500">
                    {node.label.length > 21 ? `${node.label.slice(0, 19)}…` : node.label}
                  </text>
                  <text x="16" y="45" fill="var(--t-text-faint)" fontFamily={MONO_FONT} fontSize="9.5" fontWeight="300">
                    {node.detail.length > 27 ? `${node.detail.slice(0, 25)}…` : node.detail}
                  </text>
                  {node.directory ? <text x="162" y="24" textAnchor="end" fill={color} fontFamily={UI_FONT} fontSize="12">↳</text> : null}
                  {node.cyclic ? <circle cx="163" cy="46" r="4" fill="var(--t-brand-orange, #f97316)" /> : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 12, rowGap: 5, marginTop: 8, color: 'var(--t-text-faint)', fontSize: 9.5 }}>
        {(['added', 'removed', 'changed', 'context'] as ArchitectureGraphState[]).map((state) => (
          <span key={state} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 12, height: 2, background: STATE_COLOR[state] }} />
            {state}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>Arrow points to dependency</span>
      </div>
      {selectedNode || selectedEdge ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, paddingTop: 9, paddingRight: 10, paddingBottom: 9, paddingLeft: 10, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: 'var(--t-input-bg)' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: 'var(--t-text-faint)', fontSize: 9, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              {selectedNode ? (selectedNode.directory ? 'Component' : 'Module') : `${selectedEdge?.state} relationship`}
            </div>
            <div title={selectedNode?.id ?? sourceLabel(selectedEdge!)} style={{ marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontFamily: MONO_FONT, fontSize: 10.5 }}>
              {selectedNode?.id ?? `${selectedEdge?.from} → ${selectedEdge?.to}`}
            </div>
          </div>
          {selectedNode?.directory ? (
            <button type="button" onClick={() => drillInto(selectedNode)} style={{ minHeight: 44, paddingTop: 0, paddingRight: 11, paddingBottom: 0, paddingLeft: 11, border: '1px solid var(--t-accent)', borderRadius: 8, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 10.5 }}>
              Open layer
            </button>
          ) : null}
          {selectedFocusPath ? (
            <button type="button" title={`Open ${selectedFocusPath} diff`} onClick={() => onSelectFile(selectedFocusPath)} style={{ minHeight: 44, paddingTop: 0, paddingRight: 11, paddingBottom: 0, paddingLeft: 11, border: 0, borderRadius: 8, background: 'var(--t-accent)', color: 'white', cursor: 'pointer', fontFamily: UI_FONT, fontSize: 10.5 }}>
              Open diff
            </button>
          ) : null}
        </div>
      ) : (
        <p style={{ marginTop: 9, marginRight: 0, marginBottom: 0, marginLeft: 0, color: 'var(--t-text-faint)', fontSize: 10.5 }}>
          Select a component to inspect it. Open a layer to drill into its modules.
        </p>
      )}
    </div>
  );
}
