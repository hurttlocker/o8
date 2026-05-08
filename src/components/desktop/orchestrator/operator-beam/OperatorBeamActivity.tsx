'use client';

import { useMemo, useState } from 'react';

type BeamMode = 'working' | 'review' | 'blocked';
type NodeTone = 'blue' | 'orange' | 'green' | 'red' | 'slate';
type NodeIconKind = 'memory' | 'scope' | 'inspect' | 'orchestrator' | 'worker' | 'diff' | 'verify';

const STAGE_WIDTH = 760;
const STAGE_HEIGHT = 300;

interface BeamNode {
  id: string;
  label: string;
  detail: string;
  tone: NodeTone;
  icon: NodeIconKind;
  x: number;
  y: number;
  side: 'left' | 'right' | 'center';
}

interface BeamEvent {
  id: string;
  label: string;
  detail: string;
  tone: NodeTone;
}

const MODE_LABELS: Record<BeamMode, string> = {
  working: 'Working',
  review: 'Review',
  blocked: 'Blocked',
};

const TONE_COLORS: Record<NodeTone, { main: string; soft: string; border: string; text: string }> = {
  blue: { main: '#2563eb', soft: 'rgba(37, 99, 235, 0.1)', border: 'rgba(37, 99, 235, 0.2)', text: '#1d4ed8' },
  orange: { main: '#f97316', soft: 'rgba(249, 115, 22, 0.1)', border: 'rgba(249, 115, 22, 0.24)', text: '#c2410c' },
  green: { main: '#16a34a', soft: 'rgba(22, 163, 74, 0.1)', border: 'rgba(22, 163, 74, 0.22)', text: '#15803d' },
  red: { main: '#ef4444', soft: 'rgba(239, 68, 68, 0.1)', border: 'rgba(239, 68, 68, 0.24)', text: '#dc2626' },
  slate: { main: '#64748b', soft: 'rgba(100, 116, 139, 0.1)', border: 'rgba(100, 116, 139, 0.2)', text: '#475569' },
};

const BEAM_KEYFRAMES = `
@keyframes o8OperatorBeamTravel {
  0% { stroke-dashoffset: 90; opacity: 0; }
  12% { opacity: 1; }
  72% { opacity: 1; }
  100% { stroke-dashoffset: -90; opacity: 0; }
}

@keyframes o8OperatorNodePulse {
  0%, 100% { transform: scale(0.94); opacity: 0.34; }
  50% { transform: scale(1.08); opacity: 0.78; }
}

@keyframes o8OperatorThinking {
  0%, 100% { transform: translateY(0); opacity: 0.42; }
  50% { transform: translateY(-2px); opacity: 1; }
}
`;

