'use client';

import React, { useState, useMemo, memo } from 'react';

// ── Types ──

interface ToolCall {
  name: string;
  content?: string;
}

interface FileChange {
  path: string;
  additions: number;
  deletions: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  fileChanges?: FileChange[];
  model?: string;
}

// ── Helpers ──

function parseToolCalls(content: string): { text: string; tools: ToolCall[] } {
  const tools: ToolCall[] = [];
  const text = content.replace(/🔧 \*([^*]+)\*/g, (_match, name) => {
    tools.push({ name });
    return '';
  });
  return { text: text.trim(), tools };
}

function parseFileChanges(content: string): FileChange[] {
  const changes: FileChange[] = [];
  const regex = /(\S+\.\w+)\s*\+(\d+)\s*-(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    changes.push({ path: match[1], additions: +match[2], deletions: +match[3] });
  }
  return changes;
}

// ── Markdown-lite renderer ──
// Handles: **bold**, `code`, ```code blocks```, > quotes, links, lists
function renderMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let inCodeBlock = false;
  let codeBlockContent = '';
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.slice(3).trim();
        codeBlockContent = '';
      } else {
        nodes.push(
          <div key={`code-${i}`} style={{
            margin: '8px 0',
            borderRadius: 8,
            overflow: 'hidden',
            border: '1px solid rgba(0,0,0,0.08)',
          }}>
            {codeBlockLang && (
              <div style={{
                fontSize: 10, fontWeight: 600,
                padding: '4px 10px',
                background: 'rgba(0,0,0,0.04)',
                color: '#64748b',
                borderBottom: '1px solid rgba(0,0,0,0.06)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                display: 'flex', justifyContent: 'space-between',
              }}>
                {codeBlockLang}
              </div>
            )}
            <pre style={{
              margin: 0,
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.5,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              background: '#f8fafc',
              overflowX: 'auto',
              color: '#334155',
            }}>
              {codeBlockContent}
            </pre>
          </div>
        );
        inCodeBlock = false;
        codeBlockContent = '';
        codeBlockLang = '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent += (codeBlockContent ? '\n' : '') + line;
      continue;
    }

    // Block quote
    if (line.startsWith('> ')) {
      nodes.push(
        <div key={`q-${i}`} style={{
          borderLeft: '3px solid #e2e8f0',
          paddingLeft: 10,
          margin: '4px 0',
          color: '#64748b',
          fontStyle: 'italic',
          fontSize: 12,
        }}>
          {renderInline(line.slice(2))}
        </div>
      );
      continue;
    }

    // Headings
    if (line.startsWith('### ')) {
      nodes.push(<div key={`h3-${i}`} style={{ fontSize: 13, fontWeight: 700, marginTop: 8, marginBottom: 2, color: 'inherit' }}>{line.slice(4)}</div>);
      continue;
    }
    if (line.startsWith('## ')) {
      nodes.push(<div key={`h2-${i}`} style={{ fontSize: 14, fontWeight: 700, marginTop: 10, marginBottom: 2, color: 'inherit' }}>{line.slice(3)}</div>);
      continue;
    }

    // List items
    if (line.match(/^[-*] /)) {
      nodes.push(
        <div key={`li-${i}`} style={{ display: 'flex', gap: 6, marginLeft: 4, fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ color: '#94a3b8', flexShrink: 0 }}>•</span>
          <span>{renderInline(line.slice(2))}</span>
        </div>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      nodes.push(<div key={`br-${i}`} style={{ height: 6 }} />);
      continue;
    }

    // Regular text
    nodes.push(<div key={`p-${i}`} style={{ fontSize: 13, lineHeight: 1.5 }}>{renderInline(line)}</div>);
  }

  return nodes;
}

// Inline formatting: **bold**, *italic*, `code`, [link](url)
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text))) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    if (match[2]) {
      parts.push(<strong key={match.index} style={{ fontWeight: 700 }}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={match.index} style={{
          fontSize: '0.9em',
          padding: '1px 5px',
          borderRadius: 4,
          background: 'rgba(0,0,0,0.06)',
          fontFamily: '"SF Mono", ui-monospace, monospace',
        }}>
          {match[4]}
        </code>
      );
    } else if (match[5] && match[6]) {
      parts.push(
        <a key={match.index} href={match[6]} target="_blank" rel="noopener" style={{
          color: '#2563eb',
          textDecoration: 'none',
          fontWeight: 500,
        }}>
          {match[5]}
        </a>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ── File Change Pill ──
function FileChangePill({ change }: { change: FileChange }) {
  const fileName = change.path.split('/').pop() || change.path;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 6,
      background: 'rgba(37,99,235,0.06)',
      border: '1px solid rgba(37,99,235,0.1)',
      fontSize: 11, fontWeight: 600,
      fontFamily: '"SF Mono", ui-monospace, monospace',
      color: '#334155',
    }}>
      {fileName}
      <span style={{ color: '#22c55e', fontSize: 10 }}>+{change.additions}</span>
      <span style={{ color: '#ef4444', fontSize: 10 }}>-{change.deletions}</span>
    </span>
  );
}

