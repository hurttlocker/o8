'use client';

/**
 * /context-graph — Middle column.
 *
 * Hand-coordinated SVG. No d3-force, no animation, no canvas — just a
 * static figure. ~36 nodes laid out in three rough zones (input → core
 * → output) with edges that suggest the graph traversal a Recall Card
 * walk does.
 *
 * Five nodes carry real o8 file labels. Four are highlighted in the
 * brand orange (`#ef4444` per the issue) — those are the nodes the
 * Recall Card surfaces for the example dispatch implied by the figure.
 *
 * Coordinates were tuned by eye for visual balance. Don't auto-layout.
 */

import { BRAND_ORANGE, FONT_MONO, FONT_SANS, SectionLabel, NumberedHeading } from './shared';

interface GraphNode {
  id: string;
  x: number;
  y: number;
  /** Filled radius (5–8 typical, 10 for highlighted core). */
  r: number;
  /** Highlight uses brand orange + outer glow. */
  highlight?: boolean;
  /** Optional file path label drawn next to the node. */
  label?: string;
  /** 'l' | 'r' | 't' | 'b' — where the label sits relative to the dot. */
  labelSide?: 'l' | 'r' | 't' | 'b';
}

interface GraphEdge {
  from: string;
  to: string;
  /** 0..1 — how prominent the edge reads. */
  weight?: number;
}

// ---------------------------------------------------------------------------
// Coordinates. viewBox is 540 x 560 — wider than it is tall so we can spread
// the three zones (input | core | output) horizontally without crowding.
//
// Naming convention:
//   i_*  — input cluster (left)
//   c_*  — core cluster (center) — the orchestrator graph traversal
//   o_*  — output cluster (right)
//   the five labeled nodes get human ids: 'indexer', 'recall', 'tauri',
//   'directives', 'packet'
// ---------------------------------------------------------------------------
const NODES: GraphNode[] = [
  // ─── Input zone (left) — raw files / symbols
  { id: 'i_a', x: 50, y: 110, r: 5 },
  { id: 'i_b', x: 78, y: 78, r: 6 },
  { id: 'i_c', x: 96, y: 142, r: 5 },
  { id: 'i_d', x: 64, y: 184, r: 6 },
  { id: 'i_e', x: 110, y: 220, r: 5 },
  { id: 'i_f', x: 48, y: 254, r: 6 },
  { id: 'i_g', x: 90, y: 304, r: 5 },
  { id: 'i_h', x: 56, y: 360, r: 6 },
  { id: 'i_i', x: 108, y: 396, r: 5 },
  { id: 'i_j', x: 72, y: 444, r: 6 },
  { id: 'i_k', x: 120, y: 488, r: 5 },
  { id: 'i_l', x: 60, y: 510, r: 4 },

  // ─── Core zone (center) — labeled real-file nodes + the orchestrator graph
  // The five labeled nodes — the ones a viewer can read from a screenshot.
  // 4 of these get the brand-orange highlight (the implied Recall set).
  {
    id: 'indexer',
    x: 220,
    y: 130,
    r: 7,
    highlight: true,
    label: 'src/lib/codebase-memory/indexer.ts',
    labelSide: 't',
  },
  {
    id: 'directives',
    x: 250,
    y: 224,
    r: 7,
    highlight: true,
    label: 'src/app/api/cortex/directives/route.ts',
    labelSide: 'r',
  },
  {
    id: 'recall',
    x: 196,
    y: 312,
    r: 8,
    highlight: true,
    label: 'src/components/desktop/thoughts/ContextRecallCard.tsx',
    labelSide: 'b',
  },
  {
    id: 'packet',
    x: 296,
    y: 362,
    r: 7,
    highlight: true,
    label: 'src/lib/orchestrator/packet-prompt.ts',
    labelSide: 'r',
  },
  {
    id: 'tauri',
    x: 256,
    y: 444,
    r: 6,
    label: 'src-tauri/src/lib.rs',
    labelSide: 'b',
  },

  // Supporting core nodes (unlabeled).
  { id: 'c_a', x: 174, y: 92, r: 5 },
  { id: 'c_b', x: 268, y: 88, r: 5 },
  { id: 'c_c', x: 156, y: 174, r: 5 },
  { id: 'c_d', x: 318, y: 168, r: 5 },
  { id: 'c_e', x: 224, y: 270, r: 5 },
  { id: 'c_f', x: 332, y: 280, r: 5 },
  { id: 'c_g', x: 154, y: 388, r: 5 },
  { id: 'c_h', x: 244, y: 408, r: 5 },
  { id: 'c_i', x: 326, y: 416, r: 5 },
  { id: 'c_j', x: 198, y: 478, r: 5 },
  { id: 'c_k', x: 304, y: 510, r: 5 },

  // ─── Output zone (right) — what flows toward the Curated column
  { id: 'o_a', x: 416, y: 96, r: 5 },
  { id: 'o_b', x: 460, y: 144, r: 5 },
  { id: 'o_c', x: 432, y: 200, r: 6 },
  { id: 'o_d', x: 488, y: 252, r: 5 },
  { id: 'o_e', x: 422, y: 304, r: 5 },
  { id: 'o_f', x: 468, y: 356, r: 5 },
  { id: 'o_g', x: 420, y: 408, r: 6 },
  { id: 'o_h', x: 464, y: 460, r: 5 },
  { id: 'o_i', x: 412, y: 510, r: 5 },
];

