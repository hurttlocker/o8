'use client';
/* eslint-disable @next/next/no-img-element -- transcript media here intentionally renders raw URLs from mixed runtimes */

/**
 * DesktopChat — Right-sidebar chat panel for Dashboard v1.
 *
 * Visually identical to the mobile chat — uses the SAME remodex-* CSS
 * classes from globals.css. Independent component tree: editing this
 * does NOT affect mobile, and vice versa.
 *
 * Differences from mobile:
 *   - No hamburger menu (not needed on desktop)
 *   - Fixed sidebar layout (not full-screen)
 *   - Scroll container is the sidebar div, not the window
 */

import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Image from 'next/image';
import { useSharedDesktopWs } from './hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Loader2,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Square,
} from 'lucide-react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import type { ProjectGroup } from '@/components/mobile/types';
import { buildProjectGroups } from '@/components/mobile/utils';
import { appendOpenClawBetaQuery, readOpenClawBetaEnabled, subscribeOpenClawBetaEnabled } from '@/lib/connectors/openclaw-beta';
import { CodeBlock } from './CodeBlock';
import { DesktopToolCallStack } from './DesktopAgentMessage';
import { DiffModal } from './DiffModal';
import { MessageActions } from './MessageActions';
import {
  activityToSidebarLiveToolCall as normalizeActivityToSidebarLiveToolCall,
  advanceSidebarToolStack as normalizeAdvanceSidebarToolStack,
  buildSidebarSourceCards as normalizeSidebarSourceCards,
  deriveSidebarRuntimeCapabilities,
  groupSidebarTranscriptTurns as normalizeSidebarTranscriptTurns,
  looksLikeSidebarWorkspaceFile as normalizeSidebarWorkspaceFile,
  parseSidebarRuntimeEventSummary as normalizeSidebarRuntimeEventSummary,
  sidebarGroupTimestamp as normalizeSidebarGroupTimestamp,
  summarizeSidebarAgentGroup as normalizeSidebarAgentGroup,
  lastSidebarTurnToolCalls as normalizeLastSidebarTurnToolCalls,
  type SidebarRuntimeCapabilities,
} from '@/lib/chat/sidebar-events';
import { formatModelLabel } from '@/lib/format';
import { ttsEngine } from '@/lib/tts/engine';
import { autocompleteSlashCommand, buildSlashTerminalInput, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];
type TranscriptGroup = {
  id: string;
  kind: 'user' | 'agent' | 'system';
  entries: MobileTranscriptEntry[];
};

// ── Helpers ──

function getAgentName(s: SessionSummary): string {
  if (s.runtime === 'claude-code') return 'Claude Code';
  if (s.isCurrentSession) return 'Assistant';
  const name = s.name || s.sessionKey;
  if (name.includes('codex-owned')) return 'Codex';
  if (name.includes('ace')) return 'Niot';
  if (name.includes('hawk')) return 'Hawk';
  return name;
}

function sessionDisplayModel(session?: SessionSummary) {
  if (!session) return 'Live';
  if (session.runtime === 'openclaw') {
    return formatModelLabel(session.primaryModel ?? session.model ?? session.heartbeatModel ?? 'OpenClaw');
  }
  if (session.runtime === 'codex') {
    return formatModelLabel(session.model ?? 'Codex');
  }
  if (session.runtime === 'claude-code') {
    return formatModelLabel(session.model ?? 'Claude Code');
  }
  return formatModelLabel(session.model ?? 'Live');
}

function roleLabel(role: string, agentName?: string): string {
  if (role === 'user') return 'You';
  if (role === 'system') return 'System';
  return agentName ?? 'Assistant';
}

function compactLine(text: string | null | undefined, fallback: string, max = 26): string {
  const val = text ?? fallback;
  if (val.length <= max) return val;
  return val.slice(0, max - 1) + '…';
}

function sessionLocalFolderLabel(session: SessionSummary) {
  const cwd = session.runtimeSurface?.cwd?.trim() || session.workspace?.trim();
  if (!cwd) return null;
  const sourceLabel = session.runtimeSurface?.sourceLabel ?? '';
  const ttyMatch = sourceLabel.match(/(?:^|• )([st]tys?\d{3}|s\d{3})(?: •|$)/i);
  const tty = ttyMatch?.[1]?.trim();
  const folder = compactLine(cwd, cwd, 44);
  return tty ? `${folder} • ${tty}` : folder;
}

function mediaHref(path: string): string {
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia): boolean {
  return item.kind !== 'pdf' && item.kind !== 'file';
}

function isCompactionEntry(entry: MobileTranscriptEntry): boolean {
  return entry.role === 'system' && entry.text.toLowerCase().includes('compaction');
}

type RuntimeEventSummary = {
  title: string;
  summary: string;
  status?: string;
  task?: string;
  source?: string;
  changedFiles?: string[];
  action?: string;
  rawPreviewLines?: string[];
};

type GroupChipTone = 'blue' | 'purple' | 'amber' | 'emerald' | 'slate';
type GroupChip = {
  label: string;
  tone: GroupChipTone;
};

type GroupSourceCard = {
  id: string;
  label: string;
  summary: string;
  details: string[];
  tone: GroupChipTone;
  links?: Array<{ label: string; href: string }>;
  canOpenDiff?: boolean;
};

type SidebarApproval = {
  id: string;
  agent: string;
  sessionKey: string;
  title: string;
  description: string;
  command?: string;
  risk: 'low' | 'medium' | 'high';
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
};

function parseRuntimeEventSummary(text: string): RuntimeEventSummary | null {
  return normalizeSidebarRuntimeEventSummary(text) as RuntimeEventSummary | null;
}

function groupTimestamp(entries: MobileTranscriptEntry[]): number | undefined {
  return normalizeSidebarGroupTimestamp(entries);
}

function relativeTimeLabel(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function summarizeAgentGroup(entries: MobileTranscriptEntry[]): {
  chips: GroupChip[];
  separatorLabel?: string;
  timeLabel?: string;
} {
  return normalizeSidebarAgentGroup(entries);
}

function looksLikeWorkspaceFile(detail: string): boolean {
  return normalizeSidebarWorkspaceFile(detail);
}

function buildGroupSourceCards(entries: MobileTranscriptEntry[]): GroupSourceCard[] {
  return normalizeSidebarSourceCards(entries) as GroupSourceCard[];
}

function stripOperatorMarkdown(text: string) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPERATOR_COLLAPSE_MARKERS = [
  /analyze the user'?s input/i,
  /analyze tool results/i,
  /determine the best response strategy/i,
  /formulate the response/i,
  /draft the response/i,
  /drafting the response/i,
  /drafting the content/i,
  /execution plan/i,
  /self-correction/i,
  /operator summary/i,
  /thought for \d/i,
  /gemini 3\.1 pro/i,
  /click to play from here/i,
];

function shouldCollapseOperatorEntry(entry: MobileTranscriptEntry) {
  if (entry.role === 'user' || (entry.toolCalls?.length ?? 0) > 0) return false;
  const lineCount = entry.text.split('\n').length;
  const markerHits = OPERATOR_COLLAPSE_MARKERS.filter((pattern) => pattern.test(entry.text)).length;
  return markerHits >= 2 || (markerHits >= 1 && (entry.text.length > 1400 || lineCount > 24));
}

function buildOperatorSummary(text: string) {
  const lines = text
    .split('\n')
    .map((line) => stripOperatorMarkdown(line))
    .filter(Boolean)
    .filter((line) => !/^thought for \d/i.test(line))
    .filter((line) => !/^(gemini|opus|claude code|codex)\b/i.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}\s?(am|pm)$/i.test(line));

  const headline = compactLine(lines[0] ?? stripOperatorMarkdown(text) ?? 'Long assistant note', 'Long assistant note', 180);
  const details = lines
    .slice(1)
    .filter((line) => line !== headline)
    .slice(0, 3)
    .map((line) => compactLine(line, line, 160));

  return {
    headline,
    details,
    stats: `${lines.length || text.split('\n').length} lines • ${Math.max(1, Math.round(text.length / 100)) / 10}k chars`,
  };
}

function chipStyles(tone: GroupChipTone): React.CSSProperties {
  if (tone === 'blue') {
    return { background: 'rgba(37, 99, 235, 0.08)', color: '#2563eb' };
  }
  if (tone === 'purple') {
    return { background: 'rgba(139, 92, 246, 0.10)', color: '#7c3aed' };
  }
  if (tone === 'amber') {
    return { background: 'rgba(245, 158, 11, 0.10)', color: '#b45309' };
  }
  if (tone === 'emerald') {
    return { background: 'rgba(16, 185, 129, 0.10)', color: '#047857' };
  }
  return { background: 'rgba(15, 23, 42, 0.06)', color: '#475569' };
}

function groupTranscriptTurns(transcript: MobileTranscriptEntry[]): TranscriptGroup[] {
  return normalizeSidebarTranscriptTurns(transcript) as TranscriptGroup[];
}

function activityToLiveToolCall(activity?: SessionSummary['activity']): MobileTranscriptToolCall | null {
  return normalizeActivityToSidebarLiveToolCall(activity);
}

function lastTurnToolCalls(transcript: MobileTranscriptEntry[]): MobileTranscriptToolCall[] {
  return normalizeLastSidebarTurnToolCalls(transcript);
}

function advanceToolStack(
  previous: MobileTranscriptToolCall[],
  toolName: string,
): MobileTranscriptToolCall[] {
  return normalizeAdvanceSidebarToolStack(previous, toolName);
}

function transcriptEntrySignature(entry: MobileTranscriptEntry) {
  return JSON.stringify({
    role: entry.role,
    text: entry.text,
    media: (entry.media ?? []).map((item) => `${item.kind}:${item.path}`),
    toolCalls: (entry.toolCalls ?? []).map((tool) => ({
      name: tool.name,
      args: tool.args,
      status: tool.status,
    })),
    timestamp: entry.timestamp,
    timestampLabel: entry.timestampLabel,
  });
}

function dedupeTranscriptEntries(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  if (entries.length < 2) return entries;

  const next: MobileTranscriptEntry[] = [];
  const indexById = new Map<string, number>();
  let changed = false;

  for (const entry of entries) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      continue;
    }
    next[existingIndex] = entry;
    changed = true;
  }

  return changed ? next : entries;
}

function mergeTranscriptEntries(
  existing: MobileTranscriptEntry[],
  incoming: MobileTranscriptEntry[],
): MobileTranscriptEntry[] {
  if (incoming.length === 0) return existing;

  const next = [...existing];
  const indexById = new Map(next.map((entry, index) => [entry.id, index]));
  let changed = false;

  for (const entry of incoming) {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex == null) {
      indexById.set(entry.id, next.length);
      next.push(entry);
      changed = true;
      continue;
    }

    if (transcriptEntrySignature(next[existingIndex]) === transcriptEntrySignature(entry)) {
      continue;
    }

    next[existingIndex] = entry;
    changed = true;
  }

  return changed ? next : existing;
}

// ── Memoized Message Bubble ──

interface BubbleProps {
  entry: MobileTranscriptEntry;
  previousEntry: MobileTranscriptEntry | null;
  agentName: string;
  isNew?: boolean;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
}