// ── Collapsible Tool Calls ──
function ToolCallsSection({ tools }: { tools: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);

  if (tools.length === 0) return null;

  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 8px', borderRadius: 6,
          border: '1px solid rgba(0,0,0,0.06)',
          background: 'rgba(0,0,0,0.02)',
          cursor: 'pointer', fontSize: 11, fontWeight: 600,
          color: '#64748b',
          fontFamily: '-apple-system, system-ui, sans-serif',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={expanded ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
        </svg>
        {tools.length} tool call{tools.length > 1 ? 's' : ''}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="12" y2="5" />
        </svg>
      </button>
      {expanded && (
        <div style={{
          marginTop: 4, padding: '6px 8px',
          borderRadius: 6, background: 'rgba(0,0,0,0.02)',
          border: '1px solid rgba(0,0,0,0.04)',
          display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          {tools.map((tool, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 4,
              fontSize: 11, color: '#64748b',
            }}>
              <span style={{
                width: 4, height: 4, borderRadius: '50%',
                background: '#94a3b8', flexShrink: 0,
              }} />
              <span style={{
                fontFamily: '"SF Mono", ui-monospace, monospace',
                fontWeight: 600, fontSize: 11,
              }}>
                {tool.name}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main Bubble ──

export const ChatBubble = memo(function ChatBubble({
  message,
  runtimeColor = '#64748b',
  onCopy,
}: {
  message: ChatMessage;
  runtimeColor?: string;
  onCopy?: (text: string) => void;
}) {
  const isUser = message.role === 'user';
  const [hovered, setHovered] = useState(false);

  // Parse tool calls from content
  const { text: cleanText, tools } = useMemo(() => {
    if (isUser) return { text: message.content, tools: [] };
    return parseToolCalls(message.content);
  }, [message.content, isUser]);

  // Parse file changes
  const fileChanges = useMemo(() => {
    if (isUser) return [];
    return message.fileChanges || parseFileChanges(message.content);
  }, [message.content, message.fileChanges, isUser]);

  const allTools = [...(message.toolCalls || []), ...tools];

  const timeStr = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        alignItems: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        position: 'relative',
      }}
    >
      {/* Message bubble */}
      <div style={{
        padding: isUser ? '10px 14px' : '12px 16px',
        borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
        background: isUser ? '#0f172a' : '#f1f5f9',
        color: isUser ? '#ffffff' : '#0f172a',
        fontFamily: '-apple-system, system-ui, sans-serif',
        wordBreak: 'break-word',
        minWidth: 0,
      }}>
        {isUser ? (
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
            {message.content}
          </div>
        ) : (
          <>
            {renderMarkdown(cleanText)}
            {fileChanges.length > 0 && (
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 4,
                marginTop: 8, paddingTop: 8,
                borderTop: '1px solid rgba(0,0,0,0.06)',
              }}>
                {fileChanges.map((fc, i) => (
                  <FileChangePill key={i} change={fc} />
                ))}
              </div>
            )}
            <ToolCallsSection tools={allTools} />
          </>
        )}
      </div>

      {/* Metadata row: time + model + actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        paddingLeft: 4, paddingRight: 4,
        fontSize: 9, color: '#cbd5e1',
      }}>
        <span>{timeStr}</span>
        {!isUser && message.model && (
          <>
            <span>·</span>
            <span style={{ color: runtimeColor, fontWeight: 600 }}>{message.model}</span>
          </>
        )}
        {/* Copy button on hover */}
        {hovered && (
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(message.content);
              onCopy?.(message.content);
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 2,
              padding: '1px 5px', borderRadius: 4,
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'rgba(0,0,0,0.02)',
              cursor: 'pointer', fontSize: 9,
              color: '#94a3b8',
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copy
          </button>
        )}
      </div>
    </div>
  );
});
