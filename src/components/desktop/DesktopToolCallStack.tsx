'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
} from '@/components/desktop/lucide-shims';
import type {
  MobileTranscriptToolCall,
  ToolSideEffectClass,
} from '@/lib/mobile/types';
import { renderDiffLines } from '@/components/desktop/diff-utils';
import {
  classifyToolCall,
} from '@/components/desktop/thoughts/toolClassifier';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const FILE_MUTATION_ROW_HEIGHT = 26;
const FILE_MUTATION_ROW_BACKGROUND = 'var(--t-panel)';
const FILE_MUTATION_ROW_BACKGROUND_ACTIVE = 'var(--t-bg-subtle, var(--t-panel))';
const FILE_MUTATION_TOOL_NAMES = new Set([
  'write',
  'write_file',
  'create_file',
  'edit',
  'edit_file',
  'multi_edit',
  'notebookedit',
  'notebook_edit',
]);

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function truncate(text: string, max = 88) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => stringifyUnknown(item)).filter(Boolean).join(', ');
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

function toolDetail(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const name = tool.name.toLowerCase();

  if (name === 'exec' || name === 'exec_command') {
    const command = sanitizeTranscriptText(firstString(args.command, args.cmd) ?? '');
    return command || 'Terminal command';
  }
  if (name === 'write_stdin') {
    const chars = sanitizeTranscriptText(firstString(args.chars) ?? '');
    const sessionId = firstString(args.session_id, args.sessionId);
    if (chars) return `stdin: ${truncate(chars.replace(/\s+/g, ' '), 72)}`;
    return sessionId ? `Session ${sessionId}` : 'Terminal input';
  }
  if (name === 'read' || name === 'read_file') {
    return sanitizeTranscriptText(firstString(args.file_path, args.path) ?? '') || 'File read';
  }
  if (FILE_MUTATION_TOOL_NAMES.has(name)) {
    return fileMutationPath(tool) || 'File edit';
  }
  if (name === 'search_web' || name === 'web_search' || name === 'cortex_search' || name === 'memory_search') {
    return sanitizeTranscriptText(firstString(args.query, args.q) ?? '') || 'Search';
  }
  if (name === 'web_fetch' || name === 'fetch_url') {
    return sanitizeTranscriptText(firstString(args.url, args.href) ?? '') || 'Fetch';
  }
  if (name === 'browser') {
    const action = firstString(args.action, args.kind, args.operation);
    const url = firstString(args.url, args.href, args.currentUrl);
    if (action && url) return `${sanitizeTranscriptText(action)} • ${sanitizeTranscriptText(url)}`;
    return sanitizeTranscriptText(action ?? url ?? '') || 'Browser action';
  }
  if (name === 'list_files' || name === 'ls' || name === 'glob') {
    return sanitizeTranscriptText(firstString(args.path, args.pattern) ?? '') || 'Workspace listing';
  }
  if (name === 'image') {
    return sanitizeTranscriptText(firstString(args.path, args.prompt) ?? '') || 'Image task';
  }

  const fallback = firstString(
    args.path,
    args.file_path,
    args.notebook_path,
    args.url,
    args.query,
    args.command,
    args.cmd,
    stringifyUnknown(args.input),
  );
  return sanitizeTranscriptText(fallback ?? '') || 'Tool activity';
}

function toolLabel(tool: MobileTranscriptToolCall) {
  const name = tool.name.toLowerCase();
  if (name === 'exec' || name === 'exec_command' || name === 'write_stdin') return 'Terminal';
  if (name === 'read' || name === 'read_file') return 'Read File';
  if (name === 'write' || name === 'write_file') return 'Write File';
  if (name === 'create_file') return 'Create File';
  if (name === 'edit' || name === 'edit_file') return 'Edit File';
  if (name === 'multi_edit') return 'Multi Edit';
  if (name === 'notebookedit' || name === 'notebook_edit') return 'Notebook Edit';
  if (name === 'search_web' || name === 'web_search') return 'Web Search';
  if (name === 'web_fetch' || name === 'fetch_url') return 'Fetch';
  if (name === 'browser') return 'Browser';
  if (name === 'list_files' || name === 'ls' || name === 'glob') return 'Workspace';
  if (name === 'cortex_search') return 'Cortex Search';
  if (name === 'memory_search') return 'Memory Search';
  if (name === 'image') return 'Image';
  return tool.name;
}