const Bubble = memo(function Bubble({ entry, previousEntry, agentName, isNew, onOpenMermaid, onRunInTerminal }: BubbleProps) {
  const isUser = entry.role === 'user';
  const hasText = Boolean(entry.text.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  const isSlashCommand = isSlashCommandText(entry.text);
  const runtimeEvent = useMemo(() => parseRuntimeEventSummary(entry.text), [entry.text]);
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const prev = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const curr = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(prev) || Number.isNaN(curr)) return speakerChanged;
    return Math.abs(curr - prev) >= 15 * 60 * 1000;
  })();

  const mdBlocks = useMemo(
    () => hasText ? renderMarkdownBlocks(entry.text, onOpenMermaid, onRunInTerminal) : [],
    [entry.text, hasText, onOpenMermaid, onRunInTerminal],
  );

  const [activeBlock, setActiveBlock] = useState<number | null>(null);
  const [handoffExpanded, setHandoffExpanded] = useState(false);
  const [operatorExpanded, setOperatorExpanded] = useState(false);
  const playingRef = useRef(false);

  useEffect(() => {
    if (entry.role !== 'assistant') return;
    return ttsEngine.subscribe((state) => {
      const isOurs = state.activeMessageId === entry.id;

      if (isOurs && (state.state === 'playing' || state.state === 'loading')) {
        playingRef.current = true;
        setActiveBlock((prev) => prev ?? 0);
      }

      if (playingRef.current && (state.state === 'idle' || state.state === 'error' || (!isOurs && state.activeMessageId !== null))) {
        playingRef.current = false;
        setActiveBlock(null);
      }
    });
  }, [entry.id, entry.role]);

  const handleBlockClick = useCallback((blockIndex: number) => {
    const textFromHere = mdBlocks
      .slice(blockIndex)
      .map(b => b.rawText)
      .join('\n\n');

    if (!textFromHere.trim()) return;

    setActiveBlock(blockIndex);
    void ttsEngine.play(textFromHere, entry.id);
  }, [mdBlocks, entry.id]);

  if (isCompactionEntry(entry)) {
    return (
      <div className="remodex-compaction-card">
        <span className="remodex-compaction-icon" aria-hidden="true">⟳</span>
        <span className="remodex-compaction-label">Context compacted</span>
        {showTimestamp ? <span className="remodex-compaction-time">{entry.timestampLabel ?? ''}</span> : null}
      </div>
    );
  }

  if (!isUser && runtimeEvent) {
    return (
      <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '2px 0',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 10,
              background: 'rgba(37, 99, 235, 0.10)',
              color: '#2563eb',
              flexShrink: 0,
            }}>
              <Sparkles size={15} strokeWidth={2.2} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                {runtimeEvent.title}
              </div>
              <div style={{
                marginTop: 2,
                fontSize: 11,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.45,
              }}>
                {runtimeEvent.summary}
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
              background: 'rgba(37, 99, 235, 0.10)',
              color: '#2563eb',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}>
              sub-agent
            </span>
            {runtimeEvent.status ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: runtimeEvent.status.toLowerCase().includes('timed')
                  ? 'rgba(245, 158, 11, 0.10)'
                  : 'rgba(37, 99, 235, 0.10)',
                color: runtimeEvent.status.toLowerCase().includes('timed') ? '#b45309' : '#2563eb',
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {runtimeEvent.status}
              </span>
            ) : null}
            {runtimeEvent.source ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: 'rgba(148, 163, 184, 0.10)',
                color: '#475569',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}>
                {runtimeEvent.source}
              </span>
            ) : null}
            {runtimeEvent.changedFiles?.length ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: 'rgba(15, 23, 42, 0.06)',
                color: '#334155',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}>
                {runtimeEvent.changedFiles.length} file{runtimeEvent.changedFiles.length !== 1 ? 's' : ''}
              </span>
            ) : null}
            {(runtimeEvent.action || runtimeEvent.rawPreviewLines?.length || runtimeEvent.changedFiles?.length) ? (
              <button
                type="button"
                onClick={() => setHandoffExpanded((value) => !value)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 8px',
                  borderRadius: 999,
                  border: '1px solid rgba(148, 163, 184, 0.16)',
                  background: handoffExpanded ? 'rgba(148, 163, 184, 0.10)' : 'rgba(255,255,255,0.72)',
                  color: '#475569',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  cursor: 'pointer',
                }}
              >
                {handoffExpanded ? 'Hide details' : 'View details'}
              </button>
            ) : null}
          </div>

          {handoffExpanded && (runtimeEvent.action || runtimeEvent.rawPreviewLines?.length || runtimeEvent.changedFiles?.length) ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 12,
              background: 'rgba(248, 250, 252, 0.98)',
              border: '1px solid rgba(226, 232, 240, 0.95)',
            }}>
              {runtimeEvent.action ? (
                <div>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#64748b',
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
                    {runtimeEvent.action}
                  </div>
                </div>
              ) : null}

              {runtimeEvent.changedFiles?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Changed Files
                  </div>
                  {runtimeEvent.changedFiles.map((filePath) => (
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

              {runtimeEvent.rawPreviewLines?.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: '#64748b',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Payload Preview
                  </div>
                  <div style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: 'rgba(255,255,255,0.84)',
                    border: '1px solid rgba(226, 232, 240, 0.95)',
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: '#334155',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {runtimeEvent.rawPreviewLines.join('\n')}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (isUser) {
    return (
      <div className={`remodex-user-turn-wrap${isNew ? ' remodex-turn-new' : ''}`}>
        {hasText ? (
          <div
            className="remodex-user-bubble"
            style={isSlashCommand ? {
              background: 'rgba(15, 23, 42, 0.92)',
              color: '#f8fafc',
              border: '1px solid rgba(148, 163, 184, 0.18)',
            } : undefined}
          >
            {isSlashCommand ? (
              <div style={{ marginBottom: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#93c5fd' }}>
                Slash Command
              </div>
            ) : null}
            <div
              className="remodex-rich-text"
              style={isSlashCommand ? { fontFamily: '"SF Mono", ui-monospace, monospace', fontSize: '0.88rem' } : undefined}
            >
              {entry.text.split('\n').map((line, i) => (
                <p key={i} className="remodex-rich-paragraph">{line}</p>
              ))}
            </div>
          </div>
        ) : null}
        {hasMedia ? (
          <div className="remodex-media-grid remodex-media-grid-right">
            {entry.media!.map((item) =>
              isImageMedia(item) ? (
                <div key={item.path} className="remodex-media-card remodex-media-card-image">
                  <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
                </div>
              ) : null
            )}
          </div>
        ) : null}
        {showTimestamp ? (
          <span className="remodex-turn-time">
            {entry.id.startsWith('local-') ? (
              <span style={{ color: 'var(--t-text-muted)', fontStyle: 'italic' }}>Sending…</span>
            ) : (
              entry.timestampLabel ?? 'now'
            )}
          </span>
        ) : null}
      </div>
    );
  }

  const collapsedOperator = shouldCollapseOperatorEntry(entry) ? buildOperatorSummary(entry.text) : null;

  if (!isUser && collapsedOperator && !operatorExpanded) {
    return (
      <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
        {speakerChanged ? (
          <div className="remodex-message-head">
            <span>{roleLabel(entry.role, agentName)}</span>
          </div>
        ) : null}
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '2px 0',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 10,
              background: 'rgba(15, 23, 42, 0.06)',
              color: '#475569',
              flexShrink: 0,
            }}>
              <SlidersHorizontal size={14} strokeWidth={2.1} />
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--t-text)',
                letterSpacing: '-0.01em',
              }}>
                Operator summary
              </div>
              <div style={{
                marginTop: 3,
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--t-text-secondary)',
              }}>
                {collapsedOperator.headline}
              </div>
            </div>
          </div>

          {collapsedOperator.details.length > 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              paddingLeft: 38,
            }}>
              {collapsedOperator.details.map((detail) => (
                <div
                  key={detail}
                  style={{
                    fontSize: 11,
                    color: '#64748b',
                    lineHeight: 1.45,
                  }}
                >
                  {detail}
                </div>
              ))}
            </div>
          ) : null}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingLeft: 38,
          }}>
            <span style={{
              fontSize: 10,
              color: '#94a3b8',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {collapsedOperator.stats}
            </span>
            <button
              type="button"
              onClick={() => setOperatorExpanded(true)}
              style={{
                border: '1px solid rgba(148, 163, 184, 0.16)',
                borderRadius: 999,
                background: 'rgba(255,255,255,0.72)',
                color: '#475569',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.02em',
                padding: '4px 9px',
                cursor: 'pointer',
              }}
            >
              View full note
            </button>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={`remodex-message-card remodex-message-card-assistant${isNew ? ' remodex-turn-new' : ''}`}>
      {speakerChanged ? (
        <div className="remodex-message-head">
          <span>{roleLabel(entry.role, agentName)}</span>
        </div>
      ) : null}
      {hasText ? (
        <div className="remodex-rich-text">
          {entry.role === 'assistant' ? (
            mdBlocks.map((block, idx) => (
              <div
                key={idx}
                onClick={() => handleBlockClick(idx)}
                style={{
                  cursor: 'pointer',
                  borderLeft: activeBlock !== null && idx >= activeBlock
                    ? '2px solid #2563eb'
                    : '2px solid transparent',
                  paddingLeft: 8,
                  marginLeft: -10,
                  borderRadius: 2,
                  transition: 'border-color 200ms ease, background 200ms ease',
                  background: activeBlock === idx ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                }}
                title="Click to play from here"
              >
                {block.element}
              </div>
            ))
          ) : (
            mdBlocks.map(b => b.element)
          )}
        </div>
      ) : null}
      {hasMedia ? (
        <div className="remodex-media-grid">
          {entry.media!.map((item) =>
            isImageMedia(item) ? (
              <div key={item.path} className="remodex-media-card remodex-media-card-image">
                <Image src={mediaHref(item.path)} alt={item.name} width={1200} height={900} unoptimized loading="lazy" />
              </div>
            ) : null
          )}
        </div>
      ) : null}
      {hasToolCalls ? (
        <div style={{ marginTop: hasText || hasMedia ? 12 : 0 }}>
          <DesktopToolCallStack toolCalls={entry.toolCalls ?? []} />
        </div>
      ) : null}
      {entry.role === 'assistant' && hasText ? (
        <MessageActions messageId={entry.id} messageText={entry.text} />
      ) : null}
      {collapsedOperator ? (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setOperatorExpanded(false)}
            style={{
              border: 'none',
              background: 'transparent',
              color: '#64748b',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            Collapse note
          </button>
        </div>
      ) : null}
    </article>
  );
});

// ── Markdown renderer ──

/** Parsed block with its raw text for TTS point-to-play */
interface RenderedBlock {
  element: React.ReactNode;
  rawText: string;
}

