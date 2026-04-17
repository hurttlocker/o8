'use client';

import { useState } from 'react';
import {
  Check,
  FileCode2,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Search,
  TerminalSquare,
  Wrench,
} from '@/components/desktop/lucide-shims';
import type {
  MobileTranscriptToolCall,
  ToolSideEffectClass,
} from '@/lib/mobile/types';
import { publishO8PanelFocus } from '@/lib/events/o8-panel-focus';
import { requestRuntimeSessionFocus } from '@/lib/runtime/session-focus';
import {
  classifyToolCall,
  writeTargetsFile,
} from '@/components/desktop/thoughts/toolClassifier';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';

const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

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
  if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
    return sanitizeTranscriptText(firstString(args.file_path, args.path) ?? '') || 'File edit';
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
  if (name === 'edit' || name === 'edit_file') return 'Edit File';
  if (name === 'search_web' || name === 'web_search') return 'Web Search';
  if (name === 'web_fetch' || name === 'fetch_url') return 'Fetch';
  if (name === 'browser') return 'Browser';
  if (name === 'list_files' || name === 'ls' || name === 'glob') return 'Workspace';
  if (name === 'cortex_search') return 'Cortex Search';
  if (name === 'memory_search') return 'Memory Search';
  if (name === 'image') return 'Image';
  return tool.name;
}

function toolStatusLabel(status: MobileTranscriptToolCall['status']) {
  if (status === 'calling') return 'Queued';
  if (status === 'running') return 'Running';
  return 'Done';
}

function ToolIcon({ tool }: { tool: MobileTranscriptToolCall }) {
  const name = tool.name.toLowerCase();
  if (name === 'exec' || name === 'exec_command' || name === 'write_stdin') {
    return <TerminalSquare size={14} strokeWidth={2} />;
  }
  if (name === 'read' || name === 'read_file' || name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
    return <FileCode2 size={14} strokeWidth={2} />;
  }
  if (name === 'search_web' || name === 'web_search' || name === 'cortex_search' || name === 'memory_search') {
    return <Search size={14} strokeWidth={2} />;
  }
  if (name === 'web_fetch' || name === 'fetch_url' || name === 'browser') {
    return <Globe size={14} strokeWidth={2} />;
  }
  if (name === 'list_files' || name === 'ls' || name === 'glob') {
    return <FolderOpen size={14} strokeWidth={2} />;
  }
  if (name === 'image') {
    return <ImageIcon size={14} strokeWidth={2} />;
  }
  return <Wrench size={14} strokeWidth={2} />;
}

function resolveSideEffectClass(tool: MobileTranscriptToolCall): ToolSideEffectClass {
  return tool.sideEffectClass ?? classifyToolCall(tool.name, tool.args);
}

function ToolStatusBadge({ status, tone }: { status: MobileTranscriptToolCall['status']; tone: string }) {
  const done = status === 'done' || !status;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      fontSize: 10,
      fontWeight: 700,
      color: done ? '#10b981' : tone,
      textTransform: 'uppercase',
      letterSpacing: '0.04em',
      flexShrink: 0,
    }}>
      {done ? (
        <Check size={12} strokeWidth={2.3} />
      ) : (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tone}
          strokeWidth="3"
          strokeLinecap="round"
          style={{ animation: 'spin 0.9s linear infinite', display: 'block' }}
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
      )}
      {toolStatusLabel(status)}
    </span>
  );
}