function resolveSideEffectClass(tool: MobileTranscriptToolCall): ToolSideEffectClass {
  return tool.sideEffectClass ?? classifyToolCall(tool.name, tool.args);
}

function lineCount(text: string) {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function truncateMiddle(text: string, max = 56) {
  if (text.length <= max) return text;
  const normalized = text.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length >= 3) {
    const first = segments[0];
    const penultimate = segments[segments.length - 2];
    const last = segments[segments.length - 1];
    const withParent = `${first}/.../${penultimate}/${last}`;
    if (withParent.length <= max) return withParent;
    const shortened = `${first}/.../${last}`;
    if (shortened.length <= max) return shortened;
  }

  const head = Math.max(12, Math.floor((max - 1) * 0.42));
  const tail = Math.max(12, max - head - 1);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function buildSyntheticDiffBody(before: string, after: string) {
  const beforeLines = before.length > 0 ? before.split('\n') : [];
  const afterLines = after.length > 0 ? after.split('\n') : [];
  if (beforeLines.length === 0 && afterLines.length === 0) return [];

  const oldHeader = beforeLines.length > 0 ? `1,${beforeLines.length}` : '0,0';
  const newHeader = afterLines.length > 0 ? `1,${afterLines.length}` : '0,0';
  return [
    `@@ -${oldHeader} +${newHeader} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ];
}

function buildSyntheticDiff(path: string, before: string, after: string) {
  const body = buildSyntheticDiffBody(before, after);
  if (body.length === 0) return '';

  const beforeLines = before.length > 0 ? before.split('\n') : [];
  const afterLines = after.length > 0 ? after.split('\n') : [];
  const oldPath = beforeLines.length > 0 ? `a/${path}` : '/dev/null';
  const newPath = afterLines.length > 0 ? `b/${path}` : '/dev/null';

  return [
    `diff --git a/${path} b/${path}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...body,
  ].join('\n');
}

function isDiffText(text: string) {
  return text
    .split('\n')
    .some((line) => ['+', '-', '@@', 'diff --git', 'index ', '---', '+++'].some((token) => line.startsWith(token)));
}

function getDiffStats(diff: string) {
  return diff.split('\n').reduce((totals, line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return totals;
    if (line.startsWith('+')) return { additions: totals.additions + 1, deletions: totals.deletions };
    if (line.startsWith('-')) return { additions: totals.additions, deletions: totals.deletions + 1 };
    return totals;
  }, { additions: 0, deletions: 0 });
}

function pathFromDiffText(diff: string) {
  const diffMatch = diff.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (diffMatch) return sanitizeTranscriptText(diffMatch[2] ?? diffMatch[1] ?? '');

  const fileHeaderMatch = diff.match(/^\+\+\+ (?:b\/)?(.+)$/m);
  if (fileHeaderMatch && fileHeaderMatch[1] !== '/dev/null') {
    return sanitizeTranscriptText(fileHeaderMatch[1]);
  }

  return '';
}

function fileMutationPath(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const directPath = sanitizeTranscriptText(firstString(
    args.file_path,
    args.filePath,
    args.path,
    args.notebook_path,
    args.relative_path,
  ) ?? '');
  if (directPath) return directPath;

  const fallbackDiff = typeof tool.preview === 'string' && isDiffText(tool.preview)
    ? tool.preview
    : typeof tool.result === 'string' && isDiffText(tool.result)
      ? tool.result
      : '';
  return fallbackDiff ? pathFromDiffText(fallbackDiff) : '';
}

function fileMutationPreview(tool: MobileTranscriptToolCall) {
  const name = tool.name.toLowerCase();
  if (!FILE_MUTATION_TOOL_NAMES.has(name)) return null;

  const args = tool.args ?? {};
  const path = fileMutationPath(tool);
  if (!path) return null;

  const fallbackDiff = typeof tool.preview === 'string' && isDiffText(tool.preview)
    ? tool.preview
    : typeof tool.result === 'string' && isDiffText(tool.result)
      ? tool.result
      : '';

  if (name === 'multi_edit') {
    const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
    const hunks = edits.flatMap((edit) => buildSyntheticDiffBody(
      typeof edit.old_string === 'string' ? edit.old_string : typeof edit.oldText === 'string' ? edit.oldText : '',
      typeof edit.new_string === 'string' ? edit.new_string : typeof edit.newText === 'string' ? edit.newText : '',
    ));
    const diff = hunks.length > 0
      ? [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          ...hunks,
        ].join('\n')
      : fallbackDiff;
    const stats = diff ? getDiffStats(diff) : { additions: 0, deletions: 0 };
    return {
      diff,
      path,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  if (name === 'edit' || name === 'edit_file') {
    const before = typeof args.old_string === 'string' ? args.old_string : typeof args.oldText === 'string' ? args.oldText : '';
    const after = typeof args.new_string === 'string' ? args.new_string : typeof args.newText === 'string' ? args.newText : '';
    const diff = buildSyntheticDiff(path, before, after) || fallbackDiff;
    const stats = diff
      ? getDiffStats(diff)
      : { additions: lineCount(after), deletions: lineCount(before) };
    return {
      diff,
      path,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  const content = typeof args.content === 'string' ? args.content : '';
  const diff = buildSyntheticDiff(path, '', content) || fallbackDiff;
  const stats = diff
    ? getDiffStats(diff)
    : { additions: lineCount(content), deletions: 0 };
  return {
    diff,
    path,
    additions: stats.additions,
    deletions: stats.deletions,
  };
}

function FileMutationLine({ tool }: { tool: MobileTranscriptToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => fileMutationPreview(tool), [tool]);
  const path = preview?.path || fileMutationPath(tool) || toolLabel(tool);
  const compactPath = truncateMiddle(path, 60);
  const canExpand = Boolean(preview?.diff);
  const isRunning = tool.status === 'running' || tool.status === 'calling';
  const isDone = tool.status === 'done' || !tool.status;

  return (
    <div style={{ width: '100%', maxWidth: '92%' }}>
      <button
        type="button"
        onClick={() => {
          if (!canExpand) return;
          setExpanded((value) => !value);
        }}
        title={path}
        aria-expanded={canExpand ? expanded : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          height: FILE_MUTATION_ROW_HEIGHT,
          paddingTop: 0,
          paddingRight: 10,
          paddingBottom: 0,
          paddingLeft: 8,
          boxSizing: 'border-box',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-border)',
          borderRadius: 11,
          background: expanded ? FILE_MUTATION_ROW_BACKGROUND_ACTIVE : FILE_MUTATION_ROW_BACKGROUND,
          boxShadow: 'none',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          textAlign: 'left',
          cursor: canExpand ? 'pointer' : 'default',
          transition: 'background 180ms ease, border-color 180ms ease',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 12,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: isDone ? 'var(--t-success, #16a34a)' : 'var(--t-accent, #2563eb)',
          }}
        >
          {isRunning ? (
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              style={{ animation: 'spin 0.9s linear infinite', display: 'block' }}
            >
              <path d="M21 12a9 9 0 1 1-6.22-8.56" />
            </svg>
          ) : isDone ? (
            <Check size={11} strokeWidth={2.6} />
          ) : (
            <span style={{ width: 4, height: 4, borderRadius: 999, background: 'var(--t-text-faint)', display: 'inline-block' }} />
          )}
        </span>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            fontSize: 11,
            lineHeight: 1.1,
            color: 'var(--t-text)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            letterSpacing: '-0.01em',
          }}
        >
          {compactPath || toolLabel(tool)}
        </span>
        {preview ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
              fontSize: 10,
              lineHeight: 1,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              color: 'var(--t-text-secondary)',
            }}
          >
            <span style={{ color: 'var(--t-success, #16a34a)' }}>+{preview.additions}</span>
            <span style={{ color: 'var(--t-text-faint)' }}>/</span>
            <span style={{ color: 'var(--t-danger, #ef4444)' }}>-{preview.deletions}</span>
          </span>
        ) : null}
        {canExpand ? (
          <ChevronRight
            size={12}
            strokeWidth={2.1}
            style={{
              color: 'var(--t-text-faint)',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 180ms ease',
              flexShrink: 0,
            }}
          />
        ) : null}
      </button>
      {expanded && preview?.diff ? (
        <div
          style={{
            marginTop: 4,
            marginLeft: 18,
            overflow: 'hidden',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            borderRadius: 12,
            background: THEME_PANEL_GLASS,
          }}
        >
          <div style={{ paddingTop: 8, paddingRight: 0, paddingBottom: 8, paddingLeft: 0 }}>
            {renderDiffLines(preview.diff)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Single unified format for every expanded tool call. Quiet mono line —
// bullet + name + optional detail + done check. Same shape whether the
// call is a file read, MCP call, ToolSearch, or shell — Rams cohesion.
function InlineToolLine({ tool }: { tool: MobileTranscriptToolCall }) {
  const label = toolLabel(tool);
  const detail = toolDetail(tool);
  const isRunning = tool.status === 'running' || tool.status === 'calling';
  const isDone = tool.status === 'done' || !tool.status;
  const showDetail = detail && detail !== 'Tool activity';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        maxWidth: '92%',
        paddingTop: 2,
        paddingRight: 10,
        paddingBottom: 2,
        paddingLeft: 2,
        fontSize: 10.5,
        color: 'var(--t-text-muted)',
        fontFamily: '"SF Mono", ui-monospace, monospace',
      }}
      title={showDetail ? `${label} · ${detail}` : label}
    >
      <span style={{ opacity: 0.5, flexShrink: 0 }}>·</span>
      <span style={{ flexShrink: 0, color: 'var(--t-text)', fontWeight: 500 }}>
        {label}
      </span>
      {showDetail ? (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--t-text-muted)',
          }}
        >
          · {truncate(detail, 120)}
        </span>
      ) : (
        <span style={{ flex: 1 }} />
      )}
      {isRunning ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#FF5A1F"
          strokeWidth="3"
          strokeLinecap="round"
          style={{ animation: 'spin 0.9s linear infinite', flexShrink: 0 }}
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
      ) : isDone ? (
        <Check size={11} strokeWidth={2.4} color="#10b981" />
      ) : null}
    </div>
  );
}