function renderMarkdownBlocks(text: string, onOpenMermaid?: (code: string) => void, onRunInTerminal?: (command: string) => void): RenderedBlock[] {
  const lines = text.split('\n');
  const blocks: RenderedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const raw = codeLines.join('\n');
      blocks.push({
        rawText: lang?.toLowerCase() === 'mermaid' ? 'diagram' : raw,
        element: <CodeBlock key={`code-${i}`} code={raw} language={lang || undefined} onOpenMermaid={onOpenMermaid} onRunInTerminal={onRunInTerminal} />,
      });
      continue;
    }

    if (line.startsWith('## ')) {
      const raw = line.slice(3);
      blocks.push({
        rawText: raw,
        element: <h3 key={`h-${i}`} className="remodex-rich-heading">{raw}</h3>,
      });
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      const raw = line.slice(2);
      blocks.push({
        rawText: raw,
        element: <h2 key={`h-${i}`} className="remodex-rich-heading">{raw}</h2>,
      });
      i++;
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      const listItems: { text: string; key: number }[] = [];
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        listItems.push({ text: lines[i].slice(2), key: i });
        i++;
      }
      const raw = listItems.map(item => item.text).join('. ');
      blocks.push({
        rawText: raw,
        element: (
          <ul key={`ul-${listItems[0].key}`} className="remodex-rich-list">
            {listItems.map(item => (
              <li key={item.key}>{renderInline(item.text)}</li>
            ))}
          </ul>
        ),
      });
      continue;
    }

    if (line.includes('|') && line.trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const isSeparator = (l: string) => /^\s*\|[\s:_-|]+\|\s*$/.test(l);
        const parseCells = (l: string) => l.split('|').slice(1, -1).map(c => c.trim());
        const hasSep = tableLines.length >= 2 && isSeparator(tableLines[1]);
        const headerCells = parseCells(tableLines[0]);
        const bodyRows = tableLines.slice(hasSep ? 2 : 1).filter(l => !isSeparator(l));
        const raw = [headerCells.join(', '), ...bodyRows.map(r => parseCells(r).join(', '))].join('. ');

        blocks.push({
          rawText: raw,
          element: (
            <div key={`table-${i}`} style={{
              overflowX: 'auto',
              margin: '12px 0',
              borderRadius: 12,
              border: '1px solid var(--t-divider)',
              backgroundColor: 'var(--t-panel)',
              boxShadow: '0 1px 3px var(--t-divider-subtle)',
            }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
              }}>
                <thead>
                  <tr>
                    {headerCells.map((cell, ci) => (
                      <th key={ci} style={{
                        textAlign: 'left',
                        padding: '10px 14px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        color: 'var(--t-text-secondary)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        borderBottom: '2px solid var(--t-divider)',
                        whiteSpace: 'nowrap',
                      }}>
                        {renderInline(cell)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, ri) => {
                    const cells = parseCells(row);
                    return (
                      <tr key={ri} style={{
                        backgroundColor: ri % 2 === 0 ? 'var(--t-panel)' : 'var(--t-bg)',
                      }}>
                        {cells.map((cell, ci) => (
                          <td key={ci} style={{
                            textAlign: 'left',
                            padding: '10px 14px',
                            fontSize: '0.85rem',
                            color: 'var(--t-text)',
                            borderBottom: '1px solid var(--t-divider-subtle)',
                          }}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ),
        });
      }
      continue;
    }

    // Block-level images: ![alt](url) on its own line
    const blockImgMatch = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (blockImgMatch) {
      blocks.push({
        rawText: blockImgMatch[1] || 'image',
        element: <ChatImage key={`img-${i}`} alt={blockImgMatch[1]} src={blockImgMatch[2]} />,
      });
      i++;
      continue;
    }

    // Bare image file paths on their own line
    const bareImgMatch = line.trim().match(/^(\/[^\s]+\.(png|jpg|jpeg|gif|webp|svg))$/i);
    if (bareImgMatch) {
      blocks.push({
        rawText: bareImgMatch[1].split('/').pop() ?? 'image',
        element: <ChatImage key={`img-${i}`} alt={bareImgMatch[1].split('/').pop() ?? 'image'} src={bareImgMatch[1]} />,
      });
      i++;
      continue;
    }

    // MEDIA: lines
    if (line.trim().startsWith('MEDIA:')) {
      const mediaPath = line.trim().slice(6).trim();
      if (mediaPath) {
        blocks.push({
          rawText: 'image',
          element: <ChatImage key={`media-${i}`} alt="Generated image" src={mediaPath} />,
        });
      }
      i++;
      continue;
    }

    if (!line.trim()) { i++; continue; }

    blocks.push({
      rawText: line.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'),
      element: <p key={`p-${i}`} className="remodex-rich-paragraph">{renderInline(line)}</p>,
    });
    i++;
  }

  return blocks;
}

function resolveImageSrc(src: string): string {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  return `/api/panel/serve-image?path=${encodeURIComponent(src)}`;
}

function ChatImage({ src, alt }: { src: string; alt: string }) {
  const [lightbox, setLightbox] = React.useState(false);
  const resolved = resolveImageSrc(src);
  return (
    <>
      <img
        src={resolved}
        alt={alt}
        onClick={() => setLightbox(true)}
        style={{
          maxWidth: '100%',
          maxHeight: 360,
          borderRadius: 10,
          marginTop: 8,
          marginBottom: 8,
          cursor: 'zoom-in',
          boxShadow: '0 2px 12px var(--t-divider)',
          border: '1px solid var(--t-divider)',
          display: 'block',
        }}
      />
      {lightbox && ReactDOM.createPortal(
        <div
          onClick={() => setLightbox(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            cursor: 'zoom-out',
          }}
        >
          <button
            type="button"
            onClick={() => setLightbox(false)}
            style={{
              position: 'absolute',
              top: 16,
              right: 16,
              width: 36,
              height: 36,
              borderRadius: 18,
              border: 'none',
              background: 'rgba(255,255,255,0.15)',
              color: '#ffffff',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 100000,
            }}
          >
            ✕
          </button>
          <img
            src={resolved}
            alt={alt}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: '92vw',
              maxHeight: '90vh',
              objectFit: 'contain',
              borderRadius: 8,
              boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
              cursor: 'default',
            }}
          />
        </div>,
        document.body
      )}
    </>
  );
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((part, i) => {
    // Images: ![alt](url)
    const imgMatch = part.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      return <ChatImage key={i} alt={imgMatch[1]} src={imgMatch[2]} />;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={i} className="remodex-rich-inline-code">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    // Links: [text](url)
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer"
          style={{ color: '#2563eb', textDecoration: 'none', borderBottom: '1px solid rgba(37,99,235,0.3)' }}>
          {linkMatch[1]}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

const DesktopChatHeader = memo(function DesktopChatHeader({
  pickerRef,
  pickerOpen,
  setPickerOpen,
  projectGroups,
  selectedSession,
  activeTitle,
  headerLabel,
  activeSubtitle,
  connectionDotColor,
  handleSessionFocus,
  expandedGroup,
  setExpandedGroup,
  diffStats,
  onOpenDiff,
  setDiffOpen,
}: {
  pickerRef: React.RefObject<HTMLDivElement | null>;
  pickerOpen: boolean;
  setPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  projectGroups: ProjectGroup[];
  selectedSession: SessionSummary | undefined;
  activeTitle: string;
  headerLabel: string;
  activeSubtitle: string;
  connectionDotColor: string;
  handleSessionFocus: (sessionId: string) => void;
  expandedGroup: string | null;
  setExpandedGroup: React.Dispatch<React.SetStateAction<string | null>>;
  diffStats: { additions: number; deletions: number; files: number };
  onOpenDiff?: () => void;
  setDiffOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const diffIsActive = diffStats.files > 0;

  return (
    <header
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '12px 14px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.22)',
        background: 'linear-gradient(180deg, rgba(246,249,255,0.58), rgba(255,255,255,0.18))',
        backdropFilter: 'blur(24px) saturate(1.25)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.25)',
        boxShadow: '0 1px 0 rgba(255,255,255,0.42)',
        zIndex: 10,
      }}
    >
      <div ref={pickerRef} style={{ minWidth: 0, flex: 1, position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPickerOpen((p) => !p)}
          className="desktop-session-pill"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            padding: '10px 12px',
            margin: 0,
            border: pickerOpen ? '1px solid rgba(37, 99, 235, 0.18)' : '1px solid rgba(148, 163, 184, 0.14)',
            borderRadius: 18,
            background: pickerOpen
              ? 'linear-gradient(180deg, rgba(255,255,255,0.99), rgba(239,246,255,0.95))'
              : 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.92))',
            cursor: 'pointer',
            textAlign: 'left',
            WebkitTapHighlightColor: 'transparent',
            transition: 'background 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
            boxShadow: pickerOpen
              ? '0 10px 24px rgba(37, 99, 235, 0.07)'
              : '0 6px 16px rgba(15, 23, 42, 0.035)',
          }}
          onMouseEnter={(e) => {
            if (!pickerOpen) {
              e.currentTarget.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.99), rgba(241,245,255,0.94))';
              e.currentTarget.style.borderColor = 'rgba(37, 99, 235, 0.12)';
            }
          }}
          onMouseLeave={(e) => {
            if (!pickerOpen) {
              e.currentTarget.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.92))';
              e.currentTarget.style.borderColor = 'rgba(148, 163, 184, 0.14)';
            }
          }}
          aria-label="Switch session"
          aria-expanded={pickerOpen}
        >
          <span style={{ position: 'relative', width: 10, height: 10, flexShrink: 0 }}>
            {connectionDotColor === '#ff9f0a' && (
              <span style={{
                position: 'absolute', inset: 0, borderRadius: '50%',
                background: '#a78bfa',
                animation: 'reviewingRing 2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
              }} />
            )}
            <span style={{
              position: 'relative', display: 'block',
              width: 10, height: 10, borderRadius: '50%',
              backgroundColor: connectionDotColor === '#ff9f0a' ? undefined : connectionDotColor,
              background: connectionDotColor === '#ff9f0a' ? 'linear-gradient(135deg, #f59e0b, #a78bfa)' : connectionDotColor,
              boxShadow: connectionDotColor === '#34c759' ? '0 0 10px rgba(52, 199, 89, 0.4)'
                : connectionDotColor === '#2563eb' ? '0 0 10px rgba(37, 99, 235, 0.34)'
                : connectionDotColor === '#ff9f0a' ? '0 0 9px rgba(167, 139, 250, 0.42)'
                : 'none',
              animation: connectionDotColor === '#ff9f0a' ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
            }} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--t-text)',
              letterSpacing: '-0.02em',
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {activeTitle}
            </div>
            <div style={{
              fontSize: 11.5,
              color: 'var(--t-text-muted)',
              lineHeight: 1.3,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {headerLabel} · {activeSubtitle}
            </div>
          </div>
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: pickerOpen ? 'rgba(37, 99, 235, 0.08)' : 'rgba(15, 23, 42, 0.05)',
              color: pickerOpen ? '#2563eb' : 'var(--t-text-faint)',
              flexShrink: 0,
            }}
          >
            <ChevronDown
              size={13}
              strokeWidth={2}
              style={{
                transition: 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)',
                transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </span>
        </button>

        {pickerOpen ? (
          <div
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: '-4px',
              right: '-4px',
              zIndex: 100,
              borderRadius: '18px',
              border: '1px solid rgba(37, 99, 235, 0.12)',
              background: 'linear-gradient(180deg, rgba(255,255,255,0.99), rgba(247,250,255,0.95))',
              backdropFilter: 'blur(40px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(40px) saturate(1.6)',
              boxShadow: '0 18px 44px rgba(15, 23, 42, 0.14), 0 6px 18px rgba(37, 99, 235, 0.05)',
              padding: '8px',
              maxHeight: '60vh',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {projectGroups.map((group, gi) => {
            const isExpanded = expandedGroup === group.workspace;
            const isSingle = group.sessions.length === 1;
            const containsSelected = group.sessions.some((s) => s.sessionKey === selectedSession?.sessionKey);
            const singleSessionFolder = isSingle ? sessionLocalFolderLabel(group.sessions[0]) : null;
            const isGroupMainOpenClaw = group.sessions.some((s) => s.runtime === 'openclaw' && s.sessionKey === 'agent:main:main');
            const dotColor = isGroupMainOpenClaw
              ? '#2563eb'
              : group.hasRunning
                ? '#34c759'
                : group.bestContextPct >= 75
                  ? '#ff9f0a'
                  : '#8e8e93';

            return (
              <div key={group.workspace}>
                <button
                  type="button"
                  onClick={() => {
                    if (isSingle) {
                      handleSessionFocus(group.sessions[0].sessionKey);
                      setPickerOpen(false);
                    } else {
                      setExpandedGroup(isExpanded ? null : group.workspace);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    width: '100%',
                    padding: '10px 12px',
                    border: 'none',
                    borderRadius: '12px',
                    background: containsSelected && !isExpanded
                      ? 'rgba(37, 99, 235, 0.08)'
                      : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 120ms ease',
                    minHeight: '44px',
                  }}
                >
                  {(() => {
                    const isGroupReviewing = !isGroupMainOpenClaw && !group.hasRunning && group.sessions.some((s) => s.status === 'reviewing');
                    return (
                      <span style={{ position: 'relative', width: '8px', height: '8px', flexShrink: 0 }}>
                        {isGroupReviewing && (
                          <span style={{
                            position: 'absolute', inset: 0, borderRadius: '50%',
                            background: '#a78bfa',
                            animation: 'reviewingRing 2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                          }} />
                        )}
                        <span style={{
                          position: 'relative', display: 'block',
                          width: '8px', height: '8px', borderRadius: '50%',
                          background: isGroupReviewing ? 'linear-gradient(135deg, #f59e0b, #a78bfa)' : dotColor,
                          flexShrink: 0,
                          boxShadow: isGroupMainOpenClaw ? `0 0 6px ${dotColor}`
                            : isGroupReviewing ? '0 0 6px rgba(167, 139, 250, 0.5)'
                            : group.hasRunning ? `0 0 6px ${dotColor}` : 'none',
                          animation: isGroupReviewing ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
                        }} />
                      </span>
                    );
                  })()}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: '14px',
                      fontWeight: containsSelected ? 700 : 600,
                      color: containsSelected ? '#2563eb' : 'var(--t-text)',
                      lineHeight: 1.3,
                    }}>
                      {group.projectName}
                    </div>
                    <div style={{
                      fontSize: '12px',
                      color: 'var(--t-text-muted)',
                      lineHeight: 1.3,
                      marginTop: '1px',
                    }}>
                      {singleSessionFolder ?? group.summary}
                      {group.mostRecentTime ? ` · ${group.mostRecentTime}` : ''}
                    </div>
                  </div>
                  {containsSelected && isSingle ? (
                    <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                  ) : !isSingle ? (
                    <ChevronRight
                      size={14}
                      strokeWidth={2.2}
                      style={{
                        flexShrink: 0,
                        color: 'var(--t-text-muted)',
                        transition: 'transform 220ms cubic-bezier(0.32, 0.72, 0, 1)',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}
                    />
                  ) : null}
                </button>

                {isExpanded && !isSingle ? (
                  <div style={{
                    marginLeft: '18px',
                    borderLeft: '2px solid rgba(37, 99, 235, 0.12)',
                    paddingLeft: '8px',
                    marginTop: '3px',
                    marginBottom: '4px',
                  }}>
                    {group.sessions.map((session) => {
                      const isActive = session.sessionKey === selectedSession?.sessionKey;
                      const isRunning = session.status === 'running' || session.status === 'reviewing';
                      const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                      const isSessionMainOpenClaw = session.runtime === 'openclaw' && session.sessionKey === 'agent:main:main';
                      const isSessionReviewing = !isSessionMainOpenClaw && !isRunning && session.status === 'reviewing';
                      const sDotColor = isSessionMainOpenClaw ? '#2563eb' : isRunning ? '#34c759' : isSessionReviewing ? '#a78bfa' : sessionPercent >= 75 ? '#ff9f0a' : '#8e8e93';
                      const rawName = session.name ?? session.sessionKey ?? session.id;
                      const runtimeTag = session.runtime === 'claude-code' ? ' · Claude Code'
                        : session.runtime === 'codex' ? ' · Codex'
                        : '';
                      const name = rawName + runtimeTag;
                      const subtitle = sessionLocalFolderLabel(session)
                        ?? session.currentTask
                        ?? session.branch?.replace(/^(feat|fix|batch|chore|refactor)\//, '')
                        ?? session.sessionKey
                        ?? '';

                      return (
                        <button
                          key={session.sessionKey}
                          type="button"
                          onClick={() => {
                            handleSessionFocus(session.sessionKey);
                            setPickerOpen(false);
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '10px',
                            width: '100%',
                            padding: '8px 10px',
                            border: 'none',
                            borderRadius: '10px',
                            background: isActive ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'background 120ms ease',
                            minHeight: '44px',
                          }}
                        >
                          <span style={{ position: 'relative', width: '6px', height: '6px', flexShrink: 0 }}>
                            {isSessionReviewing && (
                              <span style={{
                                position: 'absolute', inset: 0, borderRadius: '50%',
                                background: '#a78bfa',
                                animation: 'reviewingRing 2s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                              }} />
                            )}
                            <span style={{
                              position: 'relative', display: 'block',
                              width: '6px', height: '6px', borderRadius: '50%',
                              background: isSessionReviewing ? 'linear-gradient(135deg, #f59e0b, #a78bfa)' : sDotColor,
                              boxShadow: isRunning ? `0 0 5px ${sDotColor}` : isSessionReviewing ? '0 0 5px rgba(167, 139, 250, 0.4)' : 'none',
                              animation: isSessionReviewing ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
                            }} />
                          </span>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{
                              fontSize: '13px',
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? '#2563eb' : 'var(--t-text)',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {name}
                            </div>
                            {subtitle ? (
                              <div style={{
                                fontSize: '11px',
                                color: 'var(--t-text-muted)',
                                lineHeight: 1.3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginTop: '1px',
                              }}>
                                {subtitle}
                              </div>
                            ) : null}
                          </div>
                          {isActive ? (
                            <span style={{ fontSize: '11px', fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>✓</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {gi < projectGroups.length - 1 ? (
                  <div style={{
                    height: '1px',
                    background: 'var(--t-divider)',
                    margin: '4px 12px',
                  }} />
                ) : null}
              </div>
            );
            })}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onOpenDiff ? onOpenDiff() : setDiffOpen(true)}
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          paddingTop: 7,
          paddingRight: 12,
          paddingBottom: 7,
          paddingLeft: 12,
          borderRadius: 999,
          border: diffIsActive ? '1px solid rgba(37, 99, 235, 0.16)' : '1px solid rgba(148, 163, 184, 0.14)',
          background: diffIsActive
            ? 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(239,246,255,0.92))'
            : 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.92))',
          color: 'var(--t-text-muted)',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'all 150ms ease',
          boxShadow: diffIsActive
            ? '0 8px 18px rgba(37, 99, 235, 0.07)'
            : '0 5px 14px rgba(15, 23, 42, 0.035)',
        }}
        aria-label="Open diff sheet"
      >
        <span style={{ color: '#22c55e', fontSize: 13, fontWeight: 700 }}>+{diffStats.additions}</span>
        <span style={{ color: '#ef4444', fontSize: 13, fontWeight: 700 }}>-{diffStats.deletions}</span>
        <span style={{ color: 'var(--t-text-muted)', fontWeight: 600 }}>{diffStats.files} file{diffStats.files !== 1 ? 's' : ''}</span>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: diffIsActive ? 'rgba(37, 99, 235, 0.08)' : 'rgba(15, 23, 42, 0.05)',
            color: diffIsActive ? '#2563eb' : 'var(--t-text-muted)',
          }}
        >
          <SlidersHorizontal size={11} strokeWidth={2} />
        </span>
      </button>
    </header>
  );
});

export const DesktopTranscriptPane = memo(function DesktopTranscriptPane({
  loading,
  transcript,
  currentAgentName,
  onOpenMermaid,
  onRunInTerminal,
  streamingText,
  agentRunning,
  activityHeadline,
  liveToolCalls = [],
  onOpenDiff,
  onOpenFile,
  currentWorkspace,
  runtimeCapabilities,
  approvals,
  resolvingApprovalId,
  onResolveApproval,
  scrollRef,
  handleScroll,
  showScrollPill,
  scrollToBottom,
  getIsNewEntry,
  topInset = 12,
}: {
  loading: boolean;
  transcript: MobileTranscriptEntry[];
  currentAgentName: string;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  streamingText: string;
  agentRunning: boolean;
  activityHeadline?: string;
  liveToolCalls?: MobileTranscriptToolCall[];
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  currentWorkspace?: string;
  runtimeCapabilities: SidebarRuntimeCapabilities;
  approvals: SidebarApproval[];
  resolvingApprovalId: string | null;
  onResolveApproval: (id: string, action: 'approve' | 'reject') => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  handleScroll: () => void;
  showScrollPill: boolean;
  scrollToBottom: (force?: boolean) => void;
  getIsNewEntry: (entryId: string) => boolean;
  topInset?: number;
}) {
  const supportsLiveText = runtimeCapabilities.supportsLiveText;
  const supportsToolEvents = runtimeCapabilities.supportsToolEvents;
  const normalizedTranscript = useMemo(() => dedupeTranscriptEntries(transcript), [transcript]);

  const activeTranscriptEntry = useMemo(() => {
    if (!agentRunning || !supportsLiveText) return null;
    const last = normalizedTranscript[normalizedTranscript.length - 1];
    if (!last || last.role !== 'assistant') return null;
    if (!last.id.startsWith('claude-') && !last.id.startsWith('codex-')) return null;
    return last;
  }, [agentRunning, normalizedTranscript, supportsLiveText]);

  const visibleTranscript = useMemo(
    () => activeTranscriptEntry
      ? normalizedTranscript.filter((entry) => entry.id !== activeTranscriptEntry.id)
      : normalizedTranscript,
    [activeTranscriptEntry, normalizedTranscript],
  );

  const groupedTranscript = useMemo(() => groupTranscriptTurns(visibleTranscript), [visibleTranscript]);
  const activeTurnText = supportsLiveText ? (streamingText || activeTranscriptEntry?.text || '') : '';
  const showActiveTurn = Boolean(
    (supportsLiveText && (agentRunning || activeTurnText))
    || (supportsToolEvents && liveToolCalls.length > 0)
    || Boolean(activityHeadline),
  );

  return (
    <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="remodex-message-stack"
        style={{
          flex: 1,
          overflowY: 'auto',
          paddingTop: topInset,
          paddingRight: 14,
          paddingBottom: 12,
          paddingLeft: 14,
        }}
      >
        {loading ? (
          <div className="remodex-skeleton-stack">
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user" />
            <div className="remodex-skeleton-bubble remodex-skeleton-assistant remodex-skeleton-wide" />
            <div className="remodex-skeleton-bubble remodex-skeleton-user remodex-skeleton-short" />
          </div>
        ) : visibleTranscript.length === 0 && !showActiveTurn ? (
          <div className="remodex-loading-card">
            No transcript visible yet — waiting for activity.
          </div>
        ) : (
          groupedTranscript.map((group, groupIndex) => {
            if (group.kind !== 'agent') {
              return group.entries.map((entry) => {
                const entryIndex = normalizedTranscript.findIndex((candidate) => candidate.id === entry.id);
                const isNew = getIsNewEntry(entry.id);
                return (
                  <Bubble
                    key={entry.id}
                    entry={entry}
                    previousEntry={entryIndex > 0 ? normalizedTranscript[entryIndex - 1] : null}
                    agentName={currentAgentName}
                    isNew={isNew}
                    onOpenMermaid={onOpenMermaid}
                    onRunInTerminal={onRunInTerminal}
                  />
                );
              });
            }

            return (
              <AgentTurnGroup
                key={group.id}
                group={group}
                previousGroup={groupIndex > 0 ? groupedTranscript[groupIndex - 1] : null}
                transcript={normalizedTranscript}
                currentAgentName={currentAgentName}
                getIsNewEntry={getIsNewEntry}
                onOpenMermaid={onOpenMermaid}
                onRunInTerminal={onRunInTerminal}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                currentWorkspace={currentWorkspace}
              />
            );
          })
        )}

      {showActiveTurn && (
          <div style={{
            display: 'flex',
            paddingTop: 8,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
          }}>
            <ActiveTurnCard
              agentName={currentAgentName}
              text={activeTurnText}
              activityHeadline={activityHeadline}
              liveToolCalls={liveToolCalls}
              onOpenMermaid={onOpenMermaid}
              onRunInTerminal={onRunInTerminal}
            />
          </div>
        )}
      </div>

      <SidebarApprovalCard
        approvals={approvals}
        resolvingId={resolvingApprovalId}
        onResolve={onResolveApproval}
      />

      {showScrollPill && (
        <div style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10,
        }}>
          <button
            onClick={() => scrollToBottom(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 10px',
              borderRadius: 10,
              border: '1px solid rgba(0,0,0,0.08)',
              background: 'rgba(255,255,255,0.85)',
              backdropFilter: 'blur(20px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
              boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
              transition: 'all 150ms ease',
            }}
          >
            <ChevronDown size={11} />
            ↓
          </button>
        </div>
      )}
    </div>
  );
});

const AgentTurnGroup = memo(function AgentTurnGroup({
  group,
  previousGroup,
  transcript,
  currentAgentName,
  getIsNewEntry,
  onOpenMermaid,
  onRunInTerminal,
  onOpenDiff,
  onOpenFile,
  currentWorkspace,
}: {
  group: TranscriptGroup;
  previousGroup: TranscriptGroup | null;
  transcript: MobileTranscriptEntry[];
  currentAgentName: string;
  getIsNewEntry: (entryId: string) => boolean;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  currentWorkspace?: string;
}) {
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);
  const previousTs = previousGroup ? groupTimestamp(previousGroup.entries) : undefined;
  const currentTs = groupTimestamp(group.entries);
  const showTimeSeparator = Boolean(
    previousTs && currentTs && Math.abs(currentTs - previousTs) >= 8 * 60 * 1000,
  );
  const showGroupLabel = group.entries.length > 1
    || group.entries.some((entry) => entry.role === 'system' || entry.toolCalls?.length);
  const groupSummary = useMemo(() => summarizeAgentGroup(group.entries), [group.entries]);
  const sourceCards = useMemo(() => buildGroupSourceCards(group.entries), [group.entries]);
  const expandedCard = sourceCards.find((card) => card.id === expandedSourceId) ?? null;
  const fileDetails = useMemo(
    () => (expandedCard?.details ?? []).filter(looksLikeWorkspaceFile).slice(0, 8),
    [expandedCard],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginTop: 2,
      }}
    >
      {showTimeSeparator || groupSummary.separatorLabel ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 8,
          marginBottom: 2,
        }}>
          <div style={{ flex: 1, height: 1, background: 'rgba(148, 163, 184, 0.16)' }} />
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}>
            {groupSummary.separatorLabel ?? groupSummary.timeLabel ?? 'run'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'rgba(148, 163, 184, 0.16)' }} />
        </div>
      ) : null}

      {showGroupLabel ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          alignSelf: 'stretch',
        }}>
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            padding: '4px 0',
          }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 9px',
              borderRadius: 999,
              background: 'rgba(37, 99, 235, 0.06)',
              color: '#2563eb',
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}>
              {currentAgentName}
              <span style={{ color: 'rgba(37, 99, 235, 0.5)' }}>•</span>
              {group.entries.length} update{group.entries.length !== 1 ? 's' : ''}
            </span>
            {groupSummary.timeLabel ? (
              <span style={{
                fontSize: 10,
                color: '#94a3b8',
                fontWeight: 600,
              }}>
                {groupSummary.timeLabel}
              </span>
            ) : null}
            {groupSummary.chips.map((chip) => (
              <span
                key={`${group.id}-${chip.label}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 8px',
                  borderRadius: 999,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  ...chipStyles(chip.tone),
                }}
              >
                {chip.label}
              </span>
            ))}
          </div>

          {sourceCards.length > 0 ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxWidth: '92%',
            }}>
              <div style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
              }}>
                {sourceCards.map((card) => (
                  <button
                    key={`${group.id}-${card.id}`}
                    type="button"
                    onClick={() => setExpandedSourceId((current) => current === card.id ? null : card.id)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 2,
                      minWidth: 120,
                      padding: '9px 10px',
                      borderRadius: 12,
                      border: '1px solid rgba(226, 232, 240, 0.95)',
                      background: expandedSourceId === card.id ? 'rgba(255,255,255,0.94)' : 'rgba(248,250,252,0.82)',
                      boxShadow: expandedSourceId === card.id ? '0 10px 24px rgba(15, 23, 42, 0.06)' : 'none',
                      transition: 'transform 180ms ease, box-shadow 180ms ease, background 180ms ease, border-color 180ms ease',
                      cursor: 'pointer',
                      textAlign: 'left',
                      animation: 'sidebarSourceCardIn 220ms ease-out',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = '0 14px 28px rgba(15, 23, 42, 0.08)';
                      e.currentTarget.style.background = 'rgba(255,255,255,0.94)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = expandedSourceId === card.id ? '0 10px 24px rgba(15, 23, 42, 0.06)' : 'none';
                      e.currentTarget.style.background = expandedSourceId === card.id ? 'rgba(255,255,255,0.94)' : 'rgba(248,250,252,0.82)';
                    }}
                  >
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '3px 7px',
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      ...chipStyles(card.tone),
                    }}>
                      {card.label}
                    </span>
                    <span style={{
                      fontSize: 11,
                      color: '#334155',
                      fontWeight: 600,
                      lineHeight: 1.35,
                    }}>
                      {card.summary}
                    </span>
                  </button>
                ))}
              </div>

              {expandedSourceId ? (
                <div style={{
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.88)',
                  border: '1px solid rgba(226, 232, 240, 0.95)',
                  boxShadow: '0 10px 24px rgba(15, 23, 42, 0.05)',
                  animation: 'sidebarSourceExpand 180ms ease-out',
                }}>
                  {(expandedCard?.links ?? []).length > 0 ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      marginBottom: (expandedCard?.details ?? []).length > 0 ? 10 : 0,
                    }}>
                      <div style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#64748b',
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                      }}>
                        Sources
                      </div>
                      <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}>
                        {(expandedCard?.links ?? []).map((link) => (
                          <a
                            key={link.href}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                              display: 'block',
                              padding: '8px 10px',
                              borderRadius: 10,
                              background: 'rgba(248,250,252,0.92)',
                              border: '1px solid rgba(226, 232, 240, 0.95)',
                              color: '#2563eb',
                              textDecoration: 'none',
                              fontSize: 11,
                              lineHeight: 1.4,
                              wordBreak: 'break-word',
                            }}
                          >
                            {link.label}
                          </a>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {(expandedCard?.canOpenDiff && onOpenDiff) || (fileDetails.length > 0 && onOpenFile) ? (
                    <div style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 8,
                      justifyContent: 'flex-start',
                      marginBottom: (expandedCard?.details ?? []).length > 0 ? 10 : 0,
                    }}>
                      {expandedCard?.canOpenDiff && onOpenDiff ? (
                        <button
                          type="button"
                          onClick={onOpenDiff}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '7px 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(37, 99, 235, 0.14)',
                            background: 'rgba(37, 99, 235, 0.06)',
                            color: '#2563eb',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                            transition: 'transform 160ms ease, box-shadow 160ms ease',
                          }}
                        >
                          <SlidersHorizontal size={12} strokeWidth={2} />
                          Open diff sheet
                        </button>
                      ) : null}
                      {fileDetails.length > 0 && onOpenFile ? (
                        <button
                          type="button"
                          onClick={() => onOpenFile(fileDetails[0], currentWorkspace)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '7px 10px',
                            borderRadius: 10,
                            border: '1px solid rgba(16, 185, 129, 0.16)',
                            background: 'rgba(16, 185, 129, 0.08)',
                            color: '#047857',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          <FolderOpen size={12} strokeWidth={2} />
                          Open file
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {(expandedCard?.details ?? []).length > 0 ? (
                    <div style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}>
                      {(expandedCard?.details ?? []).map((detail) => {
                        const isFile = looksLikeWorkspaceFile(detail);
                        if (isFile && onOpenFile) {
                          return (
                            <button
                              key={detail}
                              type="button"
                              onClick={() => onOpenFile(detail, currentWorkspace)}
                              style={{
                                display: 'block',
                                width: '100%',
                                padding: '7px 8px',
                                borderRadius: 9,
                                border: '1px solid rgba(226, 232, 240, 0.95)',
                                background: 'rgba(248,250,252,0.78)',
                                textAlign: 'left',
                                cursor: 'pointer',
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 11,
                                  color: '#2563eb',
                                  lineHeight: 1.45,
                                  wordBreak: 'break-word',
                                  fontFamily: '"SF Mono", ui-monospace, monospace',
                                }}
                              >
                                {detail}
                              </div>
                            </button>
                          );
                        }
                        return (
                          <div
                          key={detail}
                          style={{
                            fontSize: 11,
                            color: '#475569',
                            lineHeight: 1.45,
                            wordBreak: 'break-word',
                            fontFamily: detail.includes('/') ? '"SF Mono", ui-monospace, monospace' : 'inherit',
                          }}
                        >
                          {detail}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#64748b' }}>No additional detail available.</div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        paddingLeft: showGroupLabel ? 10 : 0,
        marginLeft: showGroupLabel ? 4 : 0,
        borderLeft: showGroupLabel ? '2px solid rgba(37, 99, 235, 0.10)' : 'none',
      }}>
        {group.entries.map((entry) => {
          const entryIndex = transcript.findIndex((candidate) => candidate.id === entry.id);
          const isNew = getIsNewEntry(entry.id);
          return (
            <Bubble
              key={entry.id}
              entry={entry}
              previousEntry={entryIndex > 0 ? transcript[entryIndex - 1] : null}
              agentName={currentAgentName}
              isNew={isNew}
              onOpenMermaid={onOpenMermaid}
              onRunInTerminal={onRunInTerminal}
            />
          );
        })}
      </div>
    </div>
  );
});

const ActiveTurnCard = memo(function ActiveTurnCard({
  agentName,
  text,
  activityHeadline,
  liveToolCalls,
  onOpenMermaid,
  onRunInTerminal,
}: {
  agentName: string;
  text: string;
  activityHeadline?: string;
  liveToolCalls: MobileTranscriptToolCall[];
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const mdBlocks = useMemo(
    () => text.trim() ? renderMarkdownBlocks(text, onOpenMermaid, onRunInTerminal) : [],
    [text, onOpenMermaid, onRunInTerminal],
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      maxWidth: '92%',
      padding: '12px 14px',
      borderRadius: 18,
      background: 'linear-gradient(180deg, rgba(255,255,255,0.88), rgba(248,250,252,0.82))',
      border: '1px solid rgba(37, 99, 235, 0.10)',
      boxShadow: '0 16px 34px rgba(15, 23, 42, 0.06)',
      animation: 'sidebarActiveTurnIn 220ms ease-out',
      transition: 'box-shadow 180ms ease, border-color 180ms ease, transform 180ms ease',
    }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 8,
      }}>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 9px',
          borderRadius: 999,
          background: 'rgba(37, 99, 235, 0.08)',
          color: '#2563eb',
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {agentName}
          <span style={{ color: 'rgba(37, 99, 235, 0.45)' }}>•</span>
          active turn
        </span>
        {activityHeadline ? (
          <span style={{
            fontSize: 11,
            color: '#475569',
            fontWeight: 600,
            lineHeight: 1.4,
          }}>
            {activityHeadline}
          </span>
        ) : null}
      </div>

      {liveToolCalls.length > 0 ? (
        <DesktopToolCallStack toolCalls={liveToolCalls} />
      ) : null}

      {mdBlocks.length > 0 ? (
        <div className="remodex-rich-text">
          {mdBlocks.map((block, index) => (
            <div key={`active-${index}`}>
              {block.element}
            </div>
          ))}
          <span style={{
            display: 'inline-block',
            width: 6,
            height: 14,
            background: 'var(--t-text)',
            opacity: 0.35,
            marginLeft: 2,
            animation: 'blink 1s step-end infinite',
            verticalAlign: 'text-bottom',
          }} />
        </div>
      ) : (
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--t-text-secondary)',
          fontSize: 12,
          fontWeight: 500,
        }}>
          <span className="remodex-typing-dot" style={{ animationDelay: '0ms' }} />
          <span className="remodex-typing-dot" style={{ animationDelay: '150ms' }} />
          <span className="remodex-typing-dot" style={{ animationDelay: '300ms' }} />
          <span>{agentName} is thinking…</span>
        </div>
      )}
    </div>
  );
});

const SidebarApprovalCard = memo(function SidebarApprovalCard({
  approvals,
  resolvingId,
  onResolve,
}: {
  approvals: SidebarApproval[];
  resolvingId: string | null;
  onResolve: (id: string, action: 'approve' | 'reject') => void;
}) {
  if (approvals.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      padding: '10px 14px 12px',
      marginTop: 8,
      marginRight: 14,
      marginBottom: 10,
      marginLeft: 14,
      borderRadius: 18,
      background: 'linear-gradient(180deg, rgba(255,255,255,0.92), rgba(248,250,252,0.88))',
      border: '1px solid rgba(37, 99, 235, 0.10)',
      boxShadow: '0 16px 34px rgba(15, 23, 42, 0.08)',
      animation: 'sidebarApprovalIn 220ms ease-out',
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
          width: 28,
          height: 28,
          borderRadius: 10,
          background: 'rgba(37, 99, 235, 0.10)',
          color: '#2563eb',
          flexShrink: 0,
        }}>
          <Sparkles size={15} strokeWidth={2.2} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 800,
            color: '#0f172a',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Approval Required
          </div>
          <div style={{
            marginTop: 2,
            fontSize: 11,
            color: '#64748b',
            lineHeight: 1.4,
          }}>
            Review pending command or file actions for this session before the run continues.
          </div>
        </div>
        <span style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 22,
          height: 22,
          padding: '0 7px',
          borderRadius: 999,
          background: 'rgba(239, 68, 68, 0.12)',
          color: '#dc2626',
          fontSize: 11,
          fontWeight: 800,
        }}>
          {approvals.length}
        </span>
      </div>

      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}>
        {approvals.map((approval) => {
          const riskTone = approval.risk === 'high'
            ? { bg: 'rgba(239, 68, 68, 0.10)', fg: '#dc2626', border: 'rgba(239, 68, 68, 0.16)' }
            : approval.risk === 'medium'
              ? { bg: 'rgba(245, 158, 11, 0.10)', fg: '#b45309', border: 'rgba(245, 158, 11, 0.16)' }
              : { bg: 'rgba(37, 99, 235, 0.10)', fg: '#2563eb', border: 'rgba(37, 99, 235, 0.14)' };

          return (
            <div
              key={approval.id}
              style={{
                padding: '12px 12px 10px',
                borderRadius: 14,
                background: 'rgba(255,255,255,0.9)',
                border: `1px solid ${riskTone.border}`,
                boxShadow: '0 10px 20px rgba(15, 23, 42, 0.04)',
              }}
            >
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}>
                <span style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: '#0f172a',
                  flex: 1,
                  letterSpacing: '-0.01em',
                }}>
                  {approval.agent} • {approval.title}
                </span>
                <span style={{
                  fontSize: 10,
                  color: '#94a3b8',
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                }}>
                  {relativeTimeLabel(approval.createdAt)}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '3px 8px',
                  borderRadius: 999,
                  background: riskTone.bg,
                  color: riskTone.fg,
                  fontSize: 10,
                  fontWeight: 800,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  {approval.risk}
                </span>
              </div>

              <div style={{
                fontSize: 12,
                color: '#475569',
                lineHeight: 1.55,
                marginBottom: approval.command ? 8 : 10,
              }}>
                {approval.description}
              </div>

              {approval.command ? (
                <div style={{
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: 'rgba(15, 23, 42, 0.96)',
                  color: '#e2e8f0',
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  fontSize: 11,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginBottom: 10,
                }}>
                  $ {approval.command}
                </div>
              ) : null}

              <div style={{
                display: 'flex',
                gap: 8,
              }}>
                <button
                  type="button"
                  onClick={() => onResolve(approval.id, 'approve')}
                  disabled={resolvingId === approval.id}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 10,
                    border: 'none',
                    background: '#16a34a',
                    color: '#ffffff',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                  opacity: resolvingId === approval.id ? 0.55 : 1,
                  transition: 'transform 160ms ease, box-shadow 160ms ease',
                  boxShadow: '0 10px 18px rgba(22, 163, 74, 0.18)',
                }}
                onMouseEnter={(e) => {
                  if (resolvingId === approval.id) return;
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 14px 22px rgba(22, 163, 74, 0.24)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 10px 18px rgba(22, 163, 74, 0.18)';
                }}
                >
                  {resolvingId === approval.id ? 'Working…' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={() => onResolve(approval.id, 'reject')}
                  disabled={resolvingId === approval.id}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 10,
                    border: '1px solid rgba(239, 68, 68, 0.18)',
                    background: 'rgba(239, 68, 68, 0.06)',
                    color: '#dc2626',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                    opacity: resolvingId === approval.id ? 0.55 : 1,
                    transition: 'transform 160ms ease, background 160ms ease',
                  }}
                  onMouseEnter={(e) => {
                    if (resolvingId === approval.id) return;
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.10)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.06)';
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── Thinking X-ray ──
// Replaces the static status pill with a live window into agent reasoning.
// Tap to expand/collapse the thought stream overlay.

const ThinkingXray = memo(function ThinkingXray({
  model,
  agentRunning,
  streamingText,
}: {
  model: string;
  agentRunning: boolean;
  streamingText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);
  const wordCount = useMemo(
    () => streamingText ? streamingText.split(/\s+/).filter(Boolean).length : 0,
    [streamingText],
  );

  // Auto-scroll thought stream
  useEffect(() => {
    if (expanded && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [expanded, streamingText]);

  const isThinking = agentRunning && !streamingText;
  const isStreaming = agentRunning && !!streamingText;

  return (
    <div style={{ position: 'relative' }}>
      <div className="remodex-compose-status-bar" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* Model pill */}
        <span className="remodex-compose-chip remodex-compose-pill">
          {model}
        </span>

        {/* Thinking X-ray pill */}
        <button
          type="button"
          onClick={() => {
            if (isThinking || isStreaming) setExpanded(v => !v);
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '3px 10px', borderRadius: 10,
            border: isThinking || isStreaming
              ? '1px solid rgba(147, 197, 253, 0.3)'
              : '1px solid var(--t-divider)',
            background: isThinking || isStreaming
              ? expanded
                ? 'rgba(59, 130, 246, 0.12)'
                : 'rgba(147, 197, 253, 0.08)'
              : 'var(--t-hover)',
            cursor: (isThinking || isStreaming) ? 'pointer' : 'default',
            fontSize: 11, fontWeight: 600,
            fontFamily: '-apple-system, system-ui, sans-serif',
            color: isThinking || isStreaming ? '#3b82f6' : 'var(--t-text-muted)',
            transition: 'all 200ms ease',
            letterSpacing: '-0.01em',
          }}
        >
          {/* Brain icon with pulse animation when thinking */}
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{
              animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none',
              opacity: isThinking || isStreaming ? 1 : 0.5,
            }}
          >
            <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
            <path d="M9 21h6" />
          </svg>

          {isThinking ? (
            <span>Thinking…</span>
          ) : isStreaming ? (
            <span>{wordCount} words</span>
          ) : (
            <span>Idle</span>
          )}

          {/* Expand indicator */}
          {(isThinking || isStreaming) && (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" style={{
                transition: 'transform 200ms ease',
                transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
                opacity: 0.5,
              }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          )}
        </button>
      </div>

      {/* Expanded thought stream overlay */}
      {expanded && (isThinking || isStreaming) && (
        <div style={{
          position: 'absolute',
          bottom: '100%',
          left: 0, right: 0,
          marginBottom: 4,
          borderRadius: 12,
          background: 'rgba(15, 23, 42, 0.92)',
          backdropFilter: 'blur(24px) saturate(1.6)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.6)',
          border: '1px solid rgba(59, 130, 246, 0.2)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 0 0 1px rgba(59, 130, 246, 0.1)',
          maxHeight: 200,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          zIndex: 50,
        }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            flexShrink: 0,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#60a5fa"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: isThinking ? 'pulse 1.5s ease-in-out infinite' : 'none' }}>
              <path d="M12 2a7 7 0 0 0-7 7c0 2.38 1.19 4.47 3 5.74V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.26c1.81-1.27 3-3.36 3-5.74a7 7 0 0 0-7-7z" />
              <path d="M9 21h6" />
            </svg>
            <span style={{
              fontSize: 10, fontWeight: 700, color: '#60a5fa',
              letterSpacing: '0.03em', textTransform: 'uppercase',
            }}>
              Chain of Thought
            </span>
            {isStreaming && (
              <span style={{
                fontSize: 9, color: '#94a3b8', marginLeft: 'auto',
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}>
                {wordCount} words
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              style={{
                marginLeft: isStreaming ? 0 : 'auto',
                width: 18, height: 18, borderRadius: 5,
                border: 'none', background: 'rgba(255,255,255,0.06)',
                color: '#64748b', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10,
              }}
            >
              ✕
            </button>
          </div>

          {/* Stream content */}
          <div
            ref={streamRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '10px 12px',
              fontSize: 11,
              lineHeight: 1.6,
              color: '#cbd5e1',
              fontFamily: '"SF Mono", ui-monospace, monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {isThinking && !streamingText && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b' }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%',
                  border: '2px solid rgba(96, 165, 250, 0.3)',
                  borderTopColor: '#60a5fa',
                  animation: 'spin 1s linear infinite',
                }} />
                Reasoning in progress…
              </div>
            )}
            {streamingText || ''}
          </div>
        </div>
      )}
    </div>
  );
});

export const DesktopComposePane = memo(function DesktopComposePane({
  pendingFiles,
  removePendingFile,
  selectedSession,
  modelOverride,
  branchOverride,
  statusOverride,
  contextPercentOverride,
  allowAttachments = true,
  composeRef,
  draft,
  setDraft,
  showSlashSuggestions,
  slashSuggestions,
  composeHeight,
  currentAgentName,
  send,
  fileInputRef,
  enhancing,
  enhance,
  agentRunning,
  streamingText,
  sending,
  stopping,
  stopRun,
  chatSendDisabled,
  canInterruptSelected,
}: {
  pendingFiles: { name: string; mimeType: string; content: string; preview?: string }[];
  removePendingFile: (idx: number) => void;
  selectedSession: SessionSummary | undefined;
  modelOverride?: string;
  branchOverride?: string;
  statusOverride?: string;
  contextPercentOverride?: number;
  allowAttachments?: boolean;
  composeRef: React.RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  showSlashSuggestions: boolean;
  slashSuggestions: ReturnType<typeof getSlashCommandSuggestions>;
  composeHeight: number;
  currentAgentName: string;
  send: () => Promise<void>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  enhancing: boolean;
  enhance: () => Promise<void>;
  agentRunning: boolean;
  streamingText: string;
  sending: boolean;
  stopping: boolean;
  stopRun: () => Promise<void>;
  chatSendDisabled: boolean;
  canInterruptSelected: boolean;
}) {
  return (
    <div style={{
      padding: '10px 14px 14px',
      flexShrink: 0,
    }}>
      {pendingFiles.length > 0 && (
        <div style={{
          display: 'flex',
          gap: 8,
          paddingTop: 8,
          paddingBottom: 8,
          overflowX: 'auto',
        }}>
          {pendingFiles.map((f, idx) => (
            <div key={idx} style={{
              position: 'relative',
              flexShrink: 0,
              borderRadius: 10,
              overflow: 'hidden',
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
            }}>
              {f.preview ? (
                <img src={f.preview} alt={f.name} style={{
                  width: 64,
                  height: 64,
                  objectFit: 'cover',
                  display: 'block',
                }} />
              ) : (
                <div style={{
                  width: 64,
                  height: 64,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  color: 'var(--t-text-secondary)',
                  textAlign: 'center',
                  padding: 4,
                  wordBreak: 'break-all',
                }}>
                  {f.name.slice(0, 12)}
                </div>
              )}
              <button
                type="button"
                onClick={() => removePendingFile(idx)}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'rgba(0,0,0,0.5)',
                  color: '#fff',
                  fontSize: 11,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingTop: 0,
                  paddingRight: 0,
                  paddingBottom: 0,
                  paddingLeft: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="remodex-compose-surface">
        <ThinkingXray
          model={modelOverride ?? sessionDisplayModel(selectedSession)}
          agentRunning={agentRunning}
          streamingText={streamingText}
        />

        <textarea
          ref={composeRef}
          className="remodex-compose-input"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Tab' && showSlashSuggestions) {
              e.preventDefault();
              const nextValue = autocompleteSlashCommand(draft);
              if (nextValue) {
                setDraft(`${nextValue} `);
              }
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${currentAgentName}…`}
          style={{
            height: composeHeight,
            minHeight: 60,
            maxHeight: 400,
            resize: 'none',
            transition: 'none',
          }}
        />
        {showSlashSuggestions ? (
          <div style={{
            marginTop: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: 10,
            borderRadius: 14,
            border: '1px solid rgba(37, 99, 235, 0.12)',
            background: 'rgba(255,255,255,0.86)',
          }}>
            {slashSuggestions.slice(0, 6).map((item) => (
              <button
                key={item.command}
                type="button"
                onClick={() => {
                  setDraft(`${item.command} `);
                  composeRef.current?.focus();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  width: '100%',
                  minHeight: 36,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'rgba(37, 99, 235, 0.04)',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: '-apple-system, system-ui, sans-serif',
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
                  {item.command}
                </span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>{item.description}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="remodex-compose-row">
          {allowAttachments ? (
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Attach"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
          ) : null}
          {draft.trim().length >= 3 ? (
            <button
              type="button"
              className="remodex-compose-chip remodex-compose-chip-icon"
              aria-label="Enhance prompt"
              disabled={enhancing}
              onClick={() => void enhance()}
              style={{ color: enhancing ? '#d1d5db' : '#ff9f0a' }}
            >
              <Sparkles size={18} strokeWidth={2} className={enhancing ? 'spin' : undefined} />
            </button>
          ) : null}
          {(agentRunning || canInterruptSelected) && !draft.trim() ? (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stopRun()}
              aria-label="Stop agent run"
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.32rem',
                minWidth: 42,
                minHeight: 42,
                padding: '0 0.82rem',
                borderRadius: 999,
                border: '2px solid #ef4444',
                background: stopping ? '#fef2f2' : 'rgba(239, 68, 68, 0.06)',
                color: '#ef4444',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: stopping ? 'default' : 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              {stopping ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <>
                  <Square size={14} strokeWidth={2.5} fill="#ef4444" />
                  <span>Stop</span>
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              disabled={chatSendDisabled}
              onClick={() => void send()}
              aria-label={`Send message to ${currentAgentName}`}
              style={{
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.32rem',
                minWidth: 42,
                minHeight: 42,
                padding: '0 0.82rem',
                borderRadius: 999,
                border: 'none',
                background: chatSendDisabled ? 'var(--t-text-faint)' : '#ef4444',
                color: chatSendDisabled ? 'var(--t-text-muted)' : '#ffffff',
                fontSize: '0.84rem',
                fontWeight: 700,
                boxShadow: chatSendDisabled ? 'none' : '0 4px 14px rgba(239, 68, 68, 0.4)',
                cursor: chatSendDisabled ? 'default' : 'pointer',
              }}
            >
              {sending ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <>
                  <ArrowUp size={17} strokeWidth={2.2} />
                  <span>Send</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        marginTop: 6,
        background: 'var(--t-chrome)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.4)',
        borderRadius: 999,
        border: '1px solid var(--t-divider-subtle)',
      }}>
        {(() => {
          const rawPct = contextPercentOverride ?? ((selectedSession as unknown as Record<string, unknown>)?.context
            ? ((selectedSession as unknown as Record<string, unknown>).context as { usedPercent?: number })?.usedPercent
            : undefined);
          const pct = typeof rawPct === 'number' ? Math.round(rawPct) : null;
          const branchLabel = branchOverride ?? selectedSession?.branch;
          const statusLabel = statusOverride ?? selectedSession?.status;

          return (
            <>
              {pct !== null ? (
                <>
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: pct >= 70 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#34c759',
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 12,
                    color: 'var(--t-text-secondary)',
                    fontWeight: 500,
                  }}>
                    {pct}% context
                  </span>
                </>
              ) : null}
              {branchLabel ? (
                <>
                  {pct !== null ? <span style={{ color: 'var(--t-divider)' }}>·</span> : null}
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {branchLabel}
                  </span>
                </>
              ) : null}
              {statusLabel ? (
                <>
                  {(pct !== null || branchLabel) ? <span style={{ color: 'var(--t-divider)' }}>·</span> : null}
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {statusLabel}
                  </span>
                </>
              ) : null}
            </>
          );
        })()}
      </div>
    </div>
  );
});


// ── Main Component ──

export function AgentPanelChat({
  externalSessionKey,
  draftInjection,
  onOpenDiff,
  onOpenFile,
  onOpenMermaid,
  onRunInTerminal,
  onWsStatusChange,
}: {
  externalSessionKey?: string;
  draftInjection?: { id: string; text: string } | null;
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  onWsStatusChange?: (status: 'connected' | 'connecting' | 'reconnecting' | 'disconnected') => void;
} = {}) {
  const [snapshot, setSnapshot] = useState<MobileInboxSnapshot | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>('');
  const [transcript, setTranscript] = useState<MobileTranscriptEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [composeHeight, setComposeHeight] = useState(60);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffStats, setDiffStats] = useState({ additions: 0, deletions: 0, files: 0 });
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<{ name: string; mimeType: string; content: string; preview?: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [activeToolCalls, setActiveToolCalls] = useState<MobileTranscriptToolCall[]>([]);
  const [approvals, setApprovals] = useState<SidebarApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [openClawBetaEnabled, setOpenClawBetaEnabled] = useState(() => readOpenClawBetaEnabled());
  // wsConnected is derived from the WS hook below

  const scrollRef = useRef<HTMLDivElement>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const claudeSessionIdRef = useRef<string | undefined>(undefined);
  const codexThreadIdRef = useRef<string | undefined>(undefined);
  const selectedKeyRef = useRef('');
  const transcriptRequestRef = useRef(0);
  const liveToolCallsRef = useRef<MobileTranscriptToolCall[]>([]);
  const approvalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedSession = useMemo(
    () => sessions.find(s => s.sessionKey === selectedKey),
    [sessions, selectedKey]
  );

  useEffect(() => {
    if (selectedSession || sessions.length === 0) return;
    const primary = sessions.find((session) => session.sessionKey === snapshot?.primarySessionKey) ?? sessions[0];
    if (primary && primary.sessionKey !== selectedKey) {
      setSelectedKey(primary.sessionKey);
    }
  }, [selectedKey, selectedSession, sessions, snapshot?.primarySessionKey]);

  const streamingTextRef = useRef('');

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => subscribeOpenClawBetaEnabled(setOpenClawBetaEnabled), []);

  // ── WebSocket — real-time updates ──
  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onChatDelta: (text: string) => {
      streamingTextRef.current = text;
      setStreamingText(text);
      // Auto-scroll on streaming
      if (stickToBottomRef.current && scrollRef.current) {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
        });
      }
    },
    onChatDone: (text: string) => {
      streamingTextRef.current = '';
      setStreamingText('');
      setSending(false);
      const settled = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
      liveToolCallsRef.current = settled;
      setActiveToolCalls(settled);
      // Inject final message — poll and history push will reconcile
      if (text) {
        setTranscript(prev => {
          // Dedup: check if this text already exists (from WS history push or prior done)
          const lastFew = prev.slice(-3);
          if (lastFew.some(e => e.role === 'assistant' && e.text === text)) return prev;
          return [...prev, {
            id: `ws:done:${Date.now()}`,
            role: 'assistant' as const,
            text,
            timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
          }];
        });
      }
    },
    onChatError: () => {
      streamingTextRef.current = '';
      setStreamingText('');
      setSending(false);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
    },
    onInboxUpdate: (data: Record<string, unknown>) => {
      const inbox = data as unknown as MobileInboxSnapshot;
      if (inbox?.sessions) {
        setSnapshot(inbox);
        setSessions(inbox.sessions);
      }
    },
    onHistoryUpdate: (sessionKey: string, entries: Array<Record<string, unknown>>, replace = false) => {
      if (sessionKey === selectedKey) {
        const newEntries = dedupeTranscriptEntries(entries as unknown as MobileTranscriptEntry[]);
        setTranscript(prev => {
          const normalizedPrev = dedupeTranscriptEntries(prev);
          const existingIds = new Set(normalizedPrev.map(e => e.id));
          // Also dedup by text against ws:done entries
          const existingTexts = new Set(normalizedPrev.filter(e => e.id.startsWith('ws:')).map(e => e.text));
          if (replace) {
            const serverTexts = new Set(newEntries.map((entry) => entry.text));
            const pendingClientEntries = normalizedPrev.filter((entry) =>
              (entry.id.startsWith('local-') || entry.id.startsWith('ws:'))
              && !serverTexts.has(entry.text)
            );
            return dedupeTranscriptEntries([...newEntries, ...pendingClientEntries]);
          }
          const genuinelyNew = newEntries.filter(e =>
            !existingIds.has(e.id) && !(e.role === 'assistant' && existingTexts.has(e.text))
          );
          if (genuinelyNew.length === 0) return normalizedPrev;
          // Replace ws:done entries with server versions (better IDs)
          const cleaned = normalizedPrev.filter(p =>
            !p.id.startsWith('ws:') || !genuinelyNew.some(n => n.role === 'assistant' && n.text === p.text)
          );
          return mergeTranscriptEntries(cleaned, genuinelyNew);
        });
      }
    },
    onReviewUpdate: (data: Record<string, unknown>) => {
      if ((data.event as string | undefined) !== 'diff-stats') return;
      const d = data as { additions?: number; deletions?: number; files?: number };
      if (typeof d.additions === 'number') {
        setDiffStats({ additions: d.additions, deletions: d.deletions ?? 0, files: d.files ?? 0 });
      }
    },
  }), [selectedKey]);

  const {
    isConnected: wsConnected,
    connectionState,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalDetach,
  } = useSharedDesktopWs(selectedKey || undefined, wsCallbacks);

  // Report WS status to parent
  useEffect(() => { onWsStatusChange?.(connectionState); }, [connectionState, onWsStatusChange]);

  const isClaudeCode = selectedSession?.runtime === 'claude-code';
  const isCodexLocal = selectedSession?.runtime === 'codex' && selectedSession?.runtimeSurface?.ownership === 'discovered';
  const supportsSlashTerminalRelay = Boolean(
    selectedSession?.tmuxSession && (selectedSession?.runtime === 'codex' || selectedSession?.runtime === 'claude-code'),
  );
  const slashSuggestions = useMemo(() => getSlashCommandSuggestions(draft), [draft]);
  const showSlashSuggestions = isSlashCommandText(draft) && slashSuggestions.length > 0;

  useEffect(() => {
    if (!supportsSlashTerminalRelay || !selectedSession?.tmuxSession) return;
    sendTerminalAttach(selectedSession.tmuxSession, 120, 32);
    return () => {
      sendTerminalDetach(selectedSession.tmuxSession!);
    };
  }, [selectedSession?.tmuxSession, sendTerminalAttach, sendTerminalDetach, supportsSlashTerminalRelay]);

  const projectGroups = useMemo(
    () => snapshot ? buildProjectGroups(snapshot, selectedSession) : [],
    [snapshot, selectedSession]
  );

  // ── Derived header values ──
  const activeTitle = useMemo(() => {
    if (!selectedSession) {
      if (selectedKey.startsWith('claude-code:')) return 'Claude Code';
      if (selectedKey.startsWith('codex:')) return 'Codex';
      return 'Select session';
    }
    return compactLine(
      selectedSession.isCurrentSession ? 'Q ↔ Mister live' : selectedSession.name ?? selectedSession.currentTask,
      selectedSession.name ?? 'Current session',
      30,
    );
  }, [selectedKey, selectedSession]);

  const activeSubtitle = useMemo(() => {
    if (!selectedSession) {
      return selectedKey ? compactLine(selectedKey, 'session', 42) : '';
    }
    const raw = selectedSession as unknown as Record<string, unknown>;
    const surface = raw.runtimeSurface as { repoSlug?: string; branch?: string } | undefined;
    if (surface?.repoSlug) {
      return compactLine(`/${surface.repoSlug}/${surface.branch ?? 'main'}`, selectedSession.sessionKey, 42);
    }
    return compactLine(selectedSession.sessionKey, 'session', 42);
  }, [selectedKey, selectedSession]);

  const headerLabel = useMemo(() => {
    if (!selectedSession) {
      if (selectedKey.startsWith('claude-code:')) return 'Claude Code';
      if (selectedKey.startsWith('codex:')) return 'Codex';
      return 'Session';
    }
    if (selectedSession.runtime === 'claude-code') return 'Claude Code';
    if (selectedSession.runtime === 'codex') return 'Codex';
    if (selectedSession.status === 'running') return 'Live';
    return 'Session';
  }, [selectedKey, selectedSession]);

  const isMainOpenClaw = selectedSession?.runtime === 'openclaw' && selectedSession?.sessionKey === 'agent:main:main';
  const connectionDotColor = isMainOpenClaw
    ? '#2563eb'
    : selectedSession?.status === 'running'
      ? '#34c759'
      : selectedSession?.status === 'reviewing'
        ? '#ff9f0a'
        : '#8e8e93';

  const currentAgentName = selectedSession ? getAgentName(selectedSession) : 'Assistant';
  const sidebarCapabilities = useMemo<SidebarRuntimeCapabilities>(
    () => deriveSidebarRuntimeCapabilities(selectedSession),
    [selectedSession],
  );
  const liveActivityHeadline = useMemo(() => {
    const headline = selectedSession?.activity?.headline?.trim();
    if (!headline) return undefined;
    if (headline.toLowerCase().startsWith('responded')) return undefined;
    return headline;
  }, [selectedSession?.activity?.headline]);
  const liveToolCalls = useMemo(() => {
    if (!sidebarCapabilities.supportsToolEvents) return [];
    if (activeToolCalls.length > 0) return activeToolCalls;

    const transcriptCalls = lastTurnToolCalls(transcript);
    if (agentRunning && transcriptCalls.length > 0) return transcriptCalls;

    const activityTool = activityToLiveToolCall(selectedSession?.activity);
    return activityTool ? [activityTool] : [];
  }, [activeToolCalls, agentRunning, selectedSession?.activity, sidebarCapabilities.supportsToolEvents, transcript]);

  const scrollToBottom = useCallback((force = false) => {
    if (!scrollRef.current) return;
    if (!force && !stickToBottomRef.current) return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, []);

  // ── Fetch sessions ──
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(appendOpenClawBetaQuery('/api/mobile/inbox', openClawBetaEnabled));
      if (!res.ok) return;
      const data = (await res.json()) as MobileInboxSnapshot;
      setSnapshot(prev => JSON.stringify(prev) === JSON.stringify(data) ? prev : data);
      setSessions(prev => JSON.stringify(prev) === JSON.stringify(data.sessions) ? prev : data.sessions);
      const selectedStillExists = data.sessions.some((session) => session.sessionKey === selectedKey);
      if ((!selectedKey || !selectedStillExists) && data.sessions.length > 0) {
        const primary = data.sessions.find(s => s.isCurrentSession) ?? data.sessions[0];
        setSelectedKey(primary.sessionKey);
      }
    } catch { /* silent */ }
  }, [openClawBetaEnabled, selectedKey]);

  // ── Fetch transcript ──
  const fetchTranscript = useCallback(async (key: string) => {
    if (!key) return;
    const requestId = ++transcriptRequestRef.current;
    try {
      // Route local runtimes to runtime-specific transcript APIs.
      const isCC = key.startsWith('claude-code:');
      const isCodex = key.startsWith('codex:') || key.startsWith('codex-live:');
      const url = isCC
        ? `/api/claude-code/transcript?sessionKey=${encodeURIComponent(key)}&limit=50`
        : isCodex
          ? `/api/codex/transcript?sessionKey=${encodeURIComponent(key)}&limit=50`
          : `/api/mobile/history?sessionKey=${encodeURIComponent(key)}&limit=50`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (selectedKeyRef.current !== key || transcriptRequestRef.current !== requestId) return;
      const serverEntries = dedupeTranscriptEntries((data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[]);

      // Append-only merge: never replace the full transcript (prevents old messages
      // from re-appearing after compaction). Only genuinely new entries get appended.
      let didChange = false;
      setTranscript(prev => {
        const normalizedPrev = dedupeTranscriptEntries(prev);
        const optimistic = normalizedPrev.filter(m => m.id.startsWith('local-'));
        let realPrev = normalizedPrev.filter(m => !m.id.startsWith('local-'));

        // First load — accept full transcript
        if (realPrev.length === 0) {
          const initial = optimistic.length > 0 ? [...serverEntries, ...optimistic] : serverEntries;
          didChange = initial.length > 0;
          return dedupeTranscriptEntries(initial);
        }

        // Find where our last known message sits in the server response
        const lastRealId = realPrev[realPrev.length - 1]?.id;
        const serverIdx = serverEntries.findIndex(e => e.id === lastRealId);

        let newFromServer: MobileTranscriptEntry[] = [];
        if (serverIdx >= 0) {
          // Found our last entry — only take entries after it
          newFromServer = serverEntries.slice(serverIdx + 1);
        } else {
          // Last entry not found (compaction happened) — only add entries
          // whose IDs we haven't seen (don't replace, don't reorder)
          const existingIds = new Set(realPrev.map(e => e.id));
          newFromServer = serverEntries.filter(e => !existingIds.has(e.id));
          // Only add entries that appear AFTER the last timestamp we know about
          // (prevents old messages from appearing at bottom)
          if (newFromServer.length > 0 && realPrev.length > 0) {
            const lastKnownIdx = Math.max(...realPrev.map(e => serverEntries.findIndex(se => se.id === e.id)).filter(i => i >= 0));
            if (lastKnownIdx >= 0) {
              newFromServer = newFromServer.filter(e => {
                const idx = serverEntries.indexOf(e);
                return idx > lastKnownIdx;
              });
            }
          }
        }

        // Clear confirmed optimistic + WS-injected messages that server now has
        const serverTexts = new Set(
          [...realPrev, ...newFromServer].filter(e => !e.id.startsWith('local-') && !e.id.startsWith('ws:')).map(e => e.text)
        );
        // WS-injected done messages get replaced by server versions
        const wsInjected = realPrev.filter(e => e.id.startsWith('ws:'));
        if (wsInjected.length > 0 && newFromServer.length > 0) {
          // Remove WS entries whose text matches a server entry
          const wsTexts = new Set(wsInjected.map(e => e.text));
          const serverHasWs = newFromServer.some(e => wsTexts.has(e.text));
          if (serverHasWs) {
            realPrev = realPrev.filter(e => !e.id.startsWith('ws:') || !serverTexts.has(e.text));
          }
        }
        const pendingOptimistic = optimistic.filter(m => !serverTexts.has(m.text));

        if (newFromServer.length === 0 && pendingOptimistic.length === optimistic.length) {
          return normalizedPrev; // nothing changed
        }

        didChange = newFromServer.length > 0;
        const merged = mergeTranscriptEntries(realPrev, newFromServer);
        return pendingOptimistic.length > 0
          ? dedupeTranscriptEntries([...merged, ...pendingOptimistic])
          : merged;
      });
      setLoading(false);
      // Only scroll if user is already at bottom — never force-yank upward
      if (didChange && stickToBottomRef.current) {
        scrollToBottom();
      }
    } catch {
      if (selectedKeyRef.current !== key || transcriptRequestRef.current !== requestId) return;
      setLoading(false);
    }
  }, [scrollToBottom]);

  // ── File handling ──
  const processFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const preview = file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined;
        setPendingFiles(prev => [...prev, {
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          content: base64,
          preview,
        }]);
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const removePendingFile = useCallback((idx: number) => {
    setPendingFiles(prev => {
      const f = prev[idx];
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  // ── Drag and drop ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  // ── Paste images from clipboard ──
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        processFiles(files);
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [processFiles]);

  // ── Send sound ──
  const playSendSound = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.06);
    } catch { /* silent — no audio context available */ }
  }, []);

  // ── Send message ──
  const sendToClaudeCode = useCallback(async (text: string) => {
    const session = sessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;

    // Create a streaming assistant entry
    const assistantId = `claude-${Date.now()}`;
    const assistantEntry: MobileTranscriptEntry = {
      id: assistantId,
      role: 'assistant',
      text: '',
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, assistantEntry]);
    setAgentRunning(true);
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);

    try {
      const res = await fetch('/api/claude-code/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          cwd,
          sessionId: claudeSessionIdRef.current,
        }),
      });

      if (!res.ok || !res.body) {
        setTranscript(prev => prev.map(e =>
          e.id === assistantId ? { ...e, text: `Error: ${res.statusText}` } : e
        ));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              sessionId?: string;
              exitCode?: number;
            };

            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              const nextTools = advanceToolStack(liveToolCallsRef.current, event.name);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated, toolCalls: nextTools } : e
              ));
            }

            if (event.type === 'done' || event.type === 'close') {
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setTranscript(prev => prev.map(e =>
                  e.id === assistantId ? { ...e, toolCalls: settledTools } : e
                ));
              }
              if (event.sessionId) {
                claudeSessionIdRef.current = event.sessionId;
              }
              // Use the final text if close provided it and we have nothing
              if (event.type === 'close' && event.text && !accumulated) {
                accumulated = event.text;
                setTranscript(prev => prev.map(e =>
                  e.id === assistantId ? { ...e, text: accumulated } : e
                ));
              }
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch (err) {
      setTranscript(prev => prev.map(e =>
        e.id === assistantId ? { ...e, text: `Error: ${err instanceof Error ? err.message : 'unknown'}` } : e
      ));
    } finally {
      setAgentRunning(false);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
    }
  }, [sessions, selectedKey, scrollToBottom]);

  const sendToCodex = useCallback(async (text: string) => {
    const session = sessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;

    const assistantId = `codex-${Date.now()}`;
    const assistantEntry: MobileTranscriptEntry = {
      id: assistantId,
      role: 'assistant',
      text: '',
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, assistantEntry]);
    setAgentRunning(true);
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);

    try {
      const res = await fetch('/api/codex/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          cwd,
          threadId: codexThreadIdRef.current,
        }),
      });

      if (!res.ok || !res.body) {
        setTranscript(prev => prev.map(e =>
          e.id === assistantId ? { ...e, text: `Error: ${res.statusText}` } : e
        ));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as {
              type: string;
              text?: string;
              name?: string;
              threadId?: string;
            };

            if (event.type === 'session' && event.threadId) {
              codexThreadIdRef.current = event.threadId;
            }

            if (event.type === 'delta' && event.text) {
              accumulated += event.text;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              const nextTools = advanceToolStack(liveToolCallsRef.current, event.name);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated, toolCalls: nextTools } : e
              ));
            }

            if ((event.type === 'done' || event.type === 'close') && event.threadId) {
              codexThreadIdRef.current = event.threadId;
            }

            if (event.type === 'done' || event.type === 'close') {
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setTranscript(prev => prev.map(e =>
                  e.id === assistantId ? { ...e, toolCalls: settledTools } : e
                ));
              }
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => prev.map(e =>
                e.id === assistantId ? { ...e, text: accumulated } : e
              ));
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setTranscript(prev => prev.map(e =>
        e.id === assistantId ? { ...e, text: `Error: ${err instanceof Error ? err.message : 'unknown'}` } : e
      ));
    } finally {
      setAgentRunning(false);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
    }
  }, [sessions, selectedKey, scrollToBottom]);

  const send = useCallback(async () => {
    if ((!draft.trim() && pendingFiles.length === 0) || !selectedKey || sending || !selectedSession?.runtimeSurface?.capabilities.sendInput) return;
    const text = draft.trim();
    const files = [...pendingFiles];
    const relaySlashToTerminal = Boolean(text && files.length === 0 && isSlashCommandText(text) && supportsSlashTerminalRelay && selectedSession?.tmuxSession);
    setDraft('');
    setPendingFiles([]);
    setSending(true);
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
    playSendSound();

    const optimisticText = files.length > 0
      ? `${text}${text ? '\n' : ''}📎 ${files.map(f => f.name).join(', ')}`
      : text;

    const optimistic: MobileTranscriptEntry = {
      id: `local-${Date.now()}`,
      role: 'user',
      text: optimisticText,
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setTranscript(prev => [...prev, optimistic]);
    scrollToBottom(true);

    try {
      if (relaySlashToTerminal && selectedSession?.tmuxSession) {
        sendTerminalAttach(selectedSession.tmuxSession, 120, 32);
        await new Promise((resolve) => setTimeout(resolve, 120));
        sendTerminalInput(selectedSession.tmuxSession, buildSlashTerminalInput(text));
        return;
      }

      // Route to local agent CLIs based on runtime
      if (isClaudeCode) {
        await sendToClaudeCode(text);
      } else if (isCodexLocal) {
        await sendToCodex(text);
      } else {
        const payload: Record<string, unknown> = {
          sessionKey: selectedKey,
          action: 'steer',
          message: text || (files.length > 0 ? `[${files.map(f => f.name).join(', ')}]` : ''),
        };
        if (files.length > 0) {
          payload.attachments = files.map(f => ({
            mimeType: f.mimeType,
            fileName: f.name,
            content: f.content,
          }));
        }
        // Fire and don't wait — optimistic UI already shows the message
        fetch('/api/mobile/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      }
    } catch { /* silent */ }
    finally {
      // Revoke any preview URLs
      files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); });
      setSending(false);
    }
  }, [draft, pendingFiles, selectedKey, sending, isClaudeCode, isCodexLocal, sendTerminalAttach, sendTerminalInput, supportsSlashTerminalRelay, selectedSession, sendToClaudeCode, sendToCodex, scrollToBottom, playSendSound]);

  // ── Stop / Abort run ──
  const stopRun = useCallback(async () => {
    if (!selectedKey || stopping) return;
    setStopping(true);
    try {
      await fetch('/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: selectedKey, action: 'stop' }),
      });
      // Single poll after stop — WS will push the rest
      setTimeout(() => void fetchTranscript(selectedKey), 1000);
    } catch { /* silent */ }
    finally {
      setStopping(false);
      setAgentRunning(false);
    }
  }, [selectedKey, stopping, fetchTranscript]);

  // ── Track agent running state ──
  // Agent is "running" after user sends until an assistant message arrives
  useEffect(() => {
    if (transcript.length === 0) { setAgentRunning(false); return; }
    const last = transcript[transcript.length - 1];
    // If last message is user (or local optimistic) → agent is generating
    if ((last.role === 'user' || last.id.startsWith('local-')) && !isSlashCommandText(last.text)) {
      setAgentRunning(true);
      // No auto-scroll — user controls position
    } else {
      setAgentRunning(false);
    }
  }, [transcript]);

  useEffect(() => {
    if (agentRunning || streamingText) return;
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
  }, [agentRunning, streamingText]);

  // ── Diff stats (WS-driven + safety-net) ──
  // WS pushes diff-stats on git changes; this poll is the safety-net
  useEffect(() => {
    async function fetchDiffStats() {
      try {
        const res = await fetch('/api/review/workspace');
        if (!res.ok) return;
        const data = await res.json();
        const files = data.changedFiles ?? [];
        setDiffStats({
          additions: files.reduce((s: number, f: { additions?: number }) => s + (f.additions ?? 0), 0),
          deletions: files.reduce((s: number, f: { deletions?: number }) => s + (f.deletions ?? 0), 0),
          files: files.length,
        });
      } catch { /* silent */ }
    }
    void fetchDiffStats();
    const ms = wsConnected ? 120_000 : 30_000; // 2min when WS connected, 30s fallback
    const id = setInterval(fetchDiffStats, ms);
    return () => clearInterval(id);
  }, [wsConnected]);

  // ── External session key (from Agent Panel click) ──
  useEffect(() => {
    if (externalSessionKey && externalSessionKey !== selectedKey) {
      setSelectedKey(externalSessionKey);
    }
  }, [externalSessionKey, selectedKey]);

  useEffect(() => {
    if (!draftInjection?.id) return;
    setDraft((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [draftInjection?.id, draftInjection?.text]);

  // ── Enhance draft ──
  const enhance = useCallback(async () => {
    if (!draft.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: draft }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setDraft(data.enhanced);
      }
    } catch { /* silent */ }
    finally { setEnhancing(false); }
  }, [draft, enhancing]);

  // ── Select session by session key (for session picker) ──
  const handleSessionFocus = useCallback((sessionKey: string) => {
    const session = sessions.find(s => s.sessionKey === sessionKey);
    if (session) {
      setSelectedKey(session.sessionKey);
    }
  }, [sessions]);

  useEffect(() => {
    const session = sessions.find(s => s.sessionKey === selectedKey);

    // Reset session refs when switching
    claudeSessionIdRef.current = undefined;
    codexThreadIdRef.current = undefined;

    if (!session) return;

    // Initialize refs from discovered session data so first send resumes correctly
    if (session.runtime === 'claude-code' && session.sessionKey.startsWith('claude-code:')) {
      claudeSessionIdRef.current = session.sessionKey.replace('claude-code:', '');
    }
    if (session.runtime === 'codex' && session.sessionKey.startsWith('codex:')) {
      codexThreadIdRef.current = session.sessionKey.replace('codex:', '');
    }
  }, [sessions, selectedKey]);

  // ── Init ──
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    if (selectedKey) {
      setLoading(true);
      setTranscript([]);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
      seenIdsRef.current.clear();
      void fetchTranscript(selectedKey);
    }
  }, [selectedKey, fetchTranscript]);

  // Safety-net poll: 30s when WS connected, 5s when disconnected
  useEffect(() => {
    if (!selectedKey) return;
    const ms = wsConnected ? 30_000 : 15_000;
    const interval = setInterval(() => void fetchTranscript(selectedKey), ms);
    return () => clearInterval(interval);
  }, [selectedKey, fetchTranscript, wsConnected]);

  useEffect(() => {
    const pollApprovals = async () => {
      try {
        const res = await fetch('/api/panel/approvals');
        if (!res.ok) return;
        const data = await res.json() as { approvals?: SidebarApproval[] };
        const nextApprovals = (data.approvals ?? []).filter((approval) => approval.sessionKey === selectedKey);
        setApprovals(nextApprovals);
      } catch {
        // silent
      }
    };

    if (!selectedKey) {
      setApprovals([]);
      return;
    }

    void pollApprovals();
    approvalPollRef.current = setInterval(pollApprovals, 12_000);
    return () => {
      if (approvalPollRef.current) clearInterval(approvalPollRef.current);
    };
  }, [selectedKey]);

  const handleApprovalResolve = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setResolvingApprovalId(id);
    try {
      const res = await fetch('/api/panel/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      if (res.ok) {
        setApprovals((prev) => prev.filter((approval) => approval.id !== id));
      }
    } catch {
      // silent
    } finally {
      setResolvingApprovalId(null);
    }
  }, []);

  // Reset expanded group when picker closes
  useEffect(() => {
    if (!pickerOpen) setExpandedGroup(null);
  }, [pickerOpen]);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen]);

  const [showScrollPill, setShowScrollPill] = useState(false);

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distFromBottom < 80;
    setShowScrollPill(distFromBottom > 200);
  }, []);

  // Auto-scroll disabled — user controls position via "new messages" button.
  // Only scroll on initial session load (handled by fetchTranscript).
  // useEffect(() => { scrollToBottom(); }, [transcript.length, scrollToBottom]);

  const getIsNewEntry = useCallback((entryId: string) => {
    const isNew = !seenIdsRef.current.has(entryId);
    if (isNew) {
      queueMicrotask(() => seenIdsRef.current.add(entryId));
    }
    return isNew;
  }, []);

  const canSendToSelected = Boolean(selectedSession?.runtimeSurface?.capabilities.sendInput);
  const canInterruptSelected = Boolean(selectedSession?.runtimeSurface?.capabilities.interrupt && selectedSession?.status === 'running');
  const chatSendDisabled = !selectedKey || sending || !draft.trim() || !canSendToSelected;
  const headerOverlayHeight = 86;
  const headerScrollbarGutter = 12;

  return (
    <div
      className="remodex-desktop-chat"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0, // critical for flex overflow scrolling
        background: 'var(--t-bg)',
        borderLeft: '1px solid var(--t-divider)',
        position: 'relative',
        outline: dragOver ? '2px solid #3b82f6' : 'none',
        outlineOffset: -2,
      ['--remodex-compose-active' as string]: '0',
      ['--remodex-dock-fade-progress' as string]: '0',
      ['--remodex-dock-motion-progress' as string]: '0',
    }}>
      {/* Drag overlay */}
      {dragOver && (
        <div style={{
          position: 'absolute',
          inset: 0,
          zIndex: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(59, 130, 246, 0.08)',
          backdropFilter: 'blur(4px)',
          pointerEvents: 'none',
        }}>
          <div style={{
            paddingTop: 16,
            paddingRight: 32,
            paddingBottom: 16,
            paddingLeft: 32,
            borderRadius: 16,
            background: 'var(--t-panel-translucent)',
            border: '2px dashed #3b82f6',
            fontSize: 15,
            fontWeight: 600,
            color: '#3b82f6',
          }}>
            Drop files here
          </div>
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.txt,.md,.json,.csv,.tsx,.ts,.js,.py"
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files) processFiles(e.target.files);
          e.target.value = '';
        }}
      />

      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: headerScrollbarGutter,
          zIndex: 20,
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <DesktopChatHeader
            pickerRef={pickerRef}
            pickerOpen={pickerOpen}
            setPickerOpen={setPickerOpen}
            projectGroups={projectGroups}
            selectedSession={selectedSession}
            activeTitle={activeTitle}
            headerLabel={headerLabel}
            activeSubtitle={activeSubtitle}
            connectionDotColor={connectionDotColor}
            handleSessionFocus={handleSessionFocus}
            expandedGroup={expandedGroup}
            setExpandedGroup={setExpandedGroup}
            diffStats={diffStats}
            onOpenDiff={onOpenDiff}
            setDiffOpen={setDiffOpen}
          />
        </div>
      </div>

      {!wsConnected && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '6px 12px',
          background: 'rgba(245, 158, 11, 0.06)',
          borderBottom: '1px solid rgba(245, 158, 11, 0.12)',
          fontSize: 11, color: '#d97706', fontWeight: 500,
          marginTop: headerOverlayHeight,
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#d97706', animation: 'reviewingBreathe 2s ease-in-out infinite' }} />
          Reconnecting to gateway…
        </div>
      )}

      <DesktopTranscriptPane
        loading={loading}
        transcript={transcript}
        currentAgentName={currentAgentName}
        onOpenMermaid={onOpenMermaid}
        onRunInTerminal={onRunInTerminal}
        streamingText={streamingText}
        agentRunning={agentRunning}
        activityHeadline={liveActivityHeadline}
        liveToolCalls={liveToolCalls}
        onOpenDiff={onOpenDiff ? onOpenDiff : () => setDiffOpen(true)}
        onOpenFile={onOpenFile}
        currentWorkspace={selectedSession?.workspace}
        runtimeCapabilities={sidebarCapabilities}
        approvals={approvals}
        resolvingApprovalId={resolvingApprovalId}
        onResolveApproval={handleApprovalResolve}
        scrollRef={scrollRef}
        handleScroll={handleScroll}
        showScrollPill={showScrollPill}
        scrollToBottom={scrollToBottom}
        getIsNewEntry={getIsNewEntry}
        topInset={wsConnected ? headerOverlayHeight + 8 : 12}
      />
      {/* ── Resize Handle ── */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startY = e.clientY;
          const startH = composeHeight;
          const onMove = (ev: MouseEvent) => {
            const delta = startY - ev.clientY;
            setComposeHeight(Math.min(Math.max(startH + delta, 60), 400));
          };
          const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        style={{
          height: 8,
          cursor: 'row-resize',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <div style={{
          width: 36,
          height: 4,
          borderRadius: 2,
          backgroundColor: 'var(--t-divider)',
          transition: 'background-color 150ms',
        }} />
      </div>

      <DesktopComposePane
        pendingFiles={pendingFiles}
        removePendingFile={removePendingFile}
        selectedSession={selectedSession}
        composeRef={composeRef}
        draft={draft}
        setDraft={setDraft}
        showSlashSuggestions={showSlashSuggestions}
        slashSuggestions={slashSuggestions}
        composeHeight={composeHeight}
        currentAgentName={currentAgentName}
        send={send}
        fileInputRef={fileInputRef}
        enhancing={enhancing}
        enhance={enhance}
        agentRunning={agentRunning}
        streamingText={streamingText}
        sending={sending}
        stopping={stopping}
        stopRun={stopRun}
        chatSendDisabled={chatSendDisabled}
        canInterruptSelected={canInterruptSelected}
      />
      {diffOpen ? <DiffModal onClose={() => setDiffOpen(false)} /> : null}
      <style>{`
        @keyframes sidebarActiveTurnIn {
          from { opacity: 0; transform: translateY(8px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes sidebarApprovalIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes sidebarSourceCardIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes sidebarSourceExpand {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes reviewingBreathe {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.25); opacity: 0.7; }
        }
        @keyframes reviewingRing {
          0% { transform: scale(1); opacity: 0.6; }
          100% { transform: scale(2.8); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
