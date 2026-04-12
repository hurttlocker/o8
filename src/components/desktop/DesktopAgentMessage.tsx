'use client';

import { memo, useState } from 'react';
import {
  Check,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Search,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { CompactionNode } from '@/components/desktop/CompactionNode';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptToolCall,
  ToolSideEffectClass,
} from '@/lib/mobile/types';
import { renderLLMMarkdown } from './LLMMarkdown';
import { MessageActions } from './MessageActions';
import { usePretextHeight } from '@/lib/pretext';
import {
  classifyToolCall,
  writeTargetsFile,
} from './thoughts/toolClassifier';
import { publishO8PanelFocus } from '@/lib/events/o8-panel-focus';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

interface DesktopAgentMessageProps {
  entry: MobileTranscriptEntry;
  isLast?: boolean;
  onApplyToFile?: (code: string, language: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}

function mediaHref(path: string) {
  if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
    return path;
  }
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia) {
  return item.kind === 'image';
}

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

const INTERNAL_PROTOCOL_TAGS = [
  /<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<<<END_UNTRUSTED_CHILD_RESULT>>>/gi,
  /<\/?[a-z][a-z0-9]*(?:[_-][a-z0-9]+)+[^>]*>/gi,
  /<\/?(?:command-name|local-command-(?:stdout|stderr|input|result)|task-notification|task-completion-event|runtime-context|begin-untrusted-child-result|end-untrusted-child-result|untrusted-child-result|task-event|command-output|command-result|status|summary|task|source|action)[^>]*>/gi,
];

function stripInternalProtocolMarkup(text: string) {
  return INTERNAL_PROTOCOL_TAGS.reduce((next, pattern) => next.replace(pattern, ' '), text);
}

function collapseInternalTaskPayload(text: string) {
  if (!/<(?:status|summary|task|source|action)>/i.test(text)) return text;

  const summary = text.match(/<summary>([\s\S]*?)<\/summary>/i)?.[1]?.trim();
  const status = text.match(/<status>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  const task = text.match(/<task>([\s\S]*?)<\/task>/i)?.[1]?.trim();

  if (summary) {
    if (status && !summary.toLowerCase().includes(status.toLowerCase())) {
      return `${summary} (${status})`;
    }
    return summary;
  }

  if (task && status) return `${task} (${status})`;
  return text;
}

function redactSensitiveTranscriptText(text: string) {
  let next = text;
  next = next.replace(/(\bAuthorization\s*:\s*)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1Bearer [redacted]');
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, 'Bearer [redacted]');
  next = next.replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token)\b(\s*[:=]\s*)([^\s"'`]+)/gi, '$1[redacted]');
  next = next.replace(/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|token|auth|authorization|key)=)([^&\s]+)/gi, '$1[redacted]');
  next = next.replace(/\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|ASIA[0-9A-Z]{12,}|AIza[0-9A-Za-z\-_]{20,})\b/g, '[redacted]');
  return next;
}

function sanitizeTranscriptText(text: string) {
  return redactSensitiveTranscriptText(stripInternalProtocolMarkup(collapseInternalTaskPayload(text)));
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

/**
 * Resolve the side-effect class for a tool call. If the orchestrator
 * stream already tagged it, trust that; otherwise fall back to the
 * static classifier.
 */
function resolveSideEffectClass(tool: MobileTranscriptToolCall): ToolSideEffectClass {
  return tool.sideEffectClass ?? classifyToolCall(tool.name, tool.args);
}

function ToolStatusBadge({ status, tone }: { status: MobileTranscriptToolCall['status']; tone: string }) {
  const done = status === 'done' || !status;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
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
        <span style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: tone,
          opacity: 0.85,
        }} />
      )}
      {toolStatusLabel(status)}
    </span>
  );
}

