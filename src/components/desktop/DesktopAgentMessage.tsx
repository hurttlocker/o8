'use client';

import { memo, useMemo, useState } from 'react';
import {
  Check,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  Search,
  Sparkles,
  TerminalSquare,
  Wrench,
} from 'lucide-react';
import { renderLLMMarkdown } from './LLMMarkdown';
import { MessageActions } from './MessageActions';
import type {
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptRuntimeEvent,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import {
  sanitizeDesktopToolCalls,
  sanitizeDesktopTranscriptEntry,
} from '@/lib/chat/desktop-transcript-sanitizer';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
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

export function DesktopToolCallStack({ toolCalls }: { toolCalls: MobileTranscriptToolCall[] }) {
  const sanitizedToolCalls = useMemo(
    () => sanitizeDesktopToolCalls(toolCalls) ?? [],
    [toolCalls],
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      width: '100%',
      maxWidth: '92%',
    }}>
      {sanitizedToolCalls.map((tool, index) => (
        <div
          key={`${tool.name}-${index}`}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            background: THEME_PANEL_GLASS,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 12,
            boxShadow: 'var(--t-panel-shadow)',
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
              background: THEME_ACCENT_SOFT,
              color: THEME_ACCENT,
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
                {toolLabel(tool)}
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
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 10,
              fontWeight: 700,
              color: tool.status === 'done' || !tool.status ? '#10b981' : THEME_ACCENT,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              flexShrink: 0,
            }}>
              {tool.status === 'done' || !tool.status ? (
                <Check size={12} strokeWidth={2.3} />
              ) : (
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: THEME_ACCENT,
                  opacity: 0.85,
                }} />
              )}
              {toolStatusLabel(tool.status)}
            </span>
          </div>
          <div
            title={toolDetail(tool)}
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--t-text-secondary)',
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

function RuntimeEventIcon({ event }: { event: MobileTranscriptRuntimeEvent }) {
  if (event.kind === 'command') return <TerminalSquare size={14} strokeWidth={2} />;
  if (event.kind === 'task') return <Wrench size={14} strokeWidth={2} />;
  return <Sparkles size={14} strokeWidth={2} />;
}

function runtimeKindLabel(kind: MobileTranscriptRuntimeEvent['kind']) {
  if (kind === 'command') return 'command';
  if (kind === 'task') return 'background task';
  if (kind === 'handoff') return 'handoff';
  return 'runtime';
}

