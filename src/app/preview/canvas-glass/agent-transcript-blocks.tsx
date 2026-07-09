'use client';

/**
 * agent-transcript-blocks — IDE-parity transcript rendering for canvas agent
 * cards (operator directive 2026-07-08: "the transcripts formatted like the
 * agents on the default IDE … the indicators and the cards and all the
 * beautiful stuff — when we chat to agents on the canvas").
 *
 * The desktop IDE renders its transcript from a richer `MobileTranscriptEntry`
 * shape through `ChatMessageList` / `TurnSummaryCard` / `ChatActionCard` /
 * `ToolCallChipCluster`. Those components are `--t-*`-themed and coupled to
 * desktop providers, so they don't port to the canvas verbatim. What DOES port
 * is the *vocabulary* and the *pure classification* — we reuse the IDE's
 * `classifyToolCall` + `extractO8AskQuestion` (identical truth: a worker `o8 ask`
 * exec reads as the same "Brain" chip both sides) and rebuild the visuals with
 * the canvas CHROME scale + `--cnv-*` tokens so they read right inside the
 * CSS-zoom layer, at the card's compact width.
 *
 * The data source stays `use-agent-transcript` (the same normalized
 * `TranscriptEvent[]` the IDE packet tabs read). `buildAgentTranscriptBlocks`
 * folds that flat stream into the same block shapes the IDE shows: clean
 * assistant prose, tool-call pill clusters (collapsed after 3+), rolled-up turn
 * summaries ("Worked for X · N tools"), errors, and a running indicator.
 */

import { useState, type CSSProperties } from 'react';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import { classifyToolCall, extractO8AskQuestion } from '@/components/desktop/orchestrator/ToolCallChip';
import { CHROME, FONT } from './ui';

/** IDE running-chip orange (ToolCallChip). One orange, running only. */
const RUNNING = '#FF5A1F';
const ERROR = '#f87171';

type ToolKind = 'read' | 'write' | 'delegate' | 'spec' | 'shell' | 'generic';
type ToolStatus = 'running' | 'done' | 'error';

interface ToolEntry {
  key: string;
  /** Original tool name — used to pair a later tool_result by name. */
  rawTool: string;
  verb: string;
  kind: ToolKind;
  argument: string | null;
  status: ToolStatus;
}

export type AgentBlock =
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'tools'; seq: number; tools: ToolEntry[] }
  | { kind: 'turn'; seq: number; elapsedMs: number; toolCount: number; editCount: number }
  | { kind: 'error'; seq: number; text: string };

/** Collapse threshold — mirrors ToolCallChipCluster's COLLAPSE_AT. A cluster of
 *  ≥3 calls shows one summary pill + "+N more" instead of a pill wall. */
const COLLAPSE_AT = 3;

