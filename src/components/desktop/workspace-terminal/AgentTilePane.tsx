'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';

interface AgentTilePaneProps {
  sessionKey: string;
  agent: FleetAgent | null;
  focused: boolean;
  onClose: (sessionKey: string) => void;
  onFocus: (sessionKey: string) => void;
}

type VisualStatus = 'running' | 'waiting' | 'idle' | 'error';

const STATUS_META: Record<VisualStatus, { color: string; label: string }> = {
  running: { color: '#22c55e', label: 'Running' },
  waiting: { color: '#f59e0b', label: 'Waiting' },
  idle: { color: '#94a3b8', label: 'Idle' },
  error: { color: '#ef4444', label: 'Error' },
};

function classifyStatus(rawStatus?: string): VisualStatus {
  const value = (rawStatus ?? '').toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'error';
  if (value.includes('wait') || value.includes('approval') || value.includes('pending')) return 'waiting';
  if (value.includes('running') || value.includes('active') || value.includes('working')) return 'running';
  return 'idle';
}

function inferRuntime(sessionKey: string, rawRuntime?: string): 'codex' | 'claude-code' {
  return (rawRuntime ?? '').toLowerCase().includes('claude') || sessionKey.startsWith('claude-code:')
    ? 'claude-code'
    : 'codex';
}

function displayName(agent: FleetAgent | null, sessionKey: string): string {
  const name = agent?.name?.trim();
  if (name) return name;
  const shortKey = sessionKey.split(':').slice(1).join(':').trim();
  return shortKey || sessionKey;
}

function roleLabel(role: MobileTranscriptEntry['role']): string {
  if (role === 'assistant') return 'Assistant';
  if (role === 'user') return 'User';
  if (role === 'tool') return 'Tool';
  return 'System';
}

function entryContent(entry: MobileTranscriptEntry): string {
  const text = entry.text.trim();
  if (text) return text;
  if (entry.compaction?.summary?.trim()) return entry.compaction.summary.trim();
  const toolCalls = entry.toolCalls ?? [];
  return toolCalls.length > 0 ? toolCalls.map((toolCall) => `tool: ${toolCall.name}`).join('\n') : '';
}

function AgentTilePaneBase({ sessionKey, agent, focused, onClose, onFocus }: AgentTilePaneProps) {
  const [entries, setEntries] = useState<MobileTranscriptEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const name = useMemo(() => displayName(agent, sessionKey), [agent, sessionKey]);
  const runtime = useMemo(() => inferRuntime(sessionKey, agent?.runtime), [agent?.runtime, sessionKey]);
  const runtimeTone = useMemo(() => orchestratorRuntimeTone(runtime), [runtime]);
  const status = useMemo(() => classifyStatus(agent?.status), [agent?.status]);
  const shouldPoll = status === 'running' || status === 'waiting';
  const lastEntryKey = entries.length > 0 ? `${entries[entries.length - 1]?.id}:${entryContent(entries[entries.length - 1]!)}` : '';

  useEffect(() => {
    let cancelled = false;
    const fetchTranscript = async (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      try {
        const response = await fetch(`/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=80`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Transcript request failed (${response.status})`);
        const payload = await response.json() as { transcript?: MobileTranscriptEntry[] };
        if (cancelled) return;
        setEntries(Array.isArray(payload.transcript) ? payload.transcript : []);
        setError(null);
      } catch (fetchError) {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Unable to load transcript.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetchTranscript(true);
    let intervalId: number | null = null;
    if (shouldPoll) intervalId = window.setInterval(() => { void fetchTranscript(false); }, 3_000);
    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [sessionKey, shouldPoll]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [lastEntryKey]);

  return (
    <div
      onMouseDown={() => onFocus(sessionKey)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        borderRadius: 14, borderWidth: 1, borderStyle: 'solid',
        borderColor: focused ? 'var(--t-accent-border)' : 'var(--t-border)',
        background: 'var(--t-bg-card)',
        boxShadow: focused ? '0 18px 38px rgba(37, 99, 235, 0.12)' : '0 12px 28px rgba(15, 23, 42, 0.06)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          height: 36, minHeight: 36, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          paddingTop: 0, paddingRight: 8, paddingBottom: 0, paddingLeft: 10,
          borderBottomWidth: 1, borderBottomStyle: 'solid',
          borderBottomColor: focused ? 'var(--t-accent-border)' : 'var(--t-border)',
          background: focused ? 'var(--t-panel)' : 'var(--t-bg-card)',
        }}
      >
        <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{
              width: 18, height: 18, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              background: runtimeTone.background, color: runtimeTone.color, flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="5.5" width="7" height="13" rx="2.25" />
              <rect x="13.5" y="5.5" width="7" height="13" rx="2.25" />
            </svg>
          </span>
          <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
            <div
              title={name}
              style={{
                minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                fontSize: 12, fontWeight: 700, color: 'var(--t-text)', letterSpacing: '-0.01em',
              }}
            >
              {name}
            </div>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8,
                borderRadius: 12, borderWidth: 1, borderStyle: 'solid', borderColor: runtimeTone.border,
                background: runtimeTone.background, color: runtimeTone.color, fontSize: 10, fontWeight: 700, lineHeight: 1,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 999, background: runtimeTone.dot, flexShrink: 0 }} />
              {runtimeTone.label}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span
            title={STATUS_META[status].label}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: STATUS_META[status].color, fontSize: 10, fontWeight: 700 }}
          >
            <span
              style={{
                width: 8, height: 8, borderRadius: 999, background: STATUS_META[status].color,
                boxShadow: status === 'running' ? `0 0 0 3px ${STATUS_META[status].color}22` : 'none', flexShrink: 0,
              }}
            />
            {STATUS_META[status].label}
          </span>
          <button
            type="button"
            aria-label={`Close ${name} tile`}
            title="Close tile"
            onClick={(event) => { event.stopPropagation(); onClose(sessionKey); }}
            style={{
              width: 44, height: 44, marginTop: -4, marginRight: -4, marginBottom: -4, marginLeft: 0,
              borderRadius: 12, borderWidth: 0, background: 'transparent', color: 'var(--t-text-secondary)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--t-panel)';
              event.currentTarget.style.color = 'var(--t-text)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
              event.currentTarget.style.color = 'var(--t-text-secondary)';
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
              <path d="M6 6l12 12" />
              <path d="M18 6L6 18" />
            </svg>
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12,
          paddingTop: 14, paddingRight: 14, paddingBottom: 14, paddingLeft: 14, background: 'var(--t-panel)',
        }}
      >
        {entries.length === 0 ? (
          <div
            style={{
              flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.5,
            }}
          >
            {loading ? 'Loading transcript…' : error ?? 'No transcript yet.'}
          </div>
        ) : entries.map((entry) => {
          const content = entryContent(entry);
          if (!content) return null;
          return (
            <div
              key={entry.id}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12,
                borderRadius: 14, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-border)', background: 'var(--t-bg-card)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span
                  style={{
                    color: entry.role === 'assistant' ? runtimeTone.color : 'var(--t-text-secondary)',
                    fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}
                >
                  {roleLabel(entry.role)}
                </span>
                {entry.timestampLabel ? (
                  <span style={{ color: 'var(--t-text-secondary)', fontSize: 10, fontWeight: 600, flexShrink: 0 }}>
                    {entry.timestampLabel}
                  </span>
                ) : null}
              </div>
              <div style={{ color: 'var(--t-text)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {content}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export const AgentTilePane = memo(AgentTilePaneBase);