// ---------------------------------------------------------------------------
// Edges. Drawn first so nodes paint on top. Weight controls opacity.
// ---------------------------------------------------------------------------
const EDGES: GraphEdge[] = [
  // input → core
  { from: 'i_a', to: 'c_a', weight: 0.35 },
  { from: 'i_b', to: 'c_a', weight: 0.4 },
  { from: 'i_b', to: 'indexer', weight: 0.65 },
  { from: 'i_c', to: 'indexer', weight: 0.7 },
  { from: 'i_c', to: 'c_c', weight: 0.4 },
  { from: 'i_d', to: 'c_c', weight: 0.45 },
  { from: 'i_e', to: 'directives', weight: 0.55 },
  { from: 'i_e', to: 'c_c', weight: 0.4 },
  { from: 'i_f', to: 'c_e', weight: 0.4 },
  { from: 'i_g', to: 'recall', weight: 0.55 },
  { from: 'i_h', to: 'c_g', weight: 0.4 },
  { from: 'i_i', to: 'recall', weight: 0.45 },
  { from: 'i_j', to: 'c_j', weight: 0.4 },
  { from: 'i_k', to: 'c_k', weight: 0.4 },
  { from: 'i_l', to: 'c_j', weight: 0.35 },

  // core internal — the orchestrator's traversal
  { from: 'c_a', to: 'indexer', weight: 0.7 },
  { from: 'c_b', to: 'indexer', weight: 0.55 },
  { from: 'c_b', to: 'directives', weight: 0.55 },
  { from: 'c_c', to: 'recall', weight: 0.55 },
  { from: 'c_c', to: 'directives', weight: 0.5 },
  { from: 'c_d', to: 'directives', weight: 0.6 },
  { from: 'indexer', to: 'recall', weight: 0.85 },
  { from: 'directives', to: 'recall', weight: 0.85 },
  { from: 'directives', to: 'packet', weight: 0.8 },
  { from: 'recall', to: 'packet', weight: 0.95 },
  { from: 'c_e', to: 'recall', weight: 0.55 },
  { from: 'c_e', to: 'packet', weight: 0.55 },
  { from: 'c_f', to: 'packet', weight: 0.6 },
  { from: 'c_g', to: 'recall', weight: 0.5 },
  { from: 'c_h', to: 'packet', weight: 0.55 },
  { from: 'c_i', to: 'packet', weight: 0.5 },
  { from: 'c_h', to: 'tauri', weight: 0.45 },
  { from: 'c_j', to: 'tauri', weight: 0.45 },
  { from: 'c_k', to: 'tauri', weight: 0.45 },

  // core → output
  { from: 'indexer', to: 'o_a', weight: 0.55 },
  { from: 'directives', to: 'o_b', weight: 0.55 },
  { from: 'directives', to: 'o_c', weight: 0.6 },
  { from: 'recall', to: 'o_c', weight: 0.7 },
  { from: 'recall', to: 'o_d', weight: 0.55 },
  { from: 'recall', to: 'o_e', weight: 0.55 },
  { from: 'packet', to: 'o_e', weight: 0.6 },
  { from: 'packet', to: 'o_f', weight: 0.7 },
  { from: 'packet', to: 'o_g', weight: 0.7 },
  { from: 'tauri', to: 'o_h', weight: 0.45 },
  { from: 'tauri', to: 'o_i', weight: 0.45 },

  // output internal — slight web on the right side
  { from: 'o_a', to: 'o_b', weight: 0.3 },
  { from: 'o_b', to: 'o_c', weight: 0.3 },
  { from: 'o_c', to: 'o_d', weight: 0.3 },
  { from: 'o_d', to: 'o_e', weight: 0.3 },
  { from: 'o_e', to: 'o_f', weight: 0.3 },
  { from: 'o_f', to: 'o_g', weight: 0.3 },
  { from: 'o_g', to: 'o_h', weight: 0.3 },
];

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------
const NODE_COLOR_DEFAULT = 'rgba(15, 23, 42, 0.32)';
const NODE_COLOR_RING = 'rgba(15, 23, 42, 0.18)';
const EDGE_COLOR = 'rgba(15, 23, 42, 0.18)';