function compact(text: string, max = 72): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max - 1)}…`;
}

function toMs(ts: string): number | null {
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function toolEntry(ev: Extract<TranscriptEvent, { type: 'tool_call' }>): ToolEntry {
  const command = ev.summary || ev.args || '';
  const { verb, kind } = classifyToolCall(ev.tool, command);
  const brain = extractO8AskQuestion(command);
  const argument = brain ? compact(brain) : compact(ev.summary || ev.args || '');
  return {
    key: `t-${ev.seq}`,
    rawTool: ev.tool,
    verb,
    kind: (kind ?? 'generic') as ToolKind,
    argument: argument || null,
    status: 'running',
  };
}

/**
 * Fold the normalized transcript into IDE-vocabulary blocks.
 *
 * - Consecutive tool_call/tool_result events between assistant messages group
 *   into ONE tool cluster (the IDE's pill-cluster). A tool_result resolves the
 *   most recent still-running call with the same tool name (the normalizer
 *   already re-labels a result with its call's tool via call_id pairing, so
 *   name-matching in order is reliable) → running → done/error.
 * - assistant text and errors flush the open cluster and stand alone.
 * - `done` (turn.completed) closes a turn into a rolled-up summary with the
 *   turn's elapsed + tool/edit counts.
 * - `steer` is dropped — the card composer owns those as its own optimistic
 *   list, so surfacing them here would double them.
 */
export function buildAgentTranscriptBlocks(events: TranscriptEvent[]): AgentBlock[] {
  const blocks: AgentBlock[] = [];
  let cluster: ToolEntry[] | null = null;
  let clusterSeq = 0;
  let turnStartMs: number | null = null;
  let turnToolCount = 0;
  let turnEditCount = 0;

  const flush = () => {
    if (cluster && cluster.length > 0) blocks.push({ kind: 'tools', seq: clusterSeq, tools: cluster });
    cluster = null;
  };

  for (const ev of events) {
    if (turnStartMs === null) turnStartMs = toMs(ev.ts);

    if (ev.type === 'assistant') {
      flush();
      const text = ev.text.trim();
      if (text) blocks.push({ kind: 'assistant', seq: ev.seq, text });
    } else if (ev.type === 'tool_call') {
      if (!cluster) { cluster = []; clusterSeq = ev.seq; }
      const entry = toolEntry(ev);
      cluster.push(entry);
      turnToolCount += 1;
      if (entry.kind === 'write') turnEditCount += 1;
    } else if (ev.type === 'tool_result') {
      if (cluster) {
        for (let i = cluster.length - 1; i >= 0; i -= 1) {
          if (cluster[i].status === 'running' && cluster[i].rawTool === ev.tool) {
            cluster[i].status = ev.ok ? 'done' : 'error';
            break;
          }
        }
      }
    } else if (ev.type === 'error') {
      flush();
      blocks.push({ kind: 'error', seq: ev.seq, text: ev.message.trim() || 'Error' });
    } else if (ev.type === 'done') {
      flush();
      // Roll up only turns that actually DID work (ran tools / edited files) —
      // matches the IDE, which anchors a TurnSummaryCard to tool-heavy turns and
      // leaves a pure conversational reply as just its assistant block.
      if (turnToolCount > 0) {
        const endMs = toMs(ev.ts);
        const elapsedMs = turnStartMs !== null && endMs !== null ? Math.max(0, endMs - turnStartMs) : 0;
        blocks.push({ kind: 'turn', seq: ev.seq, elapsedMs, toolCount: turnToolCount, editCount: turnEditCount });
      }
      turnStartMs = null;
      turnToolCount = 0;
      turnEditCount = 0;
    }
    // 'steer' — intentionally skipped (composer owns the optimistic list).
  }
  flush();
  return blocks;
}

/** Human duration for a settled turn ("<1s" / "42s" / "3m" / "3m 20s" / "1h 4m"). */
export function formatDurationShort(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

// ── glyphs (IDE ToolCallGlyph shapes, canvas-sized) ──────────────────────────

function ToolGlyph({ kind, color }: { kind: ToolKind; color: string }) {
  const common = {
    width: 10,
    height: 10,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    style: { flexShrink: 0, display: 'block' as const },
  };
  switch (kind) {
    case 'read':
      return (<svg {...common}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" /><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" /></svg>);
    case 'write':
      return (<svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" /></svg>);
    case 'delegate':
      return (<svg {...common}><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>);
    case 'spec':
      return (<svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h6" /></svg>);
    case 'shell':
      return (<svg {...common}><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></svg>);
    default:
      return (<svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>);
  }
}

function ClockGlyph({ color }: { color: string }) {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, display: 'block' }}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5 V8 L10.5 9.5" />
    </svg>
  );
}

// ── pills + clusters ─────────────────────────────────────────────────────────

function ToolPill({ tool }: { tool: ToolEntry }) {
  const accent = tool.status === 'running' ? RUNNING : tool.status === 'error' ? ERROR : 'var(--cnv-ink-muted)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        maxWidth: '100%',
        height: 20,
        paddingLeft: 7,
        paddingRight: 8,
        borderRadius: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--cnv-edge)',
        background: 'var(--cnv-tint)',
        fontFamily: FONT,
      }}
    >
      <span style={tool.status === 'running' ? { display: 'inline-flex', animation: 'o8ToolChipPulse 1.6s ease-in-out infinite' } : { display: 'inline-flex' }}>
        <ToolGlyph kind={tool.kind} color={accent} />
      </span>
      <span style={{ fontSize: 8.5, fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', color: tool.status === 'running' ? accent : 'var(--cnv-ink-muted)', flexShrink: 0 }}>
        {tool.verb}
      </span>
      {tool.argument ? (
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 9.5, color: 'var(--cnv-ink-muted)' }}>
          {tool.argument}
        </span>
      ) : null}
    </span>
  );
}

const clusterMoreButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--cnv-edge)',
  borderRadius: 999,
  background: 'transparent',
  color: 'var(--cnv-ink-muted)',
  fontFamily: FONT,
  fontSize: 9.5,
  fontWeight: 300,
  letterSpacing: '0.01em',
  paddingTop: 2,
  paddingBottom: 2,
  paddingLeft: 8,
  paddingRight: 8,
  cursor: 'pointer',
};

function ToolCluster({ tools }: { tools: ToolEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const collapsed = !showAll && tools.length >= COLLAPSE_AT;
  // Collapsed pick: prefer a running tool so the operator sees what's in flight.
  const summary = tools.find((t) => t.status === 'running') ?? tools[tools.length - 1];
  const hiddenCount = Math.max(0, tools.length - 1);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', flexWrap: 'wrap', gap: 5 }} onPointerDown={(event) => event.stopPropagation()}>
      {collapsed ? (
        <>
          <ToolPill tool={summary} />
          <button
            type="button"
            onClick={() => setShowAll(true)}
            aria-label={`Show all ${tools.length} tool calls`}
            style={clusterMoreButton}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
          >
            +{hiddenCount} more
          </button>
        </>
      ) : (
        <>
          {tools.map((tool) => <ToolPill key={tool.key} tool={tool} />)}
          {tools.length >= COLLAPSE_AT ? (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              aria-label="Collapse tool calls"
              style={clusterMoreButton}
              onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--cnv-ink)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--cnv-ink-muted)'; }}
            >
              Collapse
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── turn summary (TurnSummaryCard header, compact) ───────────────────────────

function CanvasTurnSummary({ elapsedMs, toolCount, editCount }: { elapsedMs: number; toolCount: number; editCount: number }) {
  const stats = [
    toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null,
    editCount > 0 ? `${editCount} ${editCount === 1 ? 'edit' : 'edits'}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div
      role="group"
      aria-label="Turn summary"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--cnv-edge)',
        background: 'var(--cnv-tint)',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 10,
        paddingRight: 10,
      }}
    >
      <ClockGlyph color="var(--cnv-ink-muted)" />
      <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {elapsedMs > 0 ? `Worked for ${formatDurationShort(elapsedMs)}` : 'Turn complete'}
      </span>
      {stats ? (
        <span style={{ flexShrink: 0, fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 9.5, letterSpacing: '0.2px', color: 'var(--cnv-ink-muted)' }}>
          {stats}
        </span>
      ) : null}
    </div>
  );
}

