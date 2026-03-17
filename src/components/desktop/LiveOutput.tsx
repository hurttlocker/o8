'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Terminal, FileCode, Wrench, ChevronDown } from 'lucide-react';

export interface LiveOutputEvent {
  id: string;
  type: 'tool_call' | 'file_change' | 'terminal' | 'message' | 'diff';
  name?: string;        // tool name or filename
  text?: string;        // content
  additions?: number;
  deletions?: number;
  timestamp: number;
}

interface LiveOutputProps {
  agentName: string;
  agentRuntime: string;
  sessionKey: string;
  onClose: () => void;
}

function EventIcon({ type }: { type: LiveOutputEvent['type'] }) {
  const size = 13;
  const color = 'rgba(147, 197, 253, 0.8)';
  switch (type) {
    case 'tool_call': return <Wrench size={size} color={color} />;
    case 'file_change': return <FileCode size={size} color={color} />;
    case 'terminal': return <Terminal size={size} color={color} />;
    default: return <Terminal size={size} color={color} />;
  }
}

function EventPill({ event }: { event: LiveOutputEvent }) {
  const age = Math.round((Date.now() - event.timestamp) / 1000);
  const ageLabel = age < 60 ? `${age}s` : `${Math.round(age / 60)}m`;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      paddingTop: 6,
      paddingRight: 10,
      paddingBottom: 6,
      paddingLeft: 10,
      borderRadius: 8,
      background: 'rgba(147, 197, 253, 0.04)',
      border: '1px solid rgba(147, 197, 253, 0.08)',
      fontSize: 12,
      fontFamily: 'ui-monospace, "SF Mono", Monaco, monospace',
      color: 'rgba(226, 232, 240, 0.85)',
      lineHeight: 1.4,
      animation: 'liveOutputFadeIn 300ms ease-out',
    }}>
      <EventIcon type={event.type} />
      <span style={{ flex: 1, minWidth: 0 }}>
        {event.type === 'tool_call' && (
          <span style={{ color: 'rgba(147, 197, 253, 0.9)', fontWeight: 500 }}>
            {event.name}
          </span>
        )}
        {event.type === 'file_change' && (
          <>
            <span style={{ color: '#93c5fd' }}>{event.name}</span>
            {(event.additions || event.deletions) ? (
              <span style={{ marginLeft: 6 }}>
                {event.additions ? <span style={{ color: '#34d399' }}>+{event.additions}</span> : null}
                {event.additions && event.deletions ? ' ' : ''}
                {event.deletions ? <span style={{ color: '#93c5fd' }}>-{event.deletions}</span> : null}
              </span>
            ) : null}
          </>
        )}
        {event.text && event.type !== 'tool_call' && event.type !== 'file_change' && (
          <span>{event.text}</span>
        )}
      </span>
      <span style={{ fontSize: 10, color: 'rgba(148, 163, 184, 0.5)', flexShrink: 0 }}>{ageLabel}</span>
    </div>
  );
}