function getNode(id: string): GraphNode | undefined {
  return NODES.find((n) => n.id === id);
}

interface LabelPosition {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

function positionForLabel(node: GraphNode): LabelPosition {
  const side = node.labelSide ?? 'r';
  const gap = 10;
  switch (side) {
    case 'l':
      return { x: node.x - node.r - gap, y: node.y + 3, anchor: 'end' };
    case 't':
      return { x: node.x, y: node.y - node.r - gap, anchor: 'middle' };
    case 'b':
      return { x: node.x, y: node.y + node.r + gap + 8, anchor: 'middle' };
    case 'r':
    default:
      return { x: node.x + node.r + gap, y: node.y + 3, anchor: 'start' };
  }
}

export default function GraphCanvas() {
  return (
    <section
      style={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        minWidth: 0,
      }}
      aria-labelledby="ctx-graph-mid-heading"
    >
      <SectionLabel>SEMANTIC UNDERSTANDING</SectionLabel>
      <div id="ctx-graph-mid-heading">
        <NumberedHeading index="02" title="Graph traversal" />
      </div>
      <p
        style={{
          fontFamily: FONT_SANS,
          fontSize: '12.5px',
          fontWeight: 400,
          color: 'var(--t-text-secondary)',
          lineHeight: 1.55,
          letterSpacing: '-0.005em',
          marginTop: '6px',
          marginBottom: '6px',
          maxWidth: '460px',
        }}
      >
        The orchestrator walks the symbol graph from the brief outward.
        Highlighted nodes land in the Recall Card. The rest stay out of the packet.
      </p>

      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'stretch',
          minHeight: 0,
          marginTop: '8px',
        }}
      >
        <svg
          viewBox="0 0 540 560"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Semantic understanding graph — sources connected through the orchestrator core to the curated outputs"
          style={{
            display: 'block',
            maxHeight: '560px',
          }}
        >
          {/* Edges */}
          <g>
            {EDGES.map((edge, idx) => {
              const a = getNode(edge.from);
              const b = getNode(edge.to);
              if (!a || !b) return null;
              const weight = edge.weight ?? 0.4;
              const opacity = 0.18 + weight * 0.42;
              const stroke =
                a.highlight && b.highlight
                  ? `rgba(239, 68, 68, ${Math.min(0.6, 0.32 + weight * 0.28)})`
                  : EDGE_COLOR;
              return (
                <line
                  key={`e-${idx}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={stroke}
                  strokeWidth={a.highlight && b.highlight ? 1.1 : 0.7}
                  strokeOpacity={a.highlight && b.highlight ? 1 : opacity}
                  strokeLinecap="round"
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {NODES.map((node) => {
              const fill = node.highlight ? BRAND_ORANGE : NODE_COLOR_DEFAULT;
              const ring = node.highlight ? `${BRAND_ORANGE}` : NODE_COLOR_RING;
              return (
                <g key={node.id}>
                  {node.highlight && (
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={node.r + 6}
                      fill="none"
                      stroke={BRAND_ORANGE}
                      strokeOpacity={0.18}
                      strokeWidth={1}
                    />
                  )}
                  <circle
                    cx={node.x}
                    cy={node.y}
                    r={node.r}
                    fill={fill}
                    stroke={ring}
                    strokeOpacity={node.highlight ? 0.5 : 0.22}
                    strokeWidth={1}
                  />
                </g>
              );
            })}
          </g>

          {/* Labels — drawn last so they sit above edges and nodes. */}
          <g>
            {NODES.filter((n) => n.label).map((node) => {
              const pos = positionForLabel(node);
              return (
                <g key={`label-${node.id}`}>
                  {/* tiny tick from node to label for legibility on the
                      right-side labels (where the label drifts away) */}
                  {node.labelSide === 'r' && (
                    <line
                      x1={node.x + node.r + 2}
                      y1={node.y}
                      x2={pos.x - 4}
                      y2={pos.y - 3}
                      stroke="rgba(15, 23, 42, 0.28)"
                      strokeWidth={0.7}
                    />
                  )}
                  <text
                    x={pos.x}
                    y={pos.y}
                    textAnchor={pos.anchor}
                    fontFamily={FONT_MONO}
                    fontSize="10"
                    fontWeight={500}
                    letterSpacing="0.01em"
                    fill="var(--t-text)"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </section>
  );
}