function ReadToolChip({ tool }: { tool: MobileTranscriptToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const detail = toolDetail(tool);
  const label = toolLabel(tool);
  const isRunning = tool.status === 'running' || tool.status === 'calling';
  return (
    <div style={{ width: '100%', maxWidth: '92%' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        title={`${label} · ${detail}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          minHeight: 32,
          paddingTop: 6,
          paddingRight: 12,
          paddingBottom: 6,
          paddingLeft: 12,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: isRunning
            ? 'rgba(37, 99, 235, 0.28)'
            : 'var(--t-divider-subtle, rgba(148, 163, 184, 0.18))',
          borderRadius: 10,
          background: isRunning
            ? 'rgba(37, 99, 235, 0.06)'
            : 'var(--t-bg-card, rgba(148, 163, 184, 0.04))',
          color: 'var(--t-text-muted)',
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          textAlign: 'left',
          cursor: 'pointer',
          transition: 'background 120ms ease, border-color 120ms ease',
        }}
      >
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 5,
          background: isRunning ? 'rgba(37, 99, 235, 0.12)' : 'rgba(148, 163, 184, 0.10)',
          color: isRunning ? '#2563eb' : 'var(--t-text-muted)',
          flexShrink: 0,
        }}>
          <ToolIcon tool={tool} />
        </span>
        <span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em', fontSize: 11.5 }}>
          {label}
        </span>
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--t-text-muted)',
        }}>
          {detail ? `· ${detail}` : ''}
        </span>
        <ToolStatusBadge status={tool.status} tone="#2563eb" />
      </button>
      {expanded && detail ? (
        <div style={{
          marginLeft: 28,
          marginTop: 4,
          paddingTop: 8,
          paddingRight: 10,
          paddingBottom: 8,
          paddingLeft: 10,
          borderRadius: 8,
          background: 'var(--t-code-bg)',
          color: 'var(--t-text-secondary)',
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

function WriteToolCard({ tool }: { tool: MobileTranscriptToolCall }) {
  const label = toolLabel(tool);
  const detail = toolDetail(tool);
  const targetFile = writeTargetsFile(tool.name, tool.args);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 10,
        paddingLeft: 14,
        background: THEME_PANEL_GLASS,
        borderTopWidth: 1,
        borderRightWidth: 1,
        borderBottomWidth: 1,
        borderLeftWidth: 3,
        borderTopStyle: 'solid',
        borderRightStyle: 'solid',
        borderBottomStyle: 'solid',
        borderLeftStyle: 'solid',
        borderTopColor: 'var(--t-panel-border)',
        borderRightColor: 'var(--t-panel-border)',
        borderBottomColor: 'var(--t-panel-border)',
        borderLeftColor: 'rgba(245, 158, 11, 0.7)',
        borderRadius: 12,
        boxShadow: 'var(--t-panel-shadow)',
        width: '100%',
        maxWidth: '92%',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 8,
          background: 'rgba(245, 158, 11, 0.12)',
          color: '#b45309',
          flexShrink: 0,
        }}>
          <ToolIcon tool={tool} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}>
            {label}
          </div>
          <div style={{
            fontSize: 10,
            color: 'var(--t-text-muted)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            textTransform: 'lowercase',
          }}>
            {tool.name}
          </div>
        </div>
        <ToolStatusBadge status={tool.status} tone="#b45309" />
      </div>
      <div
        title={detail}
        style={{
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--t-text-secondary)',
          wordBreak: 'break-word',
        }}
      >
        {truncate(detail, 180)}
      </div>
      {(targetFile || tool.launchLink) ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}>
          {tool.launchLink ? (
            <button
              type="button"
              onClick={() => {
                requestRuntimeSessionFocus({
                  sessionKey: tool.launchLink!.surfaceId,
                  repoPath: tool.launchLink!.repoPath,
                  label: tool.launchLink!.label,
                });
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 24,
                paddingTop: 0,
                paddingRight: 10,
                paddingBottom: 0,
                paddingLeft: 10,
                borderRadius: 999,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(37, 99, 235, 0.24)',
                background: 'rgba(37, 99, 235, 0.09)',
                color: '#1d4ed8',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.01em',
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true">→</span>
              <span>{`Open ${tool.launchLink.label} tab`}</span>
            </button>
          ) : null}
          {targetFile ? (
            <button
              type="button"
              onClick={() => {
                publishO8PanelFocus({ tab: 'changes', artifactId: targetFile });
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 24,
                paddingTop: 0,
                paddingRight: 10,
                paddingBottom: 0,
                paddingLeft: 10,
                borderRadius: 8,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(245, 158, 11, 0.28)',
                background: 'rgba(245, 158, 11, 0.10)',
                color: '#b45309',
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: '0.02em',
                cursor: 'pointer',
              }}
            >
              View in Changes
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MetaToolLine({ tool }: { tool: MobileTranscriptToolCall }) {
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
        paddingLeft: 10,
        fontSize: 10.5,
        color: 'var(--t-text-faint)',
        fontFamily: '"SF Mono", ui-monospace, monospace',
      }}
      title={`${tool.name} · meta`}
    >
      <span style={{ opacity: 0.6 }}>∙</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {tool.name}
      </span>
    </div>
  );
}

export function DesktopToolCallStack({ toolCalls }: { toolCalls: MobileTranscriptToolCall[] }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      width: '100%',
      maxWidth: '100%',
    }}>
      {toolCalls.map((tool, index) => {
        const cls = resolveSideEffectClass(tool);
        const key = `${tool.id ?? tool.name}-${index}`;
        if (cls === 'read') return <ReadToolChip key={key} tool={tool} />;
        if (cls === 'meta') return <MetaToolLine key={key} tool={tool} />;
        return <WriteToolCard key={key} tool={tool} />;
      })}
    </div>
  );
}