// Rams rule: every tool call gets one compact line. Real file mutations stay
// slightly heavier than shell commands, but only as a single-line paper row.
// Everything else (shell commands, reads, searches, MCP calls, unknown tools)
// collapses to a quiet italic line, batched when consecutive. Click to expand.
// The inverse list keeps us from re-whitelisting every new MCP tool Anthropic
// ships.
function isBatchable(_cls: ToolSideEffectClass, tool: MobileTranscriptToolCall) {
  const n = tool.name.toLowerCase();
  if (n === 'write' || n === 'write_file' || n === 'create_file') return false;
  if (n === 'edit' || n === 'edit_file' || n === 'multi_edit') return false;
  if (n === 'notebookedit' || n === 'notebook_edit') return false;
  return true;
}

function summarizeBatch(tools: MobileTranscriptToolCall[]): { verbs: string; anyRunning: boolean } {
  const names = tools.map((t) => {
    const n = t.name.toLowerCase();
    if (n === 'exec' || n === 'exec_command') {
      const cmd = String(t.args?.command ?? t.args?.cmd ?? '').trim().split(/\s+/)[0] ?? 'shell';
      return cmd.replace(/^.*\//, '') || 'shell';
    }
    if (n === 'read' || n === 'read_file') return 'read';
    if (n === 'search_web' || n === 'web_search' || n === 'cortex_search' || n === 'memory_search') return 'search';
    if (n === 'web_fetch' || n === 'fetch_url') return 'fetch';
    if (n === 'list_files' || n === 'ls' || n === 'glob') return 'list';
    return n;
  });
  const shown = names.slice(0, 5);
  const extra = names.length - shown.length;
  const verbs = extra > 0 ? `${shown.join(', ')} +${extra}` : shown.join(', ');
  const anyRunning = tools.some((t) => t.status === 'running' || t.status === 'calling');
  return { verbs, anyRunning };
}

function BatchedToolLine({ tools }: { tools: MobileTranscriptToolCall[] }) {
  const [expanded, setExpanded] = useState(false);
  const { verbs, anyRunning } = summarizeBatch(tools);
  const count = tools.length;

  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse commands' : 'Show commands'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 2,
          paddingBottom: 2,
          paddingLeft: 2,
          paddingRight: 8,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 11.5,
          fontStyle: 'italic',
          fontWeight: 400,
          letterSpacing: '-0.005em',
          fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {anyRunning ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#FF5A1F"
            strokeWidth="3"
            strokeLinecap="round"
            style={{ animation: 'spin 0.9s linear infinite', flexShrink: 0 }}
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-6.22-8.56" />
          </svg>
        ) : (
          <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--t-text-faint)', flexShrink: 0, display: 'inline-block' }} aria-hidden="true" />
        )}
        <span>
          {anyRunning ? 'running' : 'ran'} {count} {count === 1 ? 'command' : 'commands'}
          <span style={{ color: 'var(--t-text-faint)', fontStyle: 'italic' }}>
            {' — '}
            {verbs}
          </span>
        </span>
        <span style={{ fontSize: 9, fontStyle: 'normal', color: 'var(--t-text-faint)', opacity: 0.7 }}>
          {expanded ? '▴' : '▾'}
        </span>
      </button>
      {expanded ? (
        <div style={{
          marginTop: 6,
          marginLeft: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          paddingLeft: 10,
          borderLeftWidth: 1,
          borderLeftStyle: 'solid',
          borderLeftColor: 'var(--t-divider-subtle)',
        }}>
          {tools.map((tool, index) => {
            const key = `${tool.id ?? tool.name}-${index}`;
            return <InlineToolLine key={key} tool={tool} />;
          })}
        </div>
      ) : null}
    </div>
  );
}

