'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyToolCall as classifyToolCallChip,
  extractO8AskQuestion,
  type ToolCallChipStatus,
} from '@/components/desktop/orchestrator/ToolCallChip';
import { ShimmerLine, TurnChevron } from './turn-line';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import { BROWSER_PIP_EVENT } from '@/components/desktop/BrowserPipCard';

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return sanitizeTranscriptText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return sanitizeTranscriptText(JSON.stringify(value, null, 2));
  } catch {
    return String(value);
  }
}

function firstDetail(args: Record<string, unknown> | undefined, keys: string[]) {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = sanitizeTranscriptText(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compact(text: string, max = 84) {
  const singleLine = sanitizeTranscriptText(text).replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 1)}…`;
}

/** Trim an error payload for the inline error card. Keeps newlines (so a
 *  stack/tsc dump stays legible under pre-wrap) but caps total length. */
function truncateError(text: string, max = 600) {
  const cleaned = sanitizeTranscriptText(text).trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

function shellCommandOf(tool: MobileTranscriptToolCall): string | null {
  const name = tool.name.toLowerCase();
  if (name !== 'exec' && name !== 'exec_command' && name !== 'bash' && name !== 'shell') return null;
  return firstDetail(tool.args ?? {}, ['command', 'cmd', 'shell']);
}

/** classifyToolCall with the shell command threaded through, so worker
 *  `o8 ask` execs render as the same Brain chip the orchestrator gets. */
function classifyTool(tool: MobileTranscriptToolCall) {
  return classifyToolCallChip(tool.name, shellCommandOf(tool));
}

function toolArgument(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const name = tool.name.toLowerCase();

  if (name === 'exec' || name === 'exec_command' || name === 'bash' || name === 'shell') {
    const command = firstDetail(args, ['command', 'cmd', 'shell']);
    const brainQuestion = command ? extractO8AskQuestion(command) : null;
    if (brainQuestion) return compact(brainQuestion);
    return compact(command ?? 'terminal command');
  }
  if (name === 'write_stdin') {
    return compact(firstDetail(args, ['chars']) ?? firstDetail(args, ['session_id', 'sessionId']) ?? 'terminal input');
  }
  if (name.includes('read') || name === 'grep' || name === 'glob' || name === 'ls' || name === 'list_files') {
    return compact(firstDetail(args, ['file_path', 'path', 'pattern', 'query']) ?? 'workspace read');
  }
  if (name.includes('write') || name.includes('edit') || name.includes('patch')) {
    return compact(firstDetail(args, ['file_path', 'filePath', 'path', 'notebook_path']) ?? 'file change');
  }
  if (name.includes('search')) {
    return compact(firstDetail(args, ['query', 'q']) ?? 'search');
  }
  if (name.includes('fetch') || name.includes('browser')) {
    return compact(firstDetail(args, ['url', 'href', 'action']) ?? 'browser action');
  }
  if (name.endsWith('cortex_ask')) {
    return compact(firstDetail(args, ['question']) ?? 'brain question');
  }

  return compact(
    firstDetail(args, ['path', 'file_path', 'url', 'query', 'command', 'cmd', 'prompt', 'question'])
    ?? tool.preview
    ?? tool.result
    ?? 'tool activity',
  );
}

function chipStatus(tool: MobileTranscriptToolCall): ToolCallChipStatus {
  if (tool.status === 'error') return 'error';
  return tool.status === 'running' || tool.status === 'calling' ? 'running' : 'done';
}

function toolStatusLabel(tool: MobileTranscriptToolCall) {
  if (tool.status === 'calling') return 'calling';
  if (tool.status === 'running') return 'running';
  if (tool.status === 'error') return 'error';
  return 'done';
}

function detailRows(tool: MobileTranscriptToolCall) {
  return [
    { label: 'Name', value: tool.name },
    { label: 'Status', value: toolStatusLabel(tool) },
    { label: 'Arguments', value: stringifyValue(tool.args) },
    { label: 'Preview', value: stringifyValue(tool.preview) },
    { label: 'Result', value: stringifyValue(tool.result) },
    { label: 'Launch', value: stringifyValue(tool.launchLink) },
  ].filter((row) => row.value.trim().length > 0);
}

function toolKey(tool: MobileTranscriptToolCall, index: number) {
  return tool.id?.trim() ? tool.id : `${tool.name}-${index}`;
}

/**
 * Turn-grammar rollup (Cursor parity, vid2 mechanics — operator ruling
 * 2026-07-13): live activity renders as ONE shimmering text line (the current
 * call), settled turns as one slim rollup line — "Explored 4 files · Ran 2
 * commands ›" — whose chevron expands per-call text lines (no pills, no
 * Collapse button). Errors always render as red cards and never fold.
 */
export function describeToolRollupParts(toolCalls: MobileTranscriptToolCall[], mode: 'lead' | 'fold' = 'lead'): string[] {
  let explored = 0;
  let ran = 0;
  let dispatched = 0;
  let edited = 0;
  let other = 0;
  for (const tool of toolCalls) {
    const kind = classifyTool(tool).kind;
    if (kind === 'read' || kind === 'spec') explored += 1;
    else if (kind === 'shell') ran += 1;
    else if (kind === 'delegate') dispatched += 1;
    else if (kind === 'write') edited += 1;
    else other += 1;
  }
  // 'lead' capitalizes for a standalone line; 'fold' lowercases so the parts
  // read naturally inside the edit aggregate ("Edited 12 files, ran 1 command").
  const cased = (word: string) => (mode === 'lead' ? word : word.toLowerCase());
  const parts: string[] = [];
  if (explored > 0) parts.push(`${cased('Explored')} ${explored} ${explored === 1 ? 'file' : 'files'}`);
  if (ran > 0) parts.push(`${cased('Ran')} ${ran} ${ran === 1 ? 'command' : 'commands'}`);
  if (dispatched > 0) parts.push(`${cased('Dispatched')} ${dispatched} ${dispatched === 1 ? 'agent' : 'agents'}`);
  if (edited > 0) parts.push(`${cased('Edited')} ${edited} ${edited === 1 ? 'file' : 'files'}`);
  if (other > 0) parts.push(`${other} ${other === 1 ? 'tool call' : 'tool calls'}`);
  return parts;
}

function describeToolRollup(toolCalls: MobileTranscriptToolCall[]): string {
  return describeToolRollupParts(toolCalls, 'lead').join(' · ');
}

/** An entry that contributes NOTHING to the transcript except tool calls —
 *  no text, no thinking, no media, no status/compaction payload. */
function isToolOnlyEntry(entry: MobileTranscriptEntry): boolean {
  return entry.role === 'assistant'
    && (entry.toolCalls?.length ?? 0) > 0
    && !entry.text?.trim()
    && !entry.thinking?.trim()
    && !entry.thinkingActive
    && !(entry.media?.length)
    && !entry.command
    && !entry.compaction;
}

/**
 * Merge CONSECUTIVE tool-only assistant entries into one, so parallel work
 * that the backend emitted as separate assistant messages renders as a single
 * cluster (one counted "Running N commands" line) instead of a stack of
 * shimmer rows (operator ruling 2026-07-13 — five parallel eval commands ate
 * ~150px of transcript). Render-time derivation only: state is untouched, the
 * merged entry keeps the first entry's identity, and any entry with its own
 * text/thinking/media terminates the run.
 */
export function mergeAdjacentToolOnlyEntries(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  let merged: MobileTranscriptEntry[] | null = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (isToolOnlyEntry(entry) && i + 1 < entries.length && isToolOnlyEntry(entries[i + 1])) {
      const run = [entry];
      while (i + 1 < entries.length && isToolOnlyEntry(entries[i + 1])) {
        i += 1;
        run.push(entries[i]);
      }
      if (merged === null) merged = entries.slice(0, entries.indexOf(entry));
      merged.push({
        ...run[0],
        toolCalls: run.flatMap((e) => e.toolCalls ?? []),
      });
      continue;
    }
    if (merged !== null) merged.push(entry);
  }
  return merged ?? entries;
}

export function ToolCallChipCluster({ toolCalls, suppressSettledRollup = false }: { toolCalls: MobileTranscriptToolCall[]; suppressSettledRollup?: boolean }) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Browser PIP trigger: a cluster containing browser work is
  // the hover target — the whole cluster, not a tiny pill, per the reference
  // pattern. The BrowserPipCard host owns dwell/grace timing and gating.
  const hasBrowserWork = useMemo(
    () => toolCalls.some((tool) => (tool.name ?? '').toLowerCase().includes('browser')),
    [toolCalls],
  );
  const broadcastPipHover = (hovering: boolean) => {
    if (!hasBrowserWork || typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { hovering } }));
  };
  useEffect(() => () => {
    // Unmount with the pointer still inside would strand the card open.
    if (hasBrowserWork && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { hovering: false } }));
    }
  }, [hasBrowserWork]);
  const selectedTool = useMemo(() => {
    if (!expandedToolId) return null;
    return toolCalls.find((tool, index) => toolKey(tool, index) === expandedToolId) ?? null;
  }, [expandedToolId, toolCalls]);

  // Collapsed-state pick: surface a FAILED call first (an error must never hide
  // behind a "+N more"), then an actively-running one so the user sees what is
  // in flight, falling back to the latest call when everything's done. Hook must
  // live above the early-return below to keep hook order stable across renders
  // where toolCalls toggles between empty and non-empty.
  const summaryTool = useMemo(() => {
    if (toolCalls.length === 0) return null;
    const errored = toolCalls.find((tool) => chipStatus(tool) === 'error');
    const running = toolCalls.find((tool) => chipStatus(tool) === 'running');
    return errored ?? running ?? toolCalls[toolCalls.length - 1];
  }, [toolCalls]);

  // Errored calls render their output inline, always visible (no click) — an
  // agent failure should be legible at a glance in the turn (deliverable 3).
  const erroredTools = useMemo(
    () => toolCalls.filter((tool) => tool.status === 'error'),
    [toolCalls],
  );

  useEffect(() => {
    if (!selectedTool) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setExpandedToolId(null);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setExpandedToolId(null);
    }

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedTool]);

  if (toolCalls.length === 0 || !summaryTool) return null;

  // Settled rollup: every call done, nothing errored → one slim text line.
  const allSettled = erroredTools.length === 0
    && toolCalls.every((tool) => chipStatus(tool) === 'done');
  const runningTools = toolCalls.filter((tool) => chipStatus(tool) === 'running');
  const runningTool = runningTools[0] ?? null;
  const runningCount = runningTools.length;
  // Noun for the counted line: one kind reads naturally ("5 commands",
  // "3 files"), mixed kinds fall back to "tool calls".
  const runningKinds = new Set(runningTools.map((tool) => classifyTool(tool).kind));
  const runningNoun = runningKinds.size === 1
    ? (runningKinds.has('shell') ? 'commands'
      : runningKinds.has('read') || runningKinds.has('spec') ? 'files'
        : runningKinds.has('delegate') ? 'agents'
          : runningKinds.has('write') ? 'edits' : 'tool calls')
    : 'tool calls';

  // Folded into the edit-run aggregate line ("Edited 12 files, ran 1 command"):
  // a clean settled cluster paints nothing of its own. Errors never fold.
  if (allSettled && suppressSettledRollup && !showAll) return null;

  return (
    <div
      ref={rootRef}
      onMouseEnter={() => broadcastPipHover(true)}
      onMouseLeave={() => broadcastPipHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        maxWidth: '92%',
        minWidth: 0,
      }}
    >
      {runningTool && !showAll ? (
        runningCount > 1 ? (
          // Parallel work collapses to ONE counted line (operator ruling
          // 2026-07-13: five stacked "Running…" rows ate ~150px of transcript).
          // Same grammar as the edited-files aggregate — count on one line,
          // chevron expands to the per-call list.
          <button
            type="button"
            onClick={() => setShowAll(true)}
            aria-expanded={false}
            aria-label={`Show the ${runningCount} tool calls currently running`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: 'none',
              background: 'transparent',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <ShimmerLine>{`Running ${runningCount} ${runningNoun}`}</ShimmerLine>
            <TurnChevron open={false} />
          </button>
        ) : (
          // Live: a plain shimmering text line — the Cursor text-sheen loader.
          // No pills, no boxes; settled calls fold into the rollup on turn end.
          <ShimmerLine>
            {classifyTool(runningTool).verb === 'Read' ? 'Reading' : classifyTool(runningTool).verb === 'Run' ? 'Running' : classifyTool(runningTool).verb}
            <span style={{ fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}>
              {toolArgument(runningTool)}
            </span>
          </ShimmerLine>
        )
      ) : (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          aria-label={showAll ? 'Collapse the tool call list' : `Show all ${toolCalls.length} tool calls in this turn`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            border: 'none',
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            cursor: 'pointer',
            color: 'var(--t-text-muted)',
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span>{describeToolRollup(toolCalls)}</span>
          <TurnChevron open={showAll} />
        </button>
      )}

      {showAll ? toolCalls.map((tool, index) => {
        const key = toolKey(tool, index);
        const classified = classifyTool(tool);
        const status = chipStatus(tool);
        return (
          <button
            key={key}
            type="button"
            onClick={() => setExpandedToolId((current) => current === key ? null : key)}
            aria-label={`${classified.verb} ${toolArgument(tool)} — show detail`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 12,
              border: 'none',
              background: 'transparent',
              textAlign: 'left',
              cursor: 'pointer',
              minWidth: 0,
              color: 'var(--t-text-muted)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12,
              fontWeight: 400,
              letterSpacing: '-0.005em',
              lineHeight: 1.5,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <span style={{ flexShrink: 0 }}>{classified.verb}</span>
            <span
              style={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                fontSize: 11,
                color: 'var(--t-text-secondary)',
              }}
            >
              {toolArgument(tool)}
            </span>
            {status === 'error' ? (
              <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 500, color: 'var(--t-brand-red, #ef4444)' }}>failed</span>
            ) : null}
          </button>
        );
      }) : null}

      {erroredTools.map((tool, index) => {
        const errorText = truncateError(tool.result ?? tool.preview ?? 'Tool call failed');
        return (
          <div
            key={`err-${toolKey(tool, index)}`}
            role="alert"
            style={{
              flexBasis: '100%',
              marginTop: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 5,
              paddingTop: 8,
              paddingRight: 10,
              paddingBottom: 8,
              paddingLeft: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'color-mix(in srgb, var(--t-brand-red, #ef4444) 42%, transparent)',
              borderRadius: 10,
              background: 'color-mix(in srgb, var(--t-brand-red, #ef4444) 8%, var(--t-bg-card))',
              color: 'var(--t-text-secondary)',
              fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
              maxWidth: '100%',
              overflow: 'hidden',
            }}
          >
            <span style={{
              fontFamily: 'var(--font-sans-system)',
              fontSize: 9,
              fontWeight: 600,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              color: 'var(--t-brand-red, #ef4444)',
            }}>
              {`${tool.name} failed`}
            </span>
            <span style={{
              fontSize: 10.5,
              lineHeight: 1.45,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {errorText}
            </span>
          </div>
        );
      })}

      {selectedTool ? (
        <div
          role="dialog"
          aria-label={`${selectedTool.name} tool call detail`}
          style={{
            flexBasis: '100%',
            marginTop: 7,
            width: 'min(560px, 100%)',
            maxHeight: 320,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-divider-subtle)',
            borderRadius: 18,
            background: 'color-mix(in srgb, var(--t-bg-card) 92%, transparent)',
            boxShadow: 'var(--t-shadow-card, 0 18px 45px rgba(15, 23, 42, 0.08))',
            color: 'var(--t-text)',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 300,
                color: 'var(--t-text-muted)',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}>
                Tool call
              </div>
              <div style={{
                marginTop: 3,
                fontSize: 13,
                fontWeight: 400,
                color: 'var(--t-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
              }}>
                {selectedTool.name}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExpandedToolId(null)}
              aria-label="Close tool call detail"
              style={{
                flexShrink: 0,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider-subtle)',
                borderRadius: 999,
                background: 'var(--t-bg-card)',
                color: 'var(--t-text-secondary)',
                fontSize: 11,
                fontWeight: 400,
                paddingTop: 4,
                paddingRight: 8,
                paddingBottom: 4,
                paddingLeft: 8,
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            {detailRows(selectedTool).map((row) => (
              <div
                key={row.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '74px minmax(0, 1fr)',
                  gap: 10,
                  alignItems: 'start',
                }}
              >
                <div style={{
                  fontSize: 10,
                  fontWeight: 300,
                  color: 'var(--t-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  paddingTop: 2,
                }}>
                  {row.label}
                </div>
                <pre style={{
                  margin: 0,
                  maxHeight: row.label === 'Arguments' || row.label === 'Result' ? 160 : undefined,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--t-text-secondary)',
                  fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)',
                  fontSize: 11,
                  lineHeight: 1.45,
                }}>
                  {row.value}
                </pre>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

