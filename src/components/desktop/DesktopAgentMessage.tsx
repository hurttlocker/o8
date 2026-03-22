'use client';

import { memo } from 'react';
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
import { renderLLMMarkdown } from './LLMMarkdown';
import { MessageActions } from './MessageActions';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';

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

function toolDetail(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const name = tool.name.toLowerCase();

  if (name === 'exec' || name === 'exec_command') {
    return firstString(args.command, args.cmd) ?? 'Terminal command';
  }
  if (name === 'write_stdin') {
    const chars = firstString(args.chars);
    const sessionId = firstString(args.session_id, args.sessionId);
    if (chars) return `stdin: ${truncate(chars.replace(/\s+/g, ' '), 72)}`;
    return sessionId ? `Session ${sessionId}` : 'Terminal input';
  }
  if (name === 'read' || name === 'read_file') {
    return firstString(args.file_path, args.path) ?? 'File read';
  }
  if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
    return firstString(args.file_path, args.path) ?? 'File edit';
  }
  if (name === 'search_web' || name === 'web_search' || name === 'cortex_search' || name === 'memory_search') {
    return firstString(args.query, args.q) ?? 'Search';
  }
  if (name === 'web_fetch' || name === 'fetch_url') {
    return firstString(args.url, args.href) ?? 'Fetch';
  }
  if (name === 'browser') {
    const action = firstString(args.action, args.kind, args.operation);
    const url = firstString(args.url, args.href, args.currentUrl);
    if (action && url) return `${action} • ${url}`;
    return action ?? url ?? 'Browser action';
  }
  if (name === 'list_files' || name === 'ls' || name === 'glob') {
    return firstString(args.path, args.pattern) ?? 'Workspace listing';
  }
  if (name === 'image') {
    return firstString(args.path, args.prompt) ?? 'Image task';
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
  return fallback ?? 'Tool activity';
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

export function DesktopToolCallStack({ toolCalls }: { toolCalls: MobileTranscriptToolCall[] }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      width: '100%',
      maxWidth: '92%',
    }}>
      {toolCalls.map((tool, index) => (
        <div
          key={`${tool.name}-${index}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            background: 'linear-gradient(180deg, rgba(248, 250, 252, 0.98), rgba(241, 245, 249, 0.94))',
            border: '1px solid rgba(226, 232, 240, 0.95)',
            borderRadius: 12,
            boxShadow: '0 8px 20px rgba(15, 23, 42, 0.04)',
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
              background: 'rgba(37, 99, 235, 0.10)',
              color: '#2563eb',
              flexShrink: 0,
            }}>
              <ToolIcon tool={tool} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#0f172a',
                letterSpacing: '-0.01em',
              }}>
                {toolLabel(tool)}
              </div>
              <div style={{
                fontSize: 10,
                color: '#64748b',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                textTransform: 'lowercase',
              }}>
                {tool.name}
              </div>
            </div>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: '#10b981',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              flexShrink: 0,
            }}>
              <Check size={12} strokeWidth={2.3} />
              Done
            </span>
          </div>
          <div
            title={toolDetail(tool)}
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: '#334155',
              wordBreak: 'break-word',
            }}
          >
            {truncate(toolDetail(tool), 180)}
          </div>
        </div>
      ))}
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
            color: tint === 'user' ? '#ffffff' : '#0f172a',
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
  const hasText = Boolean(entry.text.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);

  if (entry.role === 'system' && entry.text.toLowerCase().includes('compaction')) {
    return (
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        alignSelf: 'center',
        padding: '8px 12px',
        borderRadius: 999,
        background: 'rgba(148, 163, 184, 0.10)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        fontSize: 11,
        fontWeight: 700,
        color: '#64748b',
        letterSpacing: '0.01em',
      }}>
        <RefreshGlyph />
        Context compacted
      </div>
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
            maxWidth: '82%',
            padding: '11px 14px',
            borderRadius: '18px 18px 6px 18px',
            background: 'linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)',
            color: '#ffffff',
            boxShadow: '0 10px 24px rgba(37, 99, 235, 0.20)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 13,
            lineHeight: 1.55,
            letterSpacing: '-0.01em',
          }}>
            {entry.text}
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

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8,
      animation: isLast ? 'llmFadeIn 180ms ease-out' : undefined,
    }}>
      {hasText ? (
        <div style={{
          maxWidth: '92%',
          color: entry.role === 'system' ? '#475569' : '#0f172a',
          fontSize: 14,
          lineHeight: 1.65,
          wordBreak: 'break-word',
          padding: entry.role === 'system' ? '10px 12px' : 0,
          borderRadius: entry.role === 'system' ? 12 : 0,
          background: entry.role === 'system' ? 'rgba(248, 250, 252, 0.98)' : 'transparent',
          border: entry.role === 'system' ? '1px solid rgba(226, 232, 240, 0.95)' : 'none',
          boxShadow: entry.role === 'system' ? '0 8px 20px rgba(15, 23, 42, 0.04)' : 'none',
        }}>
          {renderLLMMarkdown(entry.text, {
            onApplyToFile,
            onOpenInCanvas,
            onRunInTerminal,
          })}
        </div>
      ) : null}

      {hasMedia ? <MediaGrid media={entry.media ?? []} tint="assistant" /> : null}
      {hasToolCalls ? <DesktopToolCallStack toolCalls={entry.toolCalls ?? []} /> : null}

      {entry.role === 'assistant' && hasText ? (
        <div style={{ width: '100%', maxWidth: '92%' }}>
          <MessageActions messageId={entry.id} messageText={entry.text} />
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

function RefreshGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block' }}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}