export function LiveOutput({ agentName, agentRuntime, sessionKey, onClose }: LiveOutputProps) {
  const [events, setEvents] = useState<LiveOutputEvent[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchEvents = useCallback(async () => {
    try {
      const isClaudeCode = sessionKey.startsWith('claude-code:');
      const isCodex = sessionKey.startsWith('codex:');

      // Read from the appropriate transcript API
      let url = '';
      if (isClaudeCode) {
        url = `/api/claude-code/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`;
      } else if (isCodex) {
        url = `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`;
      } else {
        url = `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=30`;
      }

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const transcript = data.transcript ?? data.entries ?? [];

      // Convert transcript to LiveOutputEvents — extract tool calls and file changes
      const newEvents: LiveOutputEvent[] = [];
      for (const entry of transcript) {
        if (entry.role !== 'assistant') continue;
        const text = entry.text ?? '';

        // Extract tool calls (🔧 markers)
        const toolMatches = text.matchAll(/🔧\s*\*?(\w[\w\s]*?)\*?\s*(?:\n|$)/g);
        for (const match of toolMatches) {
          newEvents.push({
            id: `${entry.id}-tool-${match[1]}`,
            type: 'tool_call',
            name: match[1].trim(),
            timestamp: Date.now() - (transcript.length - newEvents.length) * 2000,
          });
        }

        // Extract file references (common patterns)
        const fileMatches = text.matchAll(/(?:edit|write|read|create|modify)\w*\s+[`"]?([^\s`"]+\.\w{1,6})[`"]?/gi);
        for (const match of fileMatches) {
          newEvents.push({
            id: `${entry.id}-file-${match[1]}`,
            type: 'file_change',
            name: match[1],
            timestamp: Date.now() - (transcript.length - newEvents.length) * 2000,
          });
        }

        // If no specific events extracted, show as message
        if (newEvents.length === 0 && text.length > 10 && !text.startsWith('🔧')) {
          newEvents.push({
            id: entry.id,
            type: 'message',
            text: text.slice(0, 120) + (text.length > 120 ? '…' : ''),
            timestamp: Date.now(),
          });
        }
      }

      if (newEvents.length > 0) {
        setEvents(newEvents.slice(-20));
      }
    } catch { /* silent */ }
  }, [sessionKey]);

  useEffect(() => {
    void fetchEvents();
    pollRef.current = setInterval(fetchEvents, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchEvents]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const runtimeLabel = agentRuntime === 'claude-code' ? 'Claude Code'
    : agentRuntime === 'codex' ? 'Codex'
    : 'OpenClaw';

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      background: 'rgba(15, 17, 23, 0.6)',
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      borderBottom: '1px solid rgba(147, 197, 253, 0.08)',
      borderTop: '1px solid rgba(147, 197, 253, 0.06)',
      transition: 'height 250ms cubic-bezier(0.32, 0.72, 0, 1)',
      height: collapsed ? 40 : '100%',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 14,
        flexShrink: 0,
        borderBottom: collapsed ? 'none' : '1px solid rgba(147, 197, 253, 0.06)',
      }}>
        {/* Pulse dot */}
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          backgroundColor: '#34c759',
          boxShadow: '0 0 6px rgba(52, 199, 89, 0.5)',
          animation: 'liveOutputPulse 2s ease-in-out infinite',
          flexShrink: 0,
        }} />
        <span style={{
          fontSize: 12,
          fontWeight: 600,
          color: 'rgba(226, 232, 240, 0.9)',
          letterSpacing: '-0.01em',
        }}>
          {agentName}
        </span>
        <span style={{
          fontSize: 10,
          color: 'rgba(148, 163, 184, 0.5)',
          fontWeight: 400,
        }}>
          {runtimeLabel} · Live
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            color: 'rgba(148, 163, 184, 0.5)',
          }}
        >
          <ChevronDown
            size={14}
            style={{
              transition: 'transform 200ms ease',
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            }}
          />
        </button>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
            display: 'flex',
            color: 'rgba(148, 163, 184, 0.4)',
          }}
          onMouseEnter={(e) => { (e.target as HTMLElement).style.color = 'rgba(239, 68, 68, 0.8)'; }}
          onMouseLeave={(e) => { (e.target as HTMLElement).style.color = 'rgba(148, 163, 184, 0.4)'; }}
        >
          <X size={14} />
        </button>
      </div>

      {/* Events stream */}
      {!collapsed && (
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflow: 'auto',
            paddingTop: 8,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {events.length === 0 ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              fontSize: 12,
              color: 'rgba(148, 163, 184, 0.3)',
              fontStyle: 'italic',
            }}>
              Watching for activity…
            </div>
          ) : (
            events.map((event) => <EventPill key={event.id} event={event} />)
          )}
        </div>
      )}

      <style>{`
        @keyframes liveOutputPulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 6px rgba(52, 199, 89, 0.5); }
          50% { opacity: 0.6; box-shadow: 0 0 12px rgba(52, 199, 89, 0.3); }
        }
        @keyframes liveOutputFadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