export function DesktopToolCallStack({ toolCalls }: { toolCalls: MobileTranscriptToolCall[] }) {
  // Group consecutive batchable (read/meta) tool calls into italic summary
  // lines. File mutations render as compact expandable rows so they stay
  // visible without breaking transcript density.
  const groups: Array<
    | { kind: 'batch'; tools: MobileTranscriptToolCall[] }
    | { kind: 'write'; tool: MobileTranscriptToolCall; index: number }
  > = [];
  let pendingBatch: MobileTranscriptToolCall[] = [];

  const flushBatch = () => {
    if (pendingBatch.length === 0) return;
    groups.push({ kind: 'batch', tools: pendingBatch });
    pendingBatch = [];
  };

  toolCalls.forEach((tool, index) => {
    const cls = resolveSideEffectClass(tool);
    if (isBatchable(cls, tool)) {
      pendingBatch.push(tool);
    } else {
      flushBatch();
      groups.push({ kind: 'write', tool, index });
    }
  });
  flushBatch();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      width: '100%',
      maxWidth: '100%',
    }}>
      {groups.map((group, gi) => {
        if (group.kind === 'write') {
          const key = `write-${group.tool.id ?? group.tool.name}-${group.index}`;
          return <FileMutationLine key={key} tool={group.tool} />;
        }
        // Every batchable group — single or multi — renders as the italic
        // line. Single calls show "ran 1 command — rg"; multi show the count
        // with the stacked verb list. Consistency > ceremony.
        return <BatchedToolLine key={`batch-${gi}`} tools={group.tools} />;
      })}
    </div>
  );
}