// ── assistant + error + running indicator ────────────────────────────────────

function AssistantText({ text }: { text: string }) {
  return (
    <div style={{ fontSize: CHROME.bodySize, fontWeight: 300, lineHeight: 1.45, letterSpacing: '-0.1px', color: 'var(--cnv-ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {text}
    </div>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: CHROME.captionSize, fontWeight: 300, lineHeight: 1.4, letterSpacing: '-0.1px', color: ERROR }}>
      <span aria-hidden style={{ flexShrink: 0, opacity: 0.7 }}>!</span>
      <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{text}</span>
    </div>
  );
}

/** Running indicator — the IDE's inline "is thinking…" bubble, canvas-sized.
 *  Render at the transcript tail while the lane is genuinely live. */
export function AgentThinkingRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 1 }} aria-label="Agent working">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          aria-hidden
          style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--cnv-ink-muted)', animation: `o8ToolChipPulse 1.2s ease-in-out ${index * 0.18}s infinite` }}
        />
      ))}
      <span style={{ fontSize: CHROME.captionSize, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--cnv-ink-muted)', fontFamily: FONT }}>working…</span>
    </div>
  );
}

/** Renders the folded transcript blocks with the IDE vocabulary. */
export function AgentTranscriptBlocks({ blocks }: { blocks: AgentBlock[] }) {
  return (
    <>
      {blocks.map((block) => {
        if (block.kind === 'assistant') return <AssistantText key={block.seq} text={block.text} />;
        if (block.kind === 'tools') return <ToolCluster key={block.seq} tools={block.tools} />;
        if (block.kind === 'turn') return <CanvasTurnSummary key={block.seq} elapsedMs={block.elapsedMs} toolCount={block.toolCount} editCount={block.editCount} />;
        return <ErrorLine key={block.seq} text={block.text} />;
      })}
    </>
  );
}