export function DesktopRuntimeEventCard({ event }: { event: MobileTranscriptRuntimeEvent }) {
  const [expanded, setExpanded] = useState(false);
  const detailLines = [
    event.commandMessage && event.commandMessage !== event.commandName ? event.commandMessage : undefined,
    event.commandArgs ? `Args: ${event.commandArgs}` : undefined,
    event.outputLabel ? `Output: ${event.outputLabel}` : undefined,
    ...(event.rawPreviewLines ?? []),
  ].filter(Boolean) as string[];
  const hasDetails = Boolean(event.action || detailLines.length > 0 || event.changedFiles?.length);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      width: '100%',
      maxWidth: '92%',
      padding: '10px 12px',
      background: THEME_PANEL_GLASS,
      border: '1px solid var(--t-panel-border)',
      borderRadius: 12,
      boxShadow: 'var(--t-panel-shadow)',
    }}>
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
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          flexShrink: 0,
        }}>
          <RuntimeEventIcon event={event} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 700,
            color: 'var(--t-text)',
            letterSpacing: '-0.01em',
          }}>
            {event.title}
          </div>
          <div style={{
            marginTop: 2,
            fontSize: 11,
            color: 'var(--t-text-secondary)',
            lineHeight: 1.45,
          }}>
            {event.summary}
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '3px 8px',
          borderRadius: 999,
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.02em',
          textTransform: 'uppercase',
        }}>
          {runtimeKindLabel(event.kind)}
        </span>
        {event.status ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '3px 8px',
            borderRadius: 999,
            background: 'rgba(37, 99, 235, 0.10)',
            color: '#2563eb',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {event.status}
          </span>
        ) : null}
        {event.outputLabel ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '3px 8px',
            borderRadius: 999,
            background: THEME_BG_CARD,
            color: 'var(--t-text-secondary)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            {event.outputLabel}
          </span>
        ) : null}
        {event.source ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '3px 8px',
            borderRadius: 999,
            background: 'var(--t-divider-subtle)',
            color: 'var(--t-text-secondary)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            {event.source}
          </span>
        ) : null}
        {event.changedFiles?.length ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '3px 8px',
            borderRadius: 999,
            background: THEME_BG_CARD,
            color: 'var(--t-text-secondary)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            {event.changedFiles.length} file{event.changedFiles.length !== 1 ? 's' : ''}
          </span>
        ) : null}
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 8px',
              borderRadius: 999,
              border: '1px solid var(--t-panel-border)',
              background: expanded ? THEME_ACCENT_SOFT : THEME_BG_CARD,
              color: expanded ? THEME_ACCENT : 'var(--t-text-secondary)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
              cursor: 'pointer',
            }}
          >
            {expanded ? 'Hide details' : 'View details'}
          </button>
        ) : null}
      </div>

      {expanded && hasDetails ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '10px 12px',
          borderRadius: 12,
          background: THEME_BG_CARD,
          border: '1px solid var(--t-panel-border)',
        }}>
          {event.action ? (
            <div>
              <div style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginBottom: 4,
              }}>
                Delivery
              </div>
              <div style={{
                fontSize: 11,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.5,
              }}>
                {event.action}
              </div>
            </div>
          ) : null}

          {event.changedFiles?.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                Changed Files
              </div>
              {event.changedFiles.map((filePath) => (
                <div
                  key={filePath}
                  style={{
                    fontSize: 11,
                    color: 'var(--t-text-secondary)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {filePath}
                </div>
              ))}
            </div>
          ) : null}

          {detailLines.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--t-text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                Details
              </div>
              <div style={{
                padding: '8px 10px',
                borderRadius: 10,
                background: THEME_PANEL_GLASS,
                border: '1px solid var(--t-panel-border)',
                fontSize: 11,
                lineHeight: 1.5,
                color: 'var(--t-text-secondary)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {detailLines.join('\n')}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
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
  const sanitizedEntry = useMemo(() => sanitizeDesktopTranscriptEntry(entry), [entry]);
  const isUser = sanitizedEntry.role === 'user';
  const hasText = Boolean(sanitizedEntry.text.trim());
  const hasMedia = Boolean(sanitizedEntry.media?.length);
  const hasToolCalls = Boolean(sanitizedEntry.toolCalls?.length);
  const hasRuntimeEvent = Boolean(sanitizedEntry.runtimeEvent);

  if (sanitizedEntry.role === 'system' && sanitizedEntry.text.toLowerCase().includes('compaction')) {
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
        {hasMedia ? <MediaGrid media={sanitizedEntry.media ?? []} tint="user" /> : null}
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
            {sanitizedEntry.text}
          </div>
        ) : null}
        {sanitizedEntry.timestampLabel ? (
          <span style={{
            fontSize: 10,
            color: 'var(--t-text-faint)',
            paddingRight: 4,
          }}>
            {sanitizedEntry.timestampLabel}
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
      {hasRuntimeEvent ? <DesktopRuntimeEventCard event={sanitizedEntry.runtimeEvent!} /> : null}

      {hasText ? (
        <div style={{
          maxWidth: '92%',
          color: sanitizedEntry.role === 'system' ? '#475569' : '#0f172a',
          fontSize: 14,
          lineHeight: 1.65,
          wordBreak: 'break-word',
          padding: sanitizedEntry.role === 'system' ? '10px 12px' : 0,
          borderRadius: sanitizedEntry.role === 'system' ? 12 : 0,
          background: sanitizedEntry.role === 'system' ? 'rgba(248, 250, 252, 0.98)' : 'transparent',
          border: sanitizedEntry.role === 'system' ? '1px solid rgba(226, 232, 240, 0.95)' : 'none',
          boxShadow: sanitizedEntry.role === 'system' ? '0 8px 20px rgba(15, 23, 42, 0.04)' : 'none',
        }}>
          {renderLLMMarkdown(sanitizedEntry.text, {
            onApplyToFile,
            onOpenInCanvas,
            onRunInTerminal,
          })}
        </div>
      ) : null}

      {hasMedia ? <MediaGrid media={sanitizedEntry.media ?? []} tint="assistant" /> : null}
      {hasToolCalls ? <DesktopToolCallStack toolCalls={sanitizedEntry.toolCalls ?? []} /> : null}

      {sanitizedEntry.role === 'assistant' && hasText ? (
        <div style={{ width: '100%', maxWidth: '92%' }}>
          <MessageActions messageId={sanitizedEntry.id} messageText={sanitizedEntry.text} />
        </div>
      ) : null}

      {sanitizedEntry.timestampLabel ? (
        <span style={{
          fontSize: 10,
          color: 'var(--t-text-faint)',
          paddingLeft: 2,
        }}>
          {sanitizedEntry.timestampLabel}
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