function ReadToolChip({ tool }: { tool: MobileTranscriptToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const detail = toolDetail(tool);
  const label = toolLabel(tool);
  return (
    <div style={{ width: '100%', maxWidth: '92%' }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={`${label} · ${detail}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          minHeight: 26,
          paddingTop: 4,
          paddingRight: 10,
          paddingBottom: 4,
          paddingLeft: 10,
          borderWidth: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          fontSize: 11,
          fontFamily: '"SF Mono", ui-monospace, monospace',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>$</span>
        <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--t-text-secondary)' }}>
          {tool.name}
        </span>
        <span style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--t-text-muted)',
        }}>
          {detail ? `→ ${detail}` : ''}
        </span>
        <ToolStatusBadge status={tool.status} tone="var(--t-text-faint)" />
      </button>
      {expanded && detail ? (
        <div style={{
          marginLeft: 22,
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
      {targetFile ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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
        const key = `${tool.name}-${index}`;
        if (cls === 'read') return <ReadToolChip key={key} tool={tool} />;
        if (cls === 'meta') return <MetaToolLine key={key} tool={tool} />;
        return <WriteToolCard key={key} tool={tool} />;
      })}
    </div>
  );
}

function MediaGrid({
  media,
  tint,
}: {
  media: MobileTranscriptMedia[];
  tint: 'user' | 'assistant';
}) {
  const images = media.filter(isImageMedia);
  const files = media.filter((item) => !isImageMedia(item));

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      maxWidth: tint === 'user' ? '82%' : '92%',
    }}>
      {images.length > 0 ? (
        <div style={{
          display: 'grid',
          gridTemplateColumns: images.length === 1 ? '1fr' : '1fr 1fr',
          gap: 8,
        }}>
          {images.map((item, index) => (
            <a
              key={`${item.path}-${index}`}
              href={mediaHref(item.path)}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'block',
                overflow: 'hidden',
                borderRadius: 14,
                border: tint === 'user' ? '1px solid rgba(255,255,255,0.18)' : '1px solid rgba(226, 232, 240, 0.95)',
                background: tint === 'user' ? 'rgba(255,255,255,0.10)' : '#ffffff',
                boxShadow: tint === 'user' ? 'none' : '0 8px 20px rgba(15, 23, 42, 0.05)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={mediaHref(item.path)}
                alt={item.name}
                loading="lazy"
                style={{
                  display: 'block',
                  width: '100%',
                  maxHeight: images.length === 1 ? 280 : 180,
                  objectFit: 'cover',
                }}
              />
            </a>
          ))}
        </div>
      ) : null}

      {files.map((item, index) => (
        <div
          key={`${item.path}-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            borderRadius: 12,
            border: tint === 'user' ? '1px solid rgba(255,255,255,0.18)' : '1px solid rgba(226, 232, 240, 0.95)',
            background: tint === 'user' ? 'rgba(255,255,255,0.10)' : 'rgba(248, 250, 252, 0.98)',
            color: tint === 'user' ? '#ffffff' : 'var(--t-text)',
          }}
        >
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 10,
            background: tint === 'user' ? 'rgba(255,255,255,0.14)' : 'rgba(37, 99, 235, 0.08)',
            color: tint === 'user' ? '#ffffff' : '#2563eb',
            flexShrink: 0,
          }}>
            <FileText size={16} strokeWidth={2} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {item.name}
            </div>
            <div style={{
              fontSize: 10,
              color: tint === 'user' ? 'rgba(255,255,255,0.78)' : '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {item.kind}
            </div>
          </div>
          <a
            href={mediaHref(item.path)}
            target="_blank"
            rel="noreferrer"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: tint === 'user' ? '#ffffff' : '#2563eb',
              textDecoration: 'none',
            }}
          >
            Open
          </a>
        </div>
      ))}
    </div>
  );
}