function pathBetween(from: BeamNode, to: BeamNode) {
  const curve = Math.abs(from.y - to.y) > 8 ? (from.y < to.y ? 72 : -72) : 0;
  const midX = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${midX} ${from.y + curve}, ${midX} ${to.y - curve}, ${to.x} ${to.y}`;
}

function NodeGlyph({
  kind,
  size = 22,
  strokeWidth = 1.75,
}: {
  kind: NodeIconKind;
  size?: number;
  strokeWidth?: number;
}) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth,
  };

  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      {kind === 'memory' ? (
        <>
          <rect x="5" y="5" width="14" height="5" rx="2" {...common} />
          <rect x="5" y="10.5" width="14" height="5" rx="2" {...common} opacity="0.72" />
          <rect x="5" y="16" width="14" height="3" rx="1.5" {...common} opacity="0.48" />
          <path d="M8 7.5h.01M10.5 7.5H16" {...common} />
        </>
      ) : null}
      {kind === 'scope' ? (
        <>
          <circle cx="7" cy="12" r="2.25" {...common} />
          <circle cx="17" cy="7" r="2.25" {...common} />
          <circle cx="17" cy="17" r="2.25" {...common} />
          <path d="M9.15 11.25c2.4-.82 3.8-2.2 5.7-3.45M9.15 12.75c2.4.82 3.8 2.2 5.7 3.45" {...common} />
        </>
      ) : null}
      {kind === 'inspect' ? (
        <>
          <path d="M7 5.5h6.5L17 9v8.5A1.5 1.5 0 0 1 15.5 19H7a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 7 5.5Z" {...common} />
          <path d="M13.5 5.5V9H17M8.5 10.5h4M8.5 13.5h2.5" {...common} opacity="0.7" />
          <circle cx="14.5" cy="15.5" r="2.2" {...common} />
          <path d="m16.1 17.1 2.1 2.1" {...common} />
        </>
      ) : null}
      {kind === 'orchestrator' ? (
        <>
          <circle cx="12" cy="12" r="4.5" {...common} />
          <circle cx="5.5" cy="7.5" r="1.6" {...common} opacity="0.72" />
          <circle cx="18.5" cy="7.5" r="1.6" {...common} opacity="0.72" />
          <circle cx="18.5" cy="16.5" r="1.6" {...common} opacity="0.72" />
          <path d="M7 8.3 8.8 9.6M15.2 9.6 17 8.3M15.4 14.4l1.8 1.2" {...common} opacity="0.72" />
          <text x="12" y="14.3" textAnchor="middle" fontSize="5.4" fontWeight="650" fill="currentColor" stroke="none">
            o8
          </text>
        </>
      ) : null}
      {kind === 'worker' ? (
        <>
          <rect x="4.5" y="6" width="15" height="12" rx="3" {...common} />
          <path d="M7 9h10M8 12l2 1.6L8 15.2M12.5 15.2h3.5" {...common} />
          <circle cx="17" cy="9" r=".55" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {kind === 'diff' ? (
        <>
          <path d="M7 4.8h6l4 4v10.4H7z" {...common} />
          <path d="M13 4.8V9h4" {...common} opacity="0.72" />
          <path d="M9.5 12h2.8M9.5 15h2.8M14.7 12h1.8M15.6 11.1v1.8M14.7 15h1.8" {...common} />
        </>
      ) : null}
      {kind === 'verify' ? (
        <>
          <path d="M12 4.7 18 7v5.2c0 3.6-2.15 5.9-6 7.1-3.85-1.2-6-3.5-6-7.1V7z" {...common} />
          <path d="m8.8 12.4 2.1 2.1 4.4-5" {...common} />
        </>
      ) : null}
    </svg>
  );
}

function StatusGlyph({ tone }: { tone: NodeTone }) {
  return tone === 'red' ? (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
      <path d="M2.3 2.3 7.7 7.7M7.7 2.3 2.3 7.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ) : (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
      <path d="m2.1 5.2 1.9 1.9 3.9-4.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function buildNodes(mode: BeamMode): BeamNode[] {
  const blocked = mode === 'blocked';
  const review = mode === 'review';
  return [
    { id: 'memory', label: 'Memory', detail: 'rules + past fixes', tone: 'blue', icon: 'memory', x: 116, y: 64, side: 'left' },
    { id: 'issue', label: 'Scope', detail: 'repo + branch target', tone: 'slate', icon: 'scope', x: 116, y: 150, side: 'left' },
    { id: 'inspect', label: 'Inspect', detail: 'read before write', tone: 'blue', icon: 'inspect', x: 116, y: 236, side: 'left' },
    { id: 'orchestrator', label: 'o8', detail: 'coordinating Fleet', tone: blocked ? 'red' : review ? 'orange' : 'blue', icon: 'orchestrator', x: 380, y: 150, side: 'center' },
    { id: 'worker', label: 'Worker', detail: 'Codex subscription lane', tone: blocked ? 'red' : 'orange', icon: 'worker', x: 644, y: 64, side: 'right' },
    { id: 'diff', label: 'Diff', detail: review ? 'ready for review' : 'streaming changes', tone: review ? 'green' : 'orange', icon: 'diff', x: 644, y: 150, side: 'right' },
    { id: 'verify', label: 'Verify', detail: blocked ? 'blocked on lint' : 'policy + tests', tone: blocked ? 'red' : review ? 'green' : 'slate', icon: 'verify', x: 644, y: 236, side: 'right' },
  ];
}

function buildEvents(mode: BeamMode): BeamEvent[] {
  if (mode === 'blocked') {
    return [
      { id: '1', label: 'Planner narrowed the failing surface', detail: 'ComposerArea owns the slash picker state.', tone: 'blue' },
      { id: '2', label: 'Worker hit a blocker', detail: 'Targeted lint failed on a real hook dependency.', tone: 'red' },
      { id: '3', label: 'Orchestrator paused merge path', detail: 'Waiting for fix before review can continue.', tone: 'orange' },
    ];
  }
  if (mode === 'review') {
    return [
      { id: '1', label: 'Workers finished the patch', detail: 'Slash command routing and picker behavior are updated.', tone: 'green' },
      { id: '2', label: 'Verifier passed targeted checks', detail: 'Typecheck passed; changed-file lint has no errors.', tone: 'green' },
      { id: '3', label: 'Review is ready', detail: 'Open the diff or ask o8 to summarize risk.', tone: 'orange' },
    ];
  }
  return [
    { id: '1', label: 'Orchestrator mapped the task', detail: 'Planner split chat-native updates from graph UI exploration.', tone: 'blue' },
    { id: '2', label: 'Worker lane is active', detail: 'Codex is editing the preview component in this repo.', tone: 'orange' },
    { id: '3', label: 'Verifier is queued', detail: 'Lint and browser smoke will run after the patch settles.', tone: 'slate' },
  ];
}

function NodeBubble({
  node,
  active,
  hovered,
  onFocus,
  onBlur,
}: {
  node: BeamNode;
  active: boolean;
  hovered: boolean;
  onFocus: () => void;
  onBlur: () => void;
}) {
  const tone = TONE_COLORS[node.tone];
  const labelOffset = node.side === 'left' ? -1 : node.side === 'right' ? 1 : 0;
  const x = `${(node.x / STAGE_WIDTH) * 100}%`;
  const y = `${(node.y / STAGE_HEIGHT) * 100}%`;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        transform: 'translate(-50%, -50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexDirection: node.side === 'right' ? 'row-reverse' : 'row',
      }}
    >
      <button
        type="button"
        onPointerEnter={onFocus}
        onPointerLeave={onBlur}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{
          position: 'relative',
          width: node.side === 'center' ? 70 : 50,
          height: node.side === 'center' ? 70 : 50,
          border: 0,
          padding: 0,
          borderRadius: 999,
          background: 'transparent',
          cursor: 'default',
          outline: 'none',
        }}
        aria-label={`${node.label}: ${node.detail}`}
      >
        {active ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: -8,
              borderRadius: 999,
              background: tone.soft,
              animation: 'o8OperatorNodePulse 2.4s ease-in-out infinite',
            }}
          />
        ) : null}
        {hovered ? (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: -5,
              borderRadius: 999,
              border: `1px solid ${tone.border}`,
              boxShadow: `0 0 0 4px ${tone.soft}`,
            }}
          />
        ) : null}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            borderRadius: 999,
            border: `1px solid ${tone.border}`,
            background: 'rgba(255, 255, 255, 0.88)',
            boxShadow: '0 16px 34px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255,255,255,0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tone.text,
            transform: hovered ? 'scale(1.035)' : 'scale(1)',
            transition: 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          <NodeGlyph kind={node.icon} size={node.side === 'center' ? 31 : 22} strokeWidth={node.side === 'center' ? 1.55 : 1.65} />
        </div>
      </button>
      {node.side !== 'center' ? (
        <div
          style={{
            width: node.side === 'right' ? 148 : 138,
            transform: `translateX(${labelOffset * 2}px)`,
            textAlign: node.side === 'right' ? 'right' : 'left',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 640, color: '#172033', lineHeight: 1.1 }}>{node.label}</div>
          <div style={{ marginTop: 3, fontSize: 10, fontWeight: 450, color: '#7c8aa0', lineHeight: 1.2 }}>{node.detail}</div>
        </div>
      ) : null}
    </div>
  );
}

function NodeHoverCard({ node, mode }: { node: BeamNode; mode: BeamMode }) {
  const tone = TONE_COLORS[node.tone];
  const status = node.id === 'worker'
    ? 'using existing subscription lane'
    : node.id === 'diff'
      ? mode === 'review' ? 'ready for operator review' : 'watching file changes'
      : node.id === 'verify'
        ? mode === 'blocked' ? 'blocked before merge' : 'queued after worker'
        : node.id === 'orchestrator'
          ? 'routing work through Fleet'
          : 'feeding context into the run';
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        gap: 8,
        alignItems: 'center',
        minWidth: 264,
        maxWidth: 340,
        padding: '8px 10px',
        borderRadius: 15,
        border: `1px solid ${tone.border}`,
        background: 'rgba(255, 255, 255, 0.84)',
        boxShadow: '0 16px 42px rgba(15, 23, 42, 0.1)',
        backdropFilter: 'blur(18px) saturate(1.2)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: tone.soft,
          color: tone.text,
        }}
      >
        <NodeGlyph kind={node.icon} size={15} strokeWidth={1.65} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 11, fontWeight: 650, color: '#172033', lineHeight: 1.2 }}>
          {node.label}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 10, color: '#718096', lineHeight: 1.25, fontWeight: 500 }}>
          {status}
        </span>
      </span>
    </div>
  );
}

function BeamSvg({ nodes, mode }: { nodes: BeamNode[]; mode: BeamMode }) {
  const center = nodes.find((node) => node.id === 'orchestrator') ?? nodes[3];
  const edges = nodes.filter((node) => node.id !== 'orchestrator').map((node, index) => ({
    id: `${node.id}-${index}`,
    path: node.side === 'left' ? pathBetween(node, center) : pathBetween(center, node),
    tone: TONE_COLORS[node.tone],
    delay: index * 0.36,
  }));

  return (
    <svg
      viewBox={`0 0 ${STAGE_WIDTH} ${STAGE_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      <defs>
        <filter id="o8-beam-glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="3.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      {edges.map((edge) => (
        <path
          key={`${edge.id}-base`}
          d={edge.path}
          fill="none"
          stroke="rgba(148, 163, 184, 0.22)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      ))}
      {edges.map((edge) => (
        <path
          key={edge.id}
          d={edge.path}
          fill="none"
          stroke={mode === 'blocked' ? '#ef4444' : edge.tone.main}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeDasharray="34 86"
          filter="url(#o8-beam-glow)"
          style={{
            animation: `o8OperatorBeamTravel ${mode === 'working' ? 2.6 : 3.4}s cubic-bezier(0.22, 1, 0.36, 1) ${edge.delay}s infinite`,
          }}
        />
      ))}
    </svg>
  );
}

function ActivityEventRow({ event }: { event: BeamEvent }) {
  const tone = TONE_COLORS[event.tone];
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '18px minmax(0, 1fr)',
        gap: 8,
        alignItems: 'start',
        minWidth: 0,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: 999,
          border: `1px solid ${tone.border}`,
          background: tone.soft,
          color: tone.text,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 1,
        }}
      >
        <StatusGlyph tone={event.tone} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 10.75, lineHeight: 1.25, color: '#1f2937', fontWeight: 620 }}>
          {event.label}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 10, lineHeight: 1.3, color: '#7c8aa0', fontWeight: 450 }}>
          {event.detail}
        </span>
      </span>
    </div>
  );
}

