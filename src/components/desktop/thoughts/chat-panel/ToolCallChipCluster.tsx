'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ToolCallChip,
  classifyToolCall as classifyToolCallChip,
  extractO8AskQuestion,
  type ToolCallChipStatus,
} from '@/components/desktop/orchestrator/ToolCallChip';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

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
  return tool.status === 'running' || tool.status === 'calling' ? 'running' : 'done';
}

function toolStatusLabel(tool: MobileTranscriptToolCall) {
  if (tool.status === 'calling') return 'calling';
  if (tool.status === 'running') return 'running';
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
 * Collapse threshold: when an assistant turn fires more tool calls than this,
 * the cluster shows ONE summary chip (running tool if any, else most recent)
 * plus a "+N more" affordance instead of tiling every chip. Picked from
 * dogfood observation — a 73-call architectural exploration shouldn't paint
 * a 24-row pill wall just to convey "I'm reading the codebase." Click the
 * "+N more" chip to expand and inspect every chip individually.
 */
const COLLAPSE_AT = 3;

export function ToolCallChipCluster({ toolCalls }: { toolCalls: MobileTranscriptToolCall[] }) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedTool = useMemo(() => {
    if (!expandedToolId) return null;
    return toolCalls.find((tool, index) => toolKey(tool, index) === expandedToolId) ?? null;
  }, [expandedToolId, toolCalls]);

  // Collapsed-state pick: prefer an actively-running tool so the user sees
  // *what* is in flight. Falls back to the latest call when everything's done.
  // Hook must live above the early-return below to keep hook order stable
  // across renders where toolCalls toggles between empty and non-empty.
  const summaryTool = useMemo(() => {
    if (toolCalls.length === 0) return null;
    const running = toolCalls.find((tool) => chipStatus(tool) === 'running');
    return running ?? toolCalls[toolCalls.length - 1];
  }, [toolCalls]);

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

  const hiddenCount = Math.max(0, toolCalls.length - 1);
  const collapsed = !showAll && toolCalls.length >= COLLAPSE_AT;

  return (
    <div
      ref={rootRef}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        flexWrap: 'wrap',
        gap: 5,
        maxWidth: '92%',
        paddingTop: 2,
        paddingRight: 0,
        paddingBottom: selectedTool ? 4 : 2,
        paddingLeft: 0,
      }}
    >
      {collapsed ? (
        <>
          {(() => {
            const key = toolKey(summaryTool, toolCalls.indexOf(summaryTool));
            const classified = classifyTool(summaryTool);
            return (
              <ToolCallChip
                key={key}
                verb={classified.verb}
                kind={classified.kind}
                argument={toolArgument(summaryTool)}
                status={chipStatus(summaryTool)}
                onClick={() => setExpandedToolId((current) => current === key ? null : key)}
              />
            );
          })()}
          <button
            type="button"
            onClick={() => setShowAll(true)}
            aria-label={`Show all ${toolCalls.length} tool calls in this turn`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              border: '1px solid var(--t-divider-subtle)',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--t-text-muted)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 11,
              fontWeight: 300,
              letterSpacing: '0.01em',
              paddingTop: 3,
              paddingRight: 9,
              paddingBottom: 3,
              paddingLeft: 9,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; }}
          >
            +{hiddenCount} more
          </button>
        </>
      ) : (
        <>
          {toolCalls.map((tool, index) => {
            const key = toolKey(tool, index);
            const classified = classifyTool(tool);
            return (
              <ToolCallChip
                key={key}
                verb={classified.verb}
                kind={classified.kind}
                argument={toolArgument(tool)}
                status={chipStatus(tool)}
                onClick={() => setExpandedToolId((current) => current === key ? null : key)}
              />
            );
          })}
          {toolCalls.length >= COLLAPSE_AT ? (
            <button
              type="button"
              onClick={() => setShowAll(false)}
              aria-label="Collapse tool call list"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                border: '1px solid var(--t-divider-subtle)',
                borderRadius: 999,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 11,
                fontWeight: 300,
                letterSpacing: '0.01em',
                paddingTop: 3,
                paddingRight: 9,
                paddingBottom: 3,
                paddingLeft: 9,
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; }}
            >
              Collapse
            </button>
          ) : null}
        </>
      )}

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
            boxShadow: '0 18px 45px rgba(15, 23, 42, 0.08)',
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