export const DesktopAgentMessage = memo(function DesktopAgentMessage({
  entry,
  isLast = false,
  onApplyToFile,
  onOpenInCanvas,
  onRunInTerminal,
}: DesktopAgentMessageProps) {
  const isUser = entry.role === 'user';
  const displayText = sanitizeTranscriptText(entry.text);
  const hasText = Boolean(displayText.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  const isCompaction = entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));

  // Pretext: pre-calculate user message height (plain text, pre-wrap).
  // The orchestrator chat tile is render-hot during streaming — avoiding
  // reflows on every token matters. Width ~100% of panel minus padding
  // (16px × 2 + 12px × 2 = 56px).
  const userTextHeight = usePretextHeight(
    isUser ? displayText : '',
    'small', // 13px matches user bubble fontSize
    340 - 32, // approximate max-width minus padding
    1.55,
    'pre-wrap',
  );

  if (isCompaction) {
    return (
      <CompactionNode
        summary={entry.compaction?.summary}
        trigger={entry.compaction?.trigger}
        tokensBefore={entry.compaction?.tokensBefore}
        tokensAfter={entry.compaction?.tokensAfter}
        timestampLabel={entry.timestampLabel}
      />
    );
  }

  if (isUser) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 8,
      }}>
        {hasMedia ? <MediaGrid media={entry.media ?? []} tint="user" /> : null}
        {hasText ? (
          <div style={{
            maxWidth: '100%',
            padding: '12px 16px',
            borderRadius: '18px 18px 6px 18px',
            background: 'linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)',
            color: '#ffffff',
            boxShadow: '0 10px 24px rgba(37, 99, 235, 0.20)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            fontWeight: 400,
            lineHeight: 1.55,
            letterSpacing: '-0.01em',
            // Pretext: explicit minHeight eliminates reflow in z-9999 stacking context
            ...(userTextHeight > 0 ? { minHeight: userTextHeight } : {}),
          }}>
            {displayText}
          </div>
        ) : null}
        {entry.timestampLabel ? (
          <span style={{
            fontSize: 10,
            color: 'var(--t-text-faint)',
            paddingRight: 4,
          }}>
            {entry.timestampLabel}
          </span>
        ) : null}
      </div>
    );
  }

  const hasThinking = Boolean(entry.thinking?.trim());

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8,
      animation: isLast ? 'llmFadeIn 180ms ease-out' : undefined,
    }}>
      {hasThinking ? (
        <div style={{
          maxWidth: '100%',
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--t-text-muted, #94a3b8)',
          fontStyle: 'italic',
          fontWeight: 400,
          letterSpacing: '-0.005em',
          padding: '6px 10px',
          borderRadius: 10,
          background: 'var(--t-hover, rgba(148, 163, 184, 0.06))',
          border: '1px solid var(--t-divider-subtle, rgba(148, 163, 184, 0.10))',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'hidden',
          maxHeight: 120,
        }}>
          {sanitizeTranscriptText(entry.thinking!)}
        </div>
      ) : null}

      {hasText ? (
        <div style={{
          maxWidth: '100%',
          color: entry.role === 'system' ? 'var(--t-text-secondary)' : 'var(--t-text)',
          fontSize: 13,
          fontWeight: 380,
          lineHeight: 1.6,
          letterSpacing: '-0.005em',
          wordBreak: 'break-word',
          padding: entry.role === 'system' ? '10px 12px' : 0,
          borderRadius: entry.role === 'system' ? 12 : 0,
          background: entry.role === 'system' ? 'rgba(248, 250, 252, 0.98)' : 'transparent',
          border: entry.role === 'system' ? '1px solid rgba(226, 232, 240, 0.95)' : 'none',
          boxShadow: entry.role === 'system' ? '0 8px 20px rgba(15, 23, 42, 0.04)' : 'none',
        }}>
          {renderLLMMarkdown(displayText, {
            onApplyToFile,
            onOpenInCanvas,
            onRunInTerminal,
          })}
        </div>
      ) : null}

      {hasMedia ? <MediaGrid media={entry.media ?? []} tint="assistant" /> : null}
      {hasToolCalls ? <DesktopToolCallStack toolCalls={entry.toolCalls ?? []} /> : null}

      {entry.role === 'assistant' && hasText ? (
        <div style={{ width: '100%' }}>
          <MessageActions messageId={entry.id} messageText={displayText} />
        </div>
      ) : null}

      {entry.timestampLabel ? (
        <span style={{
          fontSize: 10,
          color: 'var(--t-text-faint)',
          paddingLeft: 2,
        }}>
          {entry.timestampLabel}
        </span>
      ) : null}
    </div>
  );
});