export function OperatorBeamActivity({ initialMode = 'working' }: { initialMode?: BeamMode }) {
  const [mode, setMode] = useState<BeamMode>(initialMode);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const nodes = useMemo(() => buildNodes(mode), [mode]);
  const events = useMemo(() => buildEvents(mode), [mode]);
  const hoveredNode = hoveredNodeId ? nodes.find((node) => node.id === hoveredNodeId) ?? null : null;
  const activeNodeIds = mode === 'blocked'
    ? new Set(['orchestrator', 'worker', 'verify'])
    : mode === 'review'
      ? new Set(['orchestrator', 'diff', 'verify'])
      : new Set(['orchestrator', 'worker', 'diff']);

  return (
    <section
      style={{
        borderRadius: 22,
        border: '1px solid rgba(148, 163, 184, 0.18)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.9), rgba(248,250,252,0.82))',
        boxShadow: '0 24px 70px rgba(15, 23, 42, 0.09)',
        overflow: 'hidden',
      }}
    >
      <style>{BEAM_KEYFRAMES}</style>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '14px 16px 10px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: TONE_COLORS[mode === 'blocked' ? 'red' : mode === 'review' ? 'green' : 'orange'].main,
                boxShadow: `0 0 0 4px ${TONE_COLORS[mode === 'blocked' ? 'red' : mode === 'review' ? 'green' : 'orange'].soft}`,
              }}
            />
            <span style={{ fontSize: 11.5, fontWeight: 650, color: '#172033' }}>
              Orchestration update
            </span>
            <span style={{ fontSize: 10.5, color: '#91a0b4', fontWeight: 520 }}>
              {MODE_LABELS[mode]}
            </span>
          </div>
          <div style={{ marginTop: 4, fontSize: 10.75, color: '#7c8aa0', fontWeight: 430 }}>
            Chat-native view of the swarm, not a separate kanban board.
          </div>
        </div>
        <div style={{ display: 'inline-flex', gap: 3, padding: 3, borderRadius: 999, background: 'rgba(15, 23, 42, 0.045)' }}>
          {(['working', 'review', 'blocked'] as BeamMode[]).map((item) => {
            const active = item === mode;
            return (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                style={{
                  height: 24,
                  padding: '0 10px',
                  borderRadius: 999,
                  border: active ? '1px solid rgba(37, 99, 235, 0.18)' : '1px solid transparent',
                  background: active ? 'rgba(255, 255, 255, 0.92)' : 'transparent',
                  color: active ? '#1d4ed8' : '#64748b',
                  boxShadow: active ? '0 6px 18px rgba(15, 23, 42, 0.06)' : 'none',
                  fontSize: 10,
                  fontWeight: 620,
                  cursor: 'pointer',
                }}
              >
                {MODE_LABELS[item]}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ minHeight: 382, display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', minHeight: 312, overflow: 'hidden' }}>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 50% 50%, rgba(37,99,235,0.08), transparent 34%), linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0))',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 'min(820px, calc(100% - 54px))',
              aspectRatio: `${STAGE_WIDTH} / ${STAGE_HEIGHT}`,
              transform: 'translate(-50%, -50%)',
              maxHeight: 292,
            }}
          >
            <BeamSvg nodes={nodes} mode={mode} />
            {nodes.map((node) => (
              <NodeBubble
                key={node.id}
                node={node}
                active={activeNodeIds.has(node.id)}
                hovered={hoveredNodeId === node.id}
                onFocus={() => setHoveredNodeId(node.id)}
                onBlur={() => setHoveredNodeId(null)}
              />
            ))}
            <div
              style={{
                position: 'absolute',
                left: `${(380 / STAGE_WIDTH) * 100}%`,
                top: `${(218 / STAGE_HEIGHT) * 100}%`,
                transform: 'translateX(-50%)',
                display: 'flex',
                gap: 4,
                alignItems: 'center',
                color: '#91a0b4',
                fontSize: 10,
                fontWeight: 560,
              }}
            >
              {[0, 1, 2].map((index) => (
                <span
                  key={index}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
    background: 'currentColor',
    animation: `o8OperatorThinking 1.2s ease-in-out ${index * 0.18}s infinite`,
  }}
/>
              ))}
              <span style={{ marginLeft: 4 }}>coordinating</span>
            </div>
            {hoveredNode ? <NodeHoverCard node={hoveredNode} mode={mode} /> : null}
          </div>
        </div>

        <div
          style={{
            borderTop: '1px solid rgba(148, 163, 184, 0.13)',
            padding: '11px 14px 14px',
            background: 'rgba(255, 255, 255, 0.5)',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
            {events.map((event) => (
              <ActivityEventRow key={event.id} event={event} />
            ))}
          </div>
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              borderRadius: 13,
              border: '1px solid rgba(37, 99, 235, 0.14)',
              background: 'rgba(37, 99, 235, 0.055)',
              padding: '8px 10px',
              color: '#526179',
              fontSize: 10,
              lineHeight: 1.3,
              fontWeight: 500,
            }}
          >
            <span>Hover a node to inspect the lane. Production can bind these nodes to real mission packets.</span>
            <span style={{ color: '#1d4ed8', fontWeight: 650, whiteSpace: 'nowrap' }}>inline only</span>
          </div>
        </div>
      </div>
    </section>
  );
}
