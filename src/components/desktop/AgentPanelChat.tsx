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
import { AnimatePresence, motion } from 'framer-motion';
import { useSharedDesktopWs } from './hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from './hooks/useDesktopWebSocket';
import { ContextUsageRing } from '@/components/ContextUsageRing';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react';
import {
  PaperPlaneRight,
  Stop,
  SpinnerGap,
  PlusCircle,
  MagicWand,
  CaretDown,
} from '@phosphor-icons/react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptMedia,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import { CompactionNode } from '@/components/desktop/CompactionNode';
import type { ProjectGroup } from '@/components/mobile/types';
import { buildProjectGroups } from '@/components/mobile/utils';
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
import type { ApprovalRecord } from '@/lib/approvals/types';
import { formatModelLabel } from '@/lib/format';
import { ttsEngine } from '@/lib/tts/engine';
import { autocompleteSlashCommand, buildSlashTerminalInput, getSlashCommandSuggestions, isSlashCommandText } from '@/lib/slash-commands';
import {
  adHocLaneTitle,
  normalizeRuntimeStatusToOrchestratorStatus,
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';
import type { OrchestratorPacket, WorkspaceLaneState } from '@/lib/orchestrator/types';

const THEME_ACCENT = 'var(--t-accent, #2563eb)';
const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
const EMPTY_STATE_SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const;

// ── Performance: snapshot fingerprint (replaces JSON.stringify equality) ──
function snapshotFp(data: MobileInboxSnapshot | null): string {
  if (!data) return '';
  const sessions = data.sessions ?? [];
  return `${sessions.length}|${sessions.map((s) => `${s.sessionKey}:${s.status}`).join(',')}`;
}

function sessionsFp(sessions: SessionSummary[]): string {
  return `${sessions.length}|${sessions.map((s) => `${s.sessionKey}:${s.status}`).join(',')}`;
}

// ── Performance: targeted transcript entry update (replaces full .map() scan) ──
function updateTranscriptEntry(
  prev: MobileTranscriptEntry[],
  targetId: string,
  patch: Partial<MobileTranscriptEntry>,
): MobileTranscriptEntry[] {
  // Scan from the end — the entry being updated during SSE is always the last one
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i].id === targetId) {
      const updated = { ...prev[i], ...patch };
      const next = prev.slice();
      next[i] = updated;
      return next;
    }
  }
  return prev;
}

// ── Performance: hoisted static inline styles for .map() loops ──
const CHANGED_FILE_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-secondary)',
  fontFamily: '"SF Mono", ui-monospace, monospace',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as React.CSSProperties;

const OPERATOR_DETAIL_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-muted)',
  lineHeight: 1.45,
} as React.CSSProperties;

const TABLE_HEADER_CELL_STYLE = {
  textAlign: 'left' as const,
  padding: '10px 14px',
  fontSize: '0.8rem',
  fontWeight: 600,
  color: 'var(--t-text-secondary)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  borderBottom: '2px solid var(--t-divider)',
  whiteSpace: 'nowrap',
} as React.CSSProperties;

const TABLE_BODY_CELL_STYLE = {
  textAlign: 'left' as const,
  padding: '10px 14px',
  fontSize: '0.85rem',
  color: 'var(--t-text)',
  borderBottom: '1px solid var(--t-divider-subtle)',
} as React.CSSProperties;

const SOURCE_LINK_STYLE = {
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
} as React.CSSProperties;

const SOURCE_CARD_SUMMARY_STYLE = {
  fontSize: 11,
  color: 'var(--t-text-secondary)',
  fontWeight: 600,
  lineHeight: 1.35,
} as React.CSSProperties;

const O_PLACEHOLDERS = [
  'Orchestrate something...',
  'Operate on this repo...',
  'Outline the next step...',
  'Optimize this workflow...',
  'Observe the agent output...',
  'Order a new task...',
  'Organize the worktree...',
  'Orient the mission...',
];

// ── Types ──

type SessionSummary = MobileInboxSnapshot['sessions'][number];
type TranscriptGroup = {
  id: string;
  kind: 'user' | 'agent' | 'system';
  entries: MobileTranscriptEntry[];
};

type SessionPickerChipTone = 'blue' | 'green' | 'purple' | 'amber' | 'slate' | 'red';
type SessionPickerChip = {
  label: string;
  tone: SessionPickerChipTone;
};

// ── Helpers ──

function getAgentName(s: SessionSummary): string {
  if (s.orchestrationPacket?.title?.trim()) return s.orchestrationPacket.title.trim();
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
  if (session.runtime === 'chat') {
    return formatModelLabel(session.model ?? 'Workspace Chat');
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

function sessionRuntimeLabel(session: SessionSummary) {
  if (session.orchestrationPacket?.runtime) {
    return orchestratorRuntimeTone(session.orchestrationPacket.runtime).label;
  }
  if (session.runtime === 'claude-code') return 'Claude Code';
  if (session.runtime === 'codex') return 'Codex';
  if (session.runtime === 'chat') return 'Chat';
  return 'Session';
}

function sessionRepoLabel(session: SessionSummary) {
  const repoSlug = session.runtimeSurface?.reviewContext?.repoSlug?.split('/').pop()?.trim();
  if (repoSlug) return repoSlug;
  const cwd = session.runtimeSurface?.cwd?.trim() || session.workspace?.trim();
  if (!cwd) return null;
  const normalized = cwd.replace(/^~\//, '').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function cleanBranchLabel(branch?: string | null) {
  const trimmed = branch?.trim();
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed.replace(/^(feat|fix|batch|chore|refactor)\//, '');
}

function sessionLaneTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  if (session.orchestrationPacket?.title?.trim()) {
    return session.orchestrationPacket.title.trim();
  }
  if (session.runtime === 'chat' || session.runtime === 'codex' || session.runtime === 'claude-code') {
    return adHocLaneTitle('chat');
  }
  return adHocLaneTitle('terminal');
}

function sessionTaskLabel(session?: SessionSummary) {
  if (!session) return null;
  if (session.orchestrationPacket?.referenceLabel) {
    return session.orchestrationPacket.referenceLabel;
  }
  const candidates = [
    session.name,
    session.currentTask,
    session.activity?.headline,
  ]
    .map((value) => sanitizeTranscriptText(value ?? ''))
    .filter((value): value is string => Boolean(value.trim()));

  for (const candidate of candidates) {
    const issueMatch = candidate.match(/\bIssue #\d+\b/i);
    if (issueMatch) return issueMatch[0].replace(/^issue/i, 'Issue');
    const prMatch = candidate.match(/\bPR #\d+\b/i);
    if (prMatch) return prMatch[0].replace(/^pr/i, 'PR');
    if (/review/i.test(candidate)) return 'Review';
  }

  return null;
}

function sessionTaskSummary(session?: SessionSummary, max = 42) {
  if (!session) return null;
  const taskSummary = sanitizeTranscriptText(session.currentTask?.trim() ?? '');
  if (!taskSummary) return null;
  if (/^(hi|hey|hello|good (morning|afternoon|evening))\b/i.test(taskSummary)) return null;
  return compactLine(taskSummary, taskSummary, max);
}

function sessionStateChip(session?: SessionSummary): SessionPickerChip | null {
  if (!session) return null;
  const canonical = session.orchestrationPacket
    ? orchestratorStatusTone(session.orchestrationPacket.status)
    : orchestratorStatusTone(normalizeRuntimeStatusToOrchestratorStatus(session.status));
  const tone: SessionPickerChipTone = canonical.label === 'Running'
    ? 'green'
    : canonical.label === 'Review'
      ? 'purple'
      : canonical.label === 'Blocked'
        ? 'red'
        : canonical.label === 'Queued' || canonical.label === 'Launching'
          ? 'blue'
          : 'slate';
  return { label: canonical.label, tone };
}

function sessionPickerTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  return compactLine(sessionLaneTitle(session), sessionLaneTitle(session), 36);
}

function sessionHeaderTitle(session?: SessionSummary) {
  if (!session) return 'Choose a lane';
  return compactLine(sessionLaneTitle(session), sessionLaneTitle(session), 42);
}

function sessionPickerRowSubtitle(session: SessionSummary) {
  if (session.orchestrationPacket) {
    const repoLabel = sessionRepoLabel(session);
    const branchLabel = cleanBranchLabel(session.branch);
    const detail = [repoLabel, branchLabel, sessionRuntimeLabel(session)].filter((value): value is string => Boolean(value));
    return compactLine(detail.join(' · '), detail[0] ?? 'Workspace lane', 52);
  }
  const taskSummary = sessionTaskSummary(session, 40);
  const branchLabel = cleanBranchLabel(session.branch);
  if (taskSummary) {
    const combined = branchLabel ? `${taskSummary} · ${branchLabel}` : taskSummary;
    return compactLine(combined, taskSummary, 52);
  }
  const parts = [
    sessionTaskLabel(session),
    branchLabel,
  ].filter((value): value is string => Boolean(value));
  if (parts.length > 0) return compactLine(parts.join(' · '), parts[0], 52);
  return sessionLocalFolderLabel(session) ?? compactLine(sanitizeTranscriptText(session.currentTask ?? ''), 'Session ready', 52);
}

function sessionPickerChips(session?: SessionSummary): SessionPickerChip[] {
  if (!session) return [];
  const chips: SessionPickerChip[] = [];
  if (session.orchestrationPacket?.referenceLabel) {
    chips.push({ label: session.orchestrationPacket.referenceLabel, tone: 'blue' });
  }
  chips.push({
    label: sessionRuntimeLabel(session),
    tone: session.runtime === 'claude-code' ? 'purple' : session.runtime === 'codex' ? 'green' : 'slate',
  });
  const state = sessionStateChip(session);
  if (state) chips.push(state);
  return chips;
}

function buildPickerFallbackSnapshot(sessions: SessionSummary[], selectedKey: string): MobileInboxSnapshot | null {
  if (sessions.length === 0) return null;
  return {
    generatedAt: new Date().toISOString(),
    mode: 'live',
    sourceLabel: 'desktop-session-fallback',
    primarySessionKey: sessions.find((session) => session.sessionKey === selectedKey)?.sessionKey ?? sessions[0]?.sessionKey,
    sessions,
    approvals: [],
    items: [],
    summary: {
      alerts: 0,
      approvals: 0,
      reviewItems: 0,
      activeRuns: sessions.filter((session) => ['running', 'reviewing', 'blocked', 'waiting', 'failed'].includes(session.status)).length,
    },
  };
}

function composeFooterLeadLabel(session?: SessionSummary, statusOverride?: string) {
  const taskLabel = sessionTaskLabel(session);
  if (taskLabel && /\b(Issue #\d+|PR #\d+)\b/i.test(taskLabel)) return taskLabel;

  const rawStatus = (statusOverride ?? session?.status ?? '').trim().toLowerCase();
  if (rawStatus === 'waiting') return 'Waiting';
  if (rawStatus === 'blocked' || rawStatus === 'failed') return 'Blocked';
  return session ? sessionRuntimeLabel(session) : null;
}

type ChatStarterPrompt = {
  label: string;
  detail: string;
  text: string;
};

function compactChatScopeLabel(value?: string | null, max = 30) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const cleaned = trimmed
    .replace(/\.git$/i, '')
    .replace(/^~\//, '')
    .replace(/^\/Users\/[^/]+\//, '')
    .replace(/^\/home\/[^/]+\//, '')
    .trim();
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  const label = parts[parts.length - 1] ?? cleaned;
  return compactLine(label, cleaned, max);
}

function resolveChatScopeLabel(
  selectedSession: SessionSummary | undefined,
  selectedOrchestratorPacket: { title?: string | null; referenceLabel?: string | null } | null | undefined,
  selectedOrchestratorRepoPath: string | null | undefined,
  workspaceLane: { title?: string | null; repoPath?: string | null } | undefined,
) {
  return compactChatScopeLabel(
    workspaceLane?.title?.trim()
      || selectedOrchestratorPacket?.title?.trim()
      || selectedSession?.orchestrationPacket?.title?.trim()
      || selectedSession?.runtimeSurface?.reviewContext?.repoSlug?.trim()
      || selectedOrchestratorRepoPath?.trim()
      || workspaceLane?.repoPath?.trim()
      || selectedSession?.workspace?.trim()
      || selectedSession?.branch?.trim()
      || null,
  );
}

function buildChatStarterPrompts(
  scopeLabel: string | null,
  taskLabel: string | null,
  repoLabel: string | null,
  noLaneSelected: boolean,
): ChatStarterPrompt[] {
  const focusLabel = taskLabel ?? scopeLabel ?? 'the lane';
  const repoFocusLabel = repoLabel ?? scopeLabel ?? 'the current repo';
  return [
    {
      label: taskLabel ? `Summarize ${taskLabel}` : `Summarize ${focusLabel}`,
      detail: noLaneSelected
        ? 'Prefills the draft for the lane you pick next'
        : `Scoped to ${scopeLabel ?? repoFocusLabel}`,
      text: taskLabel
        ? `Summarize ${taskLabel} and call out the next step.`
        : `Summarize ${focusLabel} and call out the next step.`,
    },
    {
      label: 'Inspect the next file',
      detail: repoLabel ? `Start with ${repoLabel}` : 'Good for first-pass triage',
      text: repoLabel
        ? `Inspect the most relevant file in ${repoLabel} and explain why it matters.`
        : 'Inspect the most relevant file and explain why it matters.',
    },
    {
      label: 'Draft a concise update',
      detail: noLaneSelected
        ? 'Keeps a ready-to-send draft while you choose a lane'
        : 'Useful for status notes and handoffs',
      text: scopeLabel
        ? `Draft a concise update for ${scopeLabel}.`
        : 'Draft a concise update for the current work.',
    },
  ];
}

function ChatEmptyState({
  scopeLabel,
  title,
  body,
  primaryActionLabel,
  onPrimaryAction,
  prompts,
  onPromptSelect,
}: {
  scopeLabel: string | null;
  title: string;
  body: string;
  primaryActionLabel?: string;
  onPrimaryAction?: () => void;
  prompts: ChatStarterPrompt[];
  onPromptSelect: (prompt: ChatStarterPrompt) => void;
}) {
  const [primaryHover, setPrimaryHover] = useState(false);
  const [hoveredPrompt, setHoveredPrompt] = useState<string | null>(null);

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      paddingTop: 16,
      paddingRight: 18,
      paddingBottom: 18,
      paddingLeft: 18,
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        borderRadius: 14,
        border: '1px solid var(--t-divider-subtle)',
        background: 'linear-gradient(180deg, var(--t-panel-translucent) 0%, var(--t-bg-card, rgba(148, 163, 184, 0.08)) 100%)',
        boxShadow: 'var(--t-panel-shadow)',
        paddingTop: 18,
        paddingRight: 16,
        paddingBottom: 16,
        paddingLeft: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {scopeLabel ? (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              alignSelf: 'flex-start',
              minHeight: 20,
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              borderRadius: 10,
              background: 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))',
              border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              color: 'var(--t-accent, #2563eb)',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}>
              {scopeLabel}
            </span>
          ) : null}
          <div style={{
            fontSize: 18,
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: '-0.02em',
            color: 'var(--t-text)',
          }}>
            {title}
          </div>
          <div style={{
            fontSize: 13,
            lineHeight: 1.5,
            letterSpacing: '-0.01em',
            color: 'var(--t-text-muted)',
          }}>
            {body}
          </div>
        </div>

        <div
          aria-hidden="true"
          style={{
            borderRadius: 14,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-panel, rgba(255, 255, 255, 0.72))',
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 48,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
            }} />
            <div style={{
              width: 20,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
              opacity: 0.7,
            }} />
            <div style={{ flex: 1 }} />
            <div style={{
              width: 54,
              height: 10,
              borderRadius: 999,
              background: 'var(--t-divider-subtle)',
              opacity: 0.6,
            }} />
          </div>
          <div style={{
            width: '88%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.8,
          }} />
          <div style={{
            width: '72%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.72,
          }} />
          <div style={{
            width: '60%',
            height: 12,
            borderRadius: 999,
            background: 'linear-gradient(90deg, var(--t-divider-subtle) 0%, var(--t-divider) 100%)',
            opacity: 0.64,
          }} />
        </div>

        {primaryActionLabel && onPrimaryAction ? (
          <button
            type="button"
            onClick={onPrimaryAction}
            onMouseEnter={() => setPrimaryHover(true)}
            onMouseLeave={() => setPrimaryHover(false)}
            style={{
              minHeight: 44,
              paddingTop: 10,
              paddingRight: 14,
              paddingBottom: 10,
              paddingLeft: 14,
              borderRadius: 12,
              border: '1px solid var(--t-accent-border, rgba(37, 99, 235, 0.22))',
              background: primaryHover
                ? 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))'
                : 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))',
              color: 'var(--t-accent, #2563eb)',
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              cursor: 'pointer',
              fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
              transition: 'transform 160ms ease, background-color 160ms ease, border-color 160ms ease',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {primaryActionLabel}
              <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1, opacity: 0.8 }}>&gt;</span>
            </span>
          </button>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
          }}>
            Starter prompts
          </div>
          {prompts.map((prompt) => {
            const isHovered = hoveredPrompt === prompt.label;
            return (
              <button
                key={prompt.label}
                type="button"
                onClick={() => onPromptSelect(prompt)}
                onMouseEnter={() => setHoveredPrompt(prompt.label)}
                onMouseLeave={() => setHoveredPrompt(null)}
                style={{
                  minHeight: 44,
                  paddingTop: 10,
                  paddingRight: 12,
                  paddingBottom: 10,
                  paddingLeft: 12,
                  borderRadius: 12,
                  border: `1px solid ${isHovered ? 'var(--t-accent-border, rgba(37, 99, 235, 0.22))' : 'var(--t-divider-subtle)'}`,
                  background: isHovered ? 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))' : 'var(--t-bg-card, rgba(148, 163, 184, 0.08))',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  textAlign: 'left',
                  fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
                  transition: 'transform 160ms ease, background-color 160ms ease, border-color 160ms ease',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{
                    fontSize: 13,
                    fontWeight: 650,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text)',
                  }}>
                    {prompt.label}
                  </span>
                  <span style={{
                    fontSize: 11,
                    lineHeight: 1.4,
                    letterSpacing: '-0.01em',
                    color: 'var(--t-text-muted)',
                  }}>
                    {prompt.detail}
                  </span>
                </span>
                <span aria-hidden="true" style={{
                  flexShrink: 0,
                  fontSize: 16,
                  lineHeight: 1,
                  color: 'var(--t-text-faint)',
                }}>
                  &gt;
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function mediaHref(path: string): string {
  return `/api/mobile/media?path=${encodeURIComponent(path)}`;
}

function isImageMedia(item: MobileTranscriptMedia): boolean {
  return item.kind !== 'pdf' && item.kind !== 'file';
}

function isCompactionEntry(entry: MobileTranscriptEntry): boolean {
  return entry.type === 'compaction'
    || (entry.role === 'system' && entry.text.toLowerCase().includes('compaction'));
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

type SidebarApproval = ApprovalRecord;

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
    .map((line) => stripOperatorMarkdown(sanitizeTranscriptText(line)))
    .filter(Boolean)
    .filter((line) => !/^thought for \d/i.test(line))
    .filter((line) => !/^(gemini|opus|claude code|codex)\b/i.test(line))
    .filter((line) => !/^\d{1,2}:\d{2}\s?(am|pm)$/i.test(line));

  const headline = compactLine(lines[0] ?? stripOperatorMarkdown(sanitizeTranscriptText(text)) ?? 'Long assistant note', 'Long assistant note', 180);
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
    type: entry.type,
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
    compaction: entry.compaction,
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
  const displayText = sanitizeTranscriptText(entry.text);
  const hasText = Boolean(displayText.trim());
  const hasMedia = Boolean(entry.media?.length);
  const hasToolCalls = Boolean(entry.toolCalls?.length);
  const isSlashCommand = isSlashCommandText(entry.text);
  const runtimeEvent = useMemo(() => parseRuntimeEventSummary(entry.text), [entry.text]);
  const displayRuntimeEvent = useMemo(() => {
    if (!runtimeEvent) return null;

    const rawPreviewLines = (runtimeEvent.rawPreviewLines ?? [])
      .map((line) => sanitizeTranscriptText(line))
      .map((line) => line.trim())
      .filter(Boolean);

    return {
      ...runtimeEvent,
      title: sanitizeTranscriptText(runtimeEvent.title),
      summary: sanitizeTranscriptText(runtimeEvent.summary),
      status: runtimeEvent.status ? sanitizeTranscriptText(runtimeEvent.status) : undefined,
      task: runtimeEvent.task ? sanitizeTranscriptText(runtimeEvent.task) : undefined,
      source: runtimeEvent.source ? sanitizeTranscriptText(runtimeEvent.source) : undefined,
      action: runtimeEvent.action ? sanitizeTranscriptText(runtimeEvent.action) : undefined,
      rawPreviewLines,
    };
  }, [runtimeEvent]);
  const runtimeEventDisplay = displayRuntimeEvent ?? runtimeEvent;
  const displayStatus = runtimeEventDisplay?.status;
  const displaySource = runtimeEventDisplay?.source;
  const displayAction = runtimeEventDisplay?.action;
  const displayChangedFiles = runtimeEventDisplay?.changedFiles ?? [];
  const displayPreviewLines = runtimeEventDisplay?.rawPreviewLines ?? [];
  const speakerChanged = !previousEntry || previousEntry.role !== entry.role;
  const showTimestamp = (() => {
    if (!previousEntry?.timestampLabel || !entry.timestampLabel) return speakerChanged;
    const prev = new Date(`1970-01-01 ${previousEntry.timestampLabel}`).getTime();
    const curr = new Date(`1970-01-01 ${entry.timestampLabel}`).getTime();
    if (Number.isNaN(prev) || Number.isNaN(curr)) return speakerChanged;
    return Math.abs(curr - prev) >= 15 * 60 * 1000;
  })();

  const mdBlocks = useMemo(
    () => hasText ? renderMarkdownBlocks(displayText, onOpenMermaid, onRunInTerminal) : [],
    [displayText, hasText, onOpenMermaid, onRunInTerminal],
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
      <CompactionNode
        summary={entry.compaction?.summary}
        trigger={entry.compaction?.trigger}
        tokensBefore={entry.compaction?.tokensBefore}
        tokensAfter={entry.compaction?.tokensAfter}
        timestampLabel={showTimestamp ? entry.timestampLabel : undefined}
      />
    );
  }

  if (!isUser && runtimeEventDisplay) {
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
                {runtimeEventDisplay.title}
              </div>
              <div style={{
                marginTop: 2,
                fontSize: 11,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.45,
              }}>
                {runtimeEventDisplay.summary}
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
            }}>
              sub-agent
            </span>
            {displayStatus ? (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '3px 8px',
                borderRadius: 999,
                background: displayStatus.toLowerCase().includes('timed')
                  ? 'rgba(245, 158, 11, 0.10)'
                  : 'rgba(37, 99, 235, 0.10)',
                color: displayStatus.toLowerCase().includes('timed') ? '#b45309' : '#2563eb',
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {displayStatus}
              </span>
            ) : null}
            {displaySource ? (
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
                {displaySource}
              </span>
            ) : null}
            {displayChangedFiles.length ? (
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
                {displayChangedFiles.length} file{displayChangedFiles.length !== 1 ? 's' : ''}
              </span>
            ) : null}
            {(displayAction || displayPreviewLines.length || displayChangedFiles.length) ? (
                <button
                  type="button"
                  onClick={() => setHandoffExpanded((value) => !value)}
                  style={{
                    display: 'inline-flex',
                  alignItems: 'center',
                    gap: 5,
                    padding: '3px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--t-panel-border)',
                    background: handoffExpanded ? THEME_ACCENT_SOFT : THEME_BG_CARD,
                    color: handoffExpanded ? THEME_ACCENT : 'var(--t-text-secondary)',
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

          {handoffExpanded && (displayAction || displayPreviewLines.length || displayChangedFiles.length) ? (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '10px 12px',
              borderRadius: 12,
              background: THEME_PANEL_GLASS,
              border: '1px solid var(--t-panel-border)',
            }}>
              {displayAction ? (
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
                    {displayAction}
                  </div>
                </div>
              ) : null}

              {displayChangedFiles.length ? (
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
                  {displayChangedFiles.map((filePath) => (
                    <div
                      key={filePath}
                      style={CHANGED_FILE_STYLE}
                    >
                      {filePath}
                    </div>
                  ))}
                </div>
              ) : null}

              {displayPreviewLines.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--t-text-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    Payload Preview
                  </div>
                  <div style={{
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: THEME_BG_CARD,
                    border: '1px solid var(--t-panel-border)',
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: 'var(--t-text-secondary)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {displayPreviewLines.join('\n')}
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
              {displayText.split('\n').map((line, i) => (
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
              background: THEME_BG_CARD,
              color: 'var(--t-text-secondary)',
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
                  style={OPERATOR_DETAIL_STYLE}
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
              color: 'var(--t-text-muted)',
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
                background: THEME_BG_CARD,
                color: 'var(--t-text-secondary)',
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
                  background: activeBlock === idx ? THEME_ACCENT_SOFT : 'transparent',
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
        <MessageActions messageId={entry.id} messageText={displayText} />
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
  const lines = sanitizeTranscriptText(text).split('\n');
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
                      <th key={ci} style={TABLE_HEADER_CELL_STYLE}>
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
                          <td key={ci} style={TABLE_BODY_CELL_STYLE}>
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
  const parts = sanitizeTranscriptText(text).split(/(!\[[^\]]*\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
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
  activeChips,
  emptyStateLabel,
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
  activeChips: SessionPickerChip[];
  emptyStateLabel: string;
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
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 44,
        paddingLeft: 16,
        paddingRight: 12,
        backgroundColor: 'transparent',
        borderBottomWidth: '0.5px',
        borderBottomStyle: 'solid',
        borderBottomColor: 'rgba(0, 0, 0, 0.04)',
        zIndex: 10,
        position: 'relative',
      }}
    >
      <div ref={pickerRef} style={{ minWidth: 0, flex: 1, position: 'relative' }}>
        <button
          type="button"
          onClick={() => setPickerOpen((p) => !p)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            width: '100%',
            paddingTop: 6,
            paddingBottom: 6,
            paddingLeft: 8,
            paddingRight: 8,
            margin: 0,
            borderWidth: 0,
            borderRadius: 10,
            backgroundColor: 'transparent',
            cursor: 'pointer',
            textAlign: 'left' as const,
            WebkitTapHighlightColor: 'transparent',
            transition: 'background-color 150ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
          aria-label="Switch lane"
          aria-expanded={pickerOpen}
        >
          <span style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            backgroundColor: connectionDotColor,
            animation: (connectionDotColor === '#ff9f0a' || connectionDotColor === '#f59e0b')
              ? 'reviewingBreathe 2.4s ease-in-out infinite' : 'none',
          }} />
          <span style={{
            fontSize: 14,
            fontWeight: 600,
            color: '#111827',
            letterSpacing: '-0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
          }}>
            {activeTitle}
          </span>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {activeChips.length > 0 ? (
              <span style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'var(--t-text-faint)',
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
              }}>
                {activeChips.map((chip) => chip.label).join(' · ')}
              </span>
            ) : null}
            <CaretDown
              size={12}
              weight="bold"
              color="var(--t-text-faint)"
              style={{
                flexShrink: 0,
                transition: 'transform 200ms cubic-bezier(0.32, 0.72, 0, 1)',
                transform: pickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              }}
            />
          </div>
        </button>

        {pickerOpen ? (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              minWidth: 280,
              maxWidth: 340,
              maxHeight: 360,
              overflowY: 'auto',
              paddingTop: 6,
              paddingRight: 6,
              paddingBottom: 6,
              paddingLeft: 6,
              borderRadius: 12,
              backgroundColor: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(20px) saturate(1.8)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.8)',
              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.06)',
              scrollbarWidth: 'none',
              zIndex: 100,
            } as React.CSSProperties}
          >
            {projectGroups.length === 0 ? (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 76,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 10,
                color: 'var(--t-text-muted)',
                fontSize: 12,
                fontWeight: 500,
                backgroundColor: 'rgba(0, 0, 0, 0.03)',
              }}>
                {emptyStateLabel}
              </div>
            ) : null}
            {projectGroups.map((group, gi) => {
            const isExpanded = expandedGroup === group.workspace;
            const isSingle = group.sessions.length === 1;
            const containsSelected = group.sessions.some((s) => s.sessionKey === selectedSession?.sessionKey);
            const singleSession = isSingle ? group.sessions[0] : null;
            const groupTitle = singleSession ? sessionPickerTitle(singleSession) : group.projectName;
            const groupSubtitle = singleSession ? sessionPickerRowSubtitle(singleSession) : group.summary;
            const dotColor = group.hasRunning
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
                  onMouseEnter={(e) => {
                    if (!(containsSelected && !isExpanded)) e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
                  }}
                  onMouseLeave={(e) => {
                    if (!(containsSelected && !isExpanded)) e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    paddingTop: 8,
                    paddingBottom: 8,
                    paddingLeft: 10,
                    paddingRight: 10,
                    borderWidth: 0,
                    borderRadius: 8,
                    backgroundColor: containsSelected && !isExpanded
                      ? 'rgba(37, 99, 235, 0.06)'
                      : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left' as const,
                    transition: 'background-color 120ms ease',
                    minHeight: 44,
                  }}
                >
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    flexShrink: 0,
                    backgroundColor: dotColor,
                  }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: containsSelected ? 600 : 500,
                      color: containsSelected ? '#111827' : 'var(--t-text)',
                      lineHeight: 1.3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {groupTitle}
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: 'var(--t-text-muted)',
                      lineHeight: 1.3,
                      marginTop: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {groupSubtitle}
                      {group.mostRecentTime ? ` · ${group.mostRecentTime}` : ''}
                    </div>
                  </div>
                  {containsSelected && isSingle ? (
                    <span style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', flexShrink: 0 }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d="M20 6 9 17l-5-5" /></svg>
                    </span>
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
                    marginLeft: 14,
                    borderLeftWidth: 1,
                    borderLeftStyle: 'solid',
                    borderLeftColor: 'rgba(0, 0, 0, 0.06)',
                    paddingLeft: 8,
                    marginTop: 2,
                    marginBottom: 4,
                  }}>
                    {group.sessions.map((session) => {
                      const isActive = session.sessionKey === selectedSession?.sessionKey;
                      const isRunning = session.status === 'running' || session.status === 'reviewing';
                      const sessionPercent = Math.round(session.context?.usedPercent ?? 0);
                      const isSessionReviewing = !isRunning && session.status === 'reviewing';
                      const sDotColor = isRunning ? '#34c759' : isSessionReviewing ? '#a78bfa' : sessionPercent >= 75 ? '#ff9f0a' : '#8e8e93';
                      const name = sessionPickerTitle(session);
                      const subtitle = sessionPickerRowSubtitle(session);

                      return (
                        <button
                          key={session.sessionKey}
                          type="button"
                          onClick={() => {
                            handleSessionFocus(session.sessionKey);
                            setPickerOpen(false);
                          }}
                          onMouseEnter={(e) => {
                            if (!isActive) e.currentTarget.style.backgroundColor = 'rgba(0, 0, 0, 0.03)';
                          }}
                          onMouseLeave={(e) => {
                            if (!isActive) e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            paddingTop: 8,
                            paddingBottom: 8,
                            paddingLeft: 10,
                            paddingRight: 10,
                            borderWidth: 0,
                            borderRadius: 8,
                            backgroundColor: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                            cursor: 'pointer',
                            textAlign: 'left' as const,
                            transition: 'background-color 120ms ease',
                            minHeight: 44,
                          }}
                        >
                          <span style={{
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            flexShrink: 0,
                            backgroundColor: sDotColor,
                          }} />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{
                              fontSize: 12,
                              fontWeight: isActive ? 600 : 400,
                              color: isActive ? '#111827' : 'var(--t-text)',
                              lineHeight: 1.3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}>
                              {name}
                            </div>
                            {subtitle ? (
                              <div style={{
                                fontSize: 11,
                                color: 'var(--t-text-muted)',
                                lineHeight: 1.3,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                marginTop: 1,
                              }}>
                                {subtitle}
                              </div>
                            ) : null}
                          </div>
                          <ContextUsageRing percent={sessionPercent} size={22} />
                          {isActive ? (
                            <span style={{ flexShrink: 0, color: '#2563eb', display: 'flex' }}>
                              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}><path d="M20 6 9 17l-5-5" /></svg>
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {gi < projectGroups.length - 1 ? (
                  <div style={{
                    height: '0.5px',
                    backgroundColor: 'rgba(0, 0, 0, 0.06)',
                    marginTop: 3,
                    marginBottom: 3,
                    marginLeft: 10,
                    marginRight: 10,
                  }} />
                ) : null}
              </div>
            );
            })}
          </div>
        ) : null}
      </div>

      {diffIsActive ? (
        <button
          type="button"
          onClick={() => onOpenDiff ? onOpenDiff() : setDiffOpen(true)}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 8px',
            borderRadius: 8,
            border: 'none',
            background: 'transparent',
            color: 'var(--t-text-muted)',
            fontSize: 11,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'background 150ms ease',
            fontFamily: '"SF Mono", ui-monospace, monospace',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(0, 0, 0, 0.04)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          aria-label="Open diff sheet"
        >
          <span style={{ color: '#22c55e', fontWeight: 600 }}>+{diffStats.additions}</span>
          <span style={{ color: '#ef4444', fontWeight: 600 }}>-{diffStats.deletions}</span>
          <span style={{ color: 'var(--t-text-faint)', fontWeight: 500 }}>{diffStats.files}f</span>
        </button>
      ) : null}
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
          <div
            className="remodex-loading-card"
            style={{
              maxWidth: 340,
              marginRight: 'auto',
              marginLeft: 'auto',
              textAlign: 'center',
              lineHeight: 1.6,
            }}
          >
            This lane appears here as it starts working. Send the first note below and the panel will fill itself in.
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
              border: '1px solid var(--t-panel-border)',
              background: THEME_PANEL_GLASS,
              backdropFilter: 'blur(20px) saturate(1.6)',
              WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
              color: 'var(--t-text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
              boxShadow: 'var(--t-panel-shadow)',
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
          <div style={{ flex: 1, height: 1, background: 'var(--t-divider)' }} />
          <span style={{
            fontSize: 10,
            fontWeight: 700,
            color: 'var(--t-text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            whiteSpace: 'nowrap',
          }}>
            {groupSummary.separatorLabel ?? groupSummary.timeLabel ?? 'run'}
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--t-divider)' }} />
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
              background: THEME_ACCENT_SOFT,
              color: THEME_ACCENT,
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
                color: 'var(--t-text-muted)',
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
                      border: '1px solid var(--t-panel-border)',
                      background: expandedSourceId === card.id ? THEME_PANEL_GLASS : THEME_BG_CARD,
                      boxShadow: expandedSourceId === card.id ? 'var(--t-panel-shadow)' : 'none',
                      transition: 'transform 180ms ease, box-shadow 180ms ease, background 180ms ease, border-color 180ms ease',
                      cursor: 'pointer',
                      textAlign: 'left',
                      animation: 'sidebarSourceCardIn 220ms ease-out',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-1px)';
                      e.currentTarget.style.boxShadow = 'var(--t-panel-shadow)';
                      e.currentTarget.style.background = THEME_PANEL_GLASS;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.boxShadow = expandedSourceId === card.id ? 'var(--t-panel-shadow)' : 'none';
                      e.currentTarget.style.background = expandedSourceId === card.id ? THEME_PANEL_GLASS : THEME_BG_CARD;
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
                    <span style={SOURCE_CARD_SUMMARY_STYLE}>
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
                            style={SOURCE_LINK_STYLE}
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
  const safeActivityHeadline = activityHeadline ? sanitizeTranscriptText(activityHeadline) : undefined;
  const mdBlocks = useMemo(
    () => text.trim() ? renderMarkdownBlocks(sanitizeTranscriptText(text), onOpenMermaid, onRunInTerminal) : [],
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
      background: 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)',
      border: `1px solid ${THEME_ACCENT_BORDER}`,
      boxShadow: 'var(--t-panel-shadow)',
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
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {agentName}
          <span style={{ color: 'rgba(37, 99, 235, 0.45)' }}>•</span>
          active turn
        </span>
        {safeActivityHeadline ? (
          <span style={{
            fontSize: 11,
            color: 'var(--t-text-secondary)',
            fontWeight: 600,
            lineHeight: 1.4,
          }}>
            {safeActivityHeadline}
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
      background: 'linear-gradient(180deg, var(--t-panel) 0%, var(--t-panel-translucent) 100%)',
      border: `1px solid ${THEME_ACCENT_BORDER}`,
      boxShadow: 'var(--t-panel-shadow)',
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
          background: THEME_ACCENT_SOFT,
          color: THEME_ACCENT,
          flexShrink: 0,
        }}>
          <Sparkles size={15} strokeWidth={2.2} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 800,
            color: 'var(--t-text-strong)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Approval Required
          </div>
          <div style={{
            marginTop: 2,
            fontSize: 11,
            color: 'var(--t-text-muted)',
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
                background: THEME_BG_CARD,
                border: `1px solid ${riskTone.border}`,
                boxShadow: '0 10px 20px rgba(15, 23, 42, 0.08)',
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
                  color: 'var(--t-text)',
                  flex: 1,
                  letterSpacing: '-0.01em',
                }}>
                  {approval.agent} • {approval.title}
                </span>
                <span style={{
                  fontSize: 10,
                  color: 'var(--t-text-muted)',
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
                color: 'var(--t-text-secondary)',
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
  const composePlaceholder = useMemo(() => {
    const basis = `${selectedSession?.sessionKey ?? ''}:${currentAgentName}`;
    let hash = 0;
    for (let i = 0; i < basis.length; i += 1) {
      hash = (hash * 31 + basis.charCodeAt(i)) >>> 0;
    }
    return O_PLACEHOLDERS[hash % O_PLACEHOLDERS.length];
  }, [currentAgentName, selectedSession?.sessionKey]);

  return (
    <div style={{
      paddingTop: 10,
      paddingRight: 14,
      paddingBottom: 14,
      paddingLeft: 14,
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

      <div className="remodex-compose-surface" style={{ backgroundColor: 'rgba(0, 0, 0, 0.025)' }}>
        <ThinkingXray
          model={modelOverride ?? sessionDisplayModel(selectedSession)}
          agentRunning={agentRunning}
          streamingText={streamingText}
        />

        <textarea
          ref={composeRef}
          name="agentPanelMessage"
          aria-label={`Message ${currentAgentName}`}
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
          placeholder={composePlaceholder}
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
            border: `1px solid ${THEME_ACCENT_BORDER}`,
            background: THEME_PANEL_GLASS,
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
                  background: THEME_ACCENT_SOFT,
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
              <PlusCircle size={18} weight="duotone" />
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
              <MagicWand size={18} weight={enhancing ? 'regular' : 'duotone'} className={enhancing ? 'spin' : undefined} />
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
                background: stopping ? 'rgba(127, 29, 29, 0.16)' : 'rgba(239, 68, 68, 0.10)',
                color: '#ef4444',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: stopping ? 'default' : 'pointer',
                transition: 'all 150ms ease',
              }}
            >
              {stopping ? (
                <SpinnerGap size={17} weight="bold" className="spin" />
              ) : (
                <>
                  <Stop size={16} weight="fill" />
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
                width: 36,
                height: 36,
                borderRadius: 10,
                border: 'none',
                background: chatSendDisabled ? 'var(--t-divider-subtle)' : THEME_ACCENT,
                color: chatSendDisabled ? 'var(--t-text-faint)' : '#ffffff',
                cursor: chatSendDisabled ? 'default' : 'pointer',
                transition: 'background 150ms ease, box-shadow 150ms ease',
                boxShadow: chatSendDisabled ? 'none' : '0 2px 8px rgba(37, 99, 235, 0.2)',
              }}
            >
              {sending ? (
                <SpinnerGap size={18} weight="bold" className="spin" />
              ) : (
                <PaperPlaneRight size={18} weight="fill" />
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
        padding: '5px 12px',
        marginTop: 4,
      }}>
        {(() => {
          const rawPct = contextPercentOverride ?? ((selectedSession as unknown as Record<string, unknown>)?.context
            ? ((selectedSession as unknown as Record<string, unknown>).context as { usedPercent?: number })?.usedPercent
            : undefined);
          const pct = typeof rawPct === 'number' && rawPct > 0 ? Math.round(rawPct) : null;
          const leadLabel = composeFooterLeadLabel(selectedSession, statusOverride);
          const branchLabel = cleanBranchLabel(branchOverride ?? selectedSession?.branch);

          return (
            <>
              {leadLabel ? (
                <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 600 }}>
                  {leadLabel}
                </span>
              ) : null}
              {branchLabel ? (
                <>
                  {leadLabel ? <span style={{ color: 'var(--t-divider)' }}>·</span> : null}
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {branchLabel}
                  </span>
                </>
              ) : null}
              {pct !== null ? (
                <>
                  {(leadLabel || branchLabel) ? <span style={{ color: 'var(--t-divider)' }}>·</span> : null}
                  <span style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: pct >= 70 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#34c759',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, color: 'var(--t-text-secondary)', fontWeight: 500 }}>
                    {pct}% context
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
  workspaceSessions,
  workspaceLane,
  orchestratorPackets = [],
  draftInjection,
  onOpenDiff,
  onOpenFile,
  onOpenMermaid,
  onRunInTerminal,
  onSelectSession,
  onWsStatusChange,
}: {
  externalSessionKey?: string;
  workspaceSessions?: SessionSummary[];
  workspaceLane?: WorkspaceLaneState | null;
  orchestratorPackets?: OrchestratorPacket[];
  draftInjection?: { id: string; text: string } | null;
  onOpenDiff?: () => void;
  onOpenFile?: (filePath: string, workspace?: string) => void;
  onOpenMermaid?: (code: string) => void;
  onRunInTerminal?: (command: string) => void;
  onSelectSession?: (sessionKey: string) => void;
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
  const initialInboxReadyRef = useRef(false);
  const lastHeaderSessionRef = useRef<SessionSummary | null>(null);
  const lastAppliedExternalSessionKeyRef = useRef('');
  const lastNonEmptySessionsRef = useRef<SessionSummary[]>([]);
  const workspaceScopeProvided = workspaceSessions !== undefined;

  const effectiveSessions = useMemo(
    () => (workspaceScopeProvided ? (workspaceSessions ?? []) : sessions),
    [sessions, workspaceScopeProvided, workspaceSessions],
  );

  const selectedSession = useMemo(
    () => effectiveSessions.find(s => s.sessionKey === selectedKey),
    [effectiveSessions, selectedKey]
  );
  const selectedOrchestratorPacket = useMemo(
    () => workspaceLane?.packet
      ?? selectedSession?.orchestrationPacket
      ?? orchestratorPackets.find((packet) => packet.lane?.sessionKey === selectedKey)
      ?? null,
    [orchestratorPackets, selectedKey, selectedSession?.orchestrationPacket, workspaceLane?.packet],
  );
  const selectedOrchestratorRepoPath = useMemo(
    () => workspaceLane?.repoPath
      ?? selectedSession?.workspace
      ?? orchestratorPackets.find((packet) => packet.lane?.sessionKey === selectedKey)?.lane?.repoPath
      ?? null,
    [orchestratorPackets, selectedKey, selectedSession?.workspace, workspaceLane?.repoPath],
  );
  const headerSession = useMemo(
    () => selectedSession ?? (lastHeaderSessionRef.current?.sessionKey === selectedKey ? lastHeaderSessionRef.current : null),
    [selectedKey, selectedSession],
  );

  useEffect(() => {
    if (selectedSession) {
      lastHeaderSessionRef.current = selectedSession;
    }
  }, [selectedSession]);

  useEffect(() => {
    if (effectiveSessions.length > 0) {
      lastNonEmptySessionsRef.current = effectiveSessions;
    }
  }, [effectiveSessions]);

  useEffect(() => {
    if (!workspaceScopeProvided) return;
    if (effectiveSessions.some((session) => session.sessionKey === selectedKey)) return;
    if (!selectedKey) return;
    transcriptRequestRef.current += 1;
    selectedKeyRef.current = '';
    lastHeaderSessionRef.current = null;
    setSelectedKey('');
    setTranscript([]);
    setApprovals([]);
    setLoading(false);
    setAgentRunning(false);
    setStreamingText('');
    liveToolCallsRef.current = [];
    setActiveToolCalls([]);
  }, [effectiveSessions, selectedKey, workspaceScopeProvided]);

  useEffect(() => {
    if (selectedSession || effectiveSessions.length === 0) return;
    const primary = effectiveSessions.find((session) => session.sessionKey === snapshot?.primarySessionKey) ?? effectiveSessions[0];
    if (primary && primary.sessionKey !== selectedKey) {
      setSelectedKey(primary.sessionKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-select when sessions change, not when selectedKey changes (avoids loop)
  }, [effectiveSessions, snapshot?.primarySessionKey]);

  const streamingTextRef = useRef('');

  useEffect(() => {
    selectedKeyRef.current = selectedKey;
  }, [selectedKey]);

  useEffect(() => {
    initialInboxReadyRef.current = false;
  }, []);

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
      if (!initialInboxReadyRef.current) return;
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

  const stablePickerSessions = useMemo(() => {
    if (workspaceScopeProvided) return effectiveSessions;
    if (effectiveSessions.length > 0) return effectiveSessions;
    if (loading || connectionState !== 'connected') return lastNonEmptySessionsRef.current;
    return [];
  }, [connectionState, effectiveSessions, loading, workspaceScopeProvided]);

  const pickerSnapshot = useMemo(
    () => (workspaceScopeProvided
      ? buildPickerFallbackSnapshot(workspaceSessions ?? [], selectedKey)
      : (snapshot && snapshot.sessions.length > 0 ? snapshot : buildPickerFallbackSnapshot(stablePickerSessions, selectedKey))),
    [selectedKey, snapshot, stablePickerSessions, workspaceScopeProvided, workspaceSessions],
  );

  const projectGroups = useMemo(
    () => pickerSnapshot ? buildProjectGroups(pickerSnapshot, selectedSession) : [],
    [pickerSnapshot, selectedSession]
  );
  const fallbackLiveSession = useMemo(
    () => stablePickerSessions.find((session) => session.isCurrentSession) ?? stablePickerSessions[0] ?? null,
    [stablePickerSessions],
  );
  const missingSelectedSession = Boolean(
    selectedKey
    && !selectedSession
    && !loading
    && stablePickerSessions.length > 0,
  );
  const laneTranscriptState = useMemo(() => {
    if (workspaceLane?.transcriptState) {
      if (workspaceLane.transcriptState === 'ready' && loading && transcript.length === 0) {
        return 'waiting_activity';
      }
      return workspaceLane.transcriptState;
    }
    if (selectedOrchestratorPacket?.status === 'recovering') return 'recovering';
    if (missingSelectedSession) return 'missing';
    if (workspaceScopeProvided && !selectedSession && effectiveSessions.length === 0) return 'no_lane';
    if ((selectedSession || selectedOrchestratorPacket) && loading && transcript.length === 0) return 'waiting_activity';
    return 'ready';
  }, [
    effectiveSessions.length,
    loading,
    missingSelectedSession,
    selectedOrchestratorPacket,
    selectedSession,
    transcript.length,
      workspaceLane,
      workspaceScopeProvided,
  ]);
  const pickerEmptyStateLabel = useMemo(
    () => (
      workspaceScopeProvided
        ? (laneTranscriptState === 'recovering'
          ? 'Recovering lane'
          : laneTranscriptState === 'missing'
            ? 'Lane missing'
            : laneTranscriptState === 'waiting_activity'
              ? 'Waiting for first activity'
              : 'Choose a lane to begin')
        : ((loading || connectionState !== 'connected' || stablePickerSessions.length > 0) ? 'Refreshing sessions…' : 'No IDE sessions yet')
    ),
    [connectionState, laneTranscriptState, loading, stablePickerSessions.length, workspaceScopeProvided],
  );

  const showWorkspaceEmptyState = workspaceScopeProvided && laneTranscriptState === 'no_lane';
  const showLaneWaitingState = workspaceScopeProvided && laneTranscriptState === 'waiting_activity';
  const showLaneRecoveringState = workspaceScopeProvided && laneTranscriptState === 'recovering';
  const showLaneMissingState = workspaceScopeProvided && laneTranscriptState === 'missing';
  const chatEmptyScopeLabel = useMemo(
    () => resolveChatScopeLabel(selectedSession, selectedOrchestratorPacket, selectedOrchestratorRepoPath, workspaceLane ?? undefined),
    [selectedOrchestratorPacket, selectedOrchestratorRepoPath, selectedSession, workspaceLane],
  );
  const chatEmptyTaskLabel = useMemo(
    () => sessionTaskLabel(selectedSession) ?? selectedOrchestratorPacket?.referenceLabel ?? null,
    [selectedOrchestratorPacket?.referenceLabel, selectedSession],
  );
  const chatEmptyRepoLabel = useMemo(
    () => compactChatScopeLabel(
      selectedSession?.runtimeSurface?.reviewContext?.repoSlug?.trim()
        || selectedOrchestratorRepoPath?.trim()
        || workspaceLane?.repoPath?.trim()
        || selectedSession?.workspace?.trim()
        || null,
    ),
    [selectedOrchestratorRepoPath, selectedSession, workspaceLane?.repoPath],
  );
  const chatEmptyCopy = useMemo<{
    title: string;
    body: string;
    scopeLabel: string | null;
    prompts: ChatStarterPrompt[];
    primaryActionLabel?: string;
  }>(() => {
    const prompts = buildChatStarterPrompts(
      chatEmptyScopeLabel,
      chatEmptyTaskLabel,
      chatEmptyRepoLabel,
      showWorkspaceEmptyState,
    );

    if (showWorkspaceEmptyState) {
      return {
        title: 'Pick a lane to anchor this chat',
        body: chatEmptyRepoLabel
          ? `Choose a lane first. I'll keep the draft attached to ${chatEmptyRepoLabel} once it is active.`
          : "Choose a lane first. I'll keep the draft attached to the active workspace once it is live.",
        primaryActionLabel: 'Choose a lane',
        scopeLabel: chatEmptyRepoLabel ?? null,
        prompts,
      };
    }

    if (showLaneWaitingState) {
      return {
        title: chatEmptyTaskLabel
          ? `Ready for ${chatEmptyTaskLabel}`
          : chatEmptyScopeLabel
            ? `Ready for ${chatEmptyScopeLabel}`
            : 'Ready when you are',
        body: chatEmptyTaskLabel && chatEmptyScopeLabel
          ? `I'll keep replies scoped to ${chatEmptyScopeLabel} and surface the next useful move for ${chatEmptyTaskLabel}.`
          : chatEmptyScopeLabel
            ? `I'll keep replies scoped to ${chatEmptyScopeLabel} and surface the next useful move as soon as activity lands.`
            : "I'll keep replies scoped to the active lane and surface the next useful move as soon as activity lands.",
        scopeLabel: chatEmptyScopeLabel ?? chatEmptyRepoLabel,
        prompts,
      };
    }

    return {
      title: 'Ready when you are',
      body: chatEmptyScopeLabel
        ? `I'll keep replies scoped to ${chatEmptyScopeLabel}.`
        : "Start with a prompt and I'll keep replies scoped once a lane is active.",
      scopeLabel: chatEmptyScopeLabel ?? chatEmptyRepoLabel,
      prompts,
    };
  }, [chatEmptyRepoLabel, chatEmptyScopeLabel, chatEmptyTaskLabel, showLaneWaitingState, showWorkspaceEmptyState]);
  const handleEmptyStatePromptSelect = useCallback((prompt: ChatStarterPrompt) => {
    setDraft(prompt.text);
    composeRef.current?.focus();
    if (showWorkspaceEmptyState) {
      setPickerOpen(true);
    }
  }, [showWorkspaceEmptyState]);

  // ── Derived header values ──
  const activeTitle = useMemo(() => {
    if (workspaceLane?.title) return workspaceLane.title;
    if (!headerSession) {
      if (selectedOrchestratorPacket?.title?.trim()) return selectedOrchestratorPacket.title.trim();
      return workspaceScopeProvided ? 'Choose a lane' : 'Select session';
    }
    return sessionHeaderTitle(headerSession);
  }, [headerSession, selectedOrchestratorPacket?.title, workspaceLane?.title, workspaceScopeProvided]);

  const activeChips = useMemo(() => {
    if (workspaceLane) {
      const runtimeTone = workspaceLane.runtime ? orchestratorRuntimeTone(workspaceLane.runtime) : null;
      const statusTone = workspaceLane.status ? orchestratorStatusTone(workspaceLane.status) : null;
      const chips: SessionPickerChip[] = [];
      if (workspaceLane.packet?.referenceLabel) {
        chips.push({ label: workspaceLane.packet.referenceLabel, tone: 'blue' });
      }
      if (runtimeTone) {
        chips.push({ label: runtimeTone.label, tone: workspaceLane.runtime === 'claude-code' ? 'purple' : 'green' });
      }
      if (statusTone) {
        const tone: SessionPickerChipTone = statusTone.label === 'Running'
          ? 'green'
          : statusTone.label === 'Review'
            ? 'purple'
            : statusTone.label === 'Blocked'
              ? 'red'
              : statusTone.label === 'Queued' || statusTone.label === 'Launching'
                ? 'blue'
                : 'slate';
        chips.push({ label: statusTone.label, tone });
      }
      return chips;
    }
    if (headerSession) return sessionPickerChips(headerSession);
    if (!selectedOrchestratorPacket) return [];
    const runtimeTone = orchestratorRuntimeTone(selectedOrchestratorPacket.runtime);
    const statusTone = orchestratorStatusTone(selectedOrchestratorPacket.status);
    const packetTone: SessionPickerChipTone = 'blue';
    const runtimeChipTone: SessionPickerChipTone = selectedOrchestratorPacket.runtime === 'claude-code' ? 'purple' : 'green';
    const statusChipTone: SessionPickerChipTone = statusTone.label === 'Running'
      ? 'green'
      : statusTone.label === 'Review'
        ? 'purple'
        : statusTone.label === 'Blocked'
          ? 'red'
          : statusTone.label === 'Queued' || statusTone.label === 'Launching'
            ? 'blue'
            : 'slate';
    return [
      { label: selectedOrchestratorPacket.referenceLabel, tone: packetTone },
      { label: runtimeTone.label, tone: runtimeChipTone },
      {
        label: statusTone.label,
        tone: statusChipTone,
      },
    ];
  }, [headerSession, selectedOrchestratorPacket, workspaceLane]);

  const connectionDotColor = workspaceLane?.status
    ? orchestratorStatusTone(workspaceLane.status).dot
    : selectedOrchestratorPacket
      ? orchestratorStatusTone(selectedOrchestratorPacket.status).dot
      : headerSession?.status === 'running'
        ? '#34c759'
        : headerSession?.status === 'reviewing'
          ? '#ff9f0a'
          : '#8e8e93';

  const currentAgentName = selectedSession ? getAgentName(selectedSession) : (selectedOrchestratorPacket?.title ?? 'Assistant');
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
      const res = await fetch('/api/mobile/inbox');
      if (!res.ok) return;
      const data = (await res.json()) as MobileInboxSnapshot;
      setSnapshot(prev => snapshotFp(prev) === snapshotFp(data) ? prev : data);
      setSessions(prev => sessionsFp(prev) === sessionsFp(data.sessions ?? []) ? prev : (data.sessions ?? []));
      initialInboxReadyRef.current = true;
      const selectedStillExists = data.sessions.some((session) => session.sessionKey === selectedKey);
      if ((!selectedKey || !selectedStillExists) && data.sessions.length > 0) {
        const primary = data.sessions.find(s => s.isCurrentSession) ?? data.sessions[0];
        setSelectedKey(primary.sessionKey);
      }
    } catch { /* silent */ }
  }, [selectedKey]);

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
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);
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
        setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${res.statusText}` }));
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
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated }));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              const nextTools = advanceToolStack(liveToolCallsRef.current, event.name);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated, toolCalls: nextTools }));
            }

            if (event.type === 'done' || event.type === 'close') {
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setTranscript(prev => updateTranscriptEntry(prev, assistantId, { toolCalls: settledTools }));
              }
              if (event.sessionId) {
                claudeSessionIdRef.current = event.sessionId;
              }
              // Use the final text if close provided it and we have nothing
              if (event.type === 'close' && event.text && !accumulated) {
                accumulated = event.text;
                setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated }));
              }
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated }));
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }
    } catch (err) {
      setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${err instanceof Error ? err.message : 'unknown'}` }));
    } finally {
      setAgentRunning(false);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
    }
  }, [effectiveSessions, selectedKey, scrollToBottom]);

  const sendToCodex = useCallback(async (text: string) => {
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);
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
        setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${res.statusText}` }));
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
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated }));
              scrollToBottom(false);
            }

            if (event.type === 'tool' && event.name) {
              const nextTools = advanceToolStack(liveToolCallsRef.current, event.name);
              liveToolCallsRef.current = nextTools;
              setActiveToolCalls(nextTools);
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated, toolCalls: nextTools }));
            }

            if ((event.type === 'done' || event.type === 'close') && event.threadId) {
              codexThreadIdRef.current = event.threadId;
            }

            if (event.type === 'done' || event.type === 'close') {
              const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const }));
              if (settledTools.length > 0) {
                liveToolCallsRef.current = settledTools;
                setTranscript(prev => updateTranscriptEntry(prev, assistantId, { toolCalls: settledTools }));
              }
            }

            if (event.type === 'error' && event.text) {
              accumulated += `\n⚠️ ${event.text}`;
              setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated }));
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${err instanceof Error ? err.message : 'unknown'}` }));
    } finally {
      setAgentRunning(false);
      liveToolCallsRef.current = [];
      setActiveToolCalls([]);
    }
  }, [effectiveSessions, selectedKey, scrollToBottom]);

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
    // WS-driven: instant refresh on agent/lane events, long fallback poll
    const handler = () => { void fetchDiffStats(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchDiffStats, wsConnected ? 300_000 : 30_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [wsConnected]);

  // ── External session key (from Agent Panel click) ──
  useEffect(() => {
    if (workspaceScopeProvided && workspaceLane) {
      if (workspaceLane.sessionKey) {
        if (workspaceLane.sessionKey !== lastAppliedExternalSessionKeyRef.current) {
          lastAppliedExternalSessionKeyRef.current = workspaceLane.sessionKey;
          setSelectedKey(workspaceLane.sessionKey);
        }
      } else if (workspaceLane.transcriptState !== 'missing' && selectedKey) {
        lastAppliedExternalSessionKeyRef.current = '';
        setSelectedKey('');
        setTranscript([]);
      }
      return;
    }
    if (!externalSessionKey) return;
    if (workspaceScopeProvided && !effectiveSessions.some((session) => session.sessionKey === externalSessionKey)) {
      return;
    }
    if (externalSessionKey !== lastAppliedExternalSessionKeyRef.current) {
      lastAppliedExternalSessionKeyRef.current = externalSessionKey;
      setSelectedKey(externalSessionKey);
    }
  }, [effectiveSessions, externalSessionKey, selectedKey, workspaceLane, workspaceScopeProvided]);

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
    const session = effectiveSessions.find(s => s.sessionKey === sessionKey);
    if (session) {
      setSelectedKey(session.sessionKey);
      onSelectSession?.(session.sessionKey);
    }
  }, [effectiveSessions, onSelectSession]);

  useEffect(() => {
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);

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
  }, [effectiveSessions, selectedKey]);

  // ── Init ──
  useEffect(() => { void fetchSessions(); }, [fetchSessions]);

  useEffect(() => {
    // WS-driven: instant refresh on inbox/agent events, long fallback poll
    const handler = () => { void fetchSessions(); };
    const wsEvents = ['o8:inbox', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(() => void fetchSessions(), wsConnected ? 120_000 : 8_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
  }, [fetchSessions, wsConnected]);

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

  // WS-driven transcript refresh: instant on agent events, long fallback poll
  useEffect(() => {
    if (!selectedKey) return;
    const handler = () => { void fetchTranscript(selectedKey); };
    const wsEvents = ['o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(() => void fetchTranscript(selectedKey), wsConnected ? 120_000 : 15_000);
    return () => {
      clearInterval(fallbackId);
      for (const e of wsEvents) window.removeEventListener(e, handler);
    };
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
    // WS-driven: instant refresh on inbox/realtime events instead of 12s polling
    const handler = () => { void pollApprovals(); };
    const wsEvents = ['o8:inbox', 'o8:realtime'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    approvalPollRef.current = setInterval(pollApprovals, 120_000); // 2min resilience fallback
    return () => {
      for (const e of wsEvents) window.removeEventListener(e, handler);
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
        background: '#ffffff',
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
        name="agentPanelAttachments"
        aria-label="Attach files"
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
            activeChips={activeChips}
            emptyStateLabel={pickerEmptyStateLabel}
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

      {!workspaceScopeProvided && missingSelectedSession && fallbackLiveSession ? (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: 'rgba(239, 68, 68, 0.06)',
          borderBottom: '1px solid rgba(239, 68, 68, 0.12)',
          fontSize: 11,
          color: '#b91c1c',
          fontWeight: 600,
          marginTop: !wsConnected ? 0 : headerOverlayHeight,
        }}>
          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
            {connectionState === 'connected'
              ? `Lane missing. Jump to ${fallbackLiveSession.name} or refresh the workspace snapshot.`
              : 'Recovering lane. The last selected lane is waiting for the runtime inventory to return.'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => handleSessionFocus(fallbackLiveSession.sessionKey)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                borderRadius: 999,
                background: 'rgba(185, 28, 28, 0.1)',
                color: '#b91c1c',
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              Open live lane
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                borderRadius: 999,
                background: 'rgba(185, 28, 28, 0.1)',
                color: '#b91c1c',
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 700,
                fontFamily: '-apple-system, system-ui, sans-serif',
              }}
            >
              Reload
            </button>
          </div>
        </div>
      ) : null}

      <AnimatePresence initial={false} mode="wait">
        {showWorkspaceEmptyState || showLaneWaitingState ? (
          <motion.div
            key="chat-empty"
            initial={{ opacity: 0, y: 10, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.992 }}
            transition={EMPTY_STATE_SPRING}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: wsConnected ? headerOverlayHeight + 8 : 12,
            }}
          >
            <ChatEmptyState
              scopeLabel={chatEmptyCopy.scopeLabel}
              title={chatEmptyCopy.title}
              body={chatEmptyCopy.body}
              primaryActionLabel={chatEmptyCopy.primaryActionLabel}
              onPrimaryAction={chatEmptyCopy.primaryActionLabel ? () => setPickerOpen(true) : undefined}
              prompts={chatEmptyCopy.prompts}
              onPromptSelect={handleEmptyStatePromptSelect}
            />
          </motion.div>
        ) : showLaneRecoveringState ? (
          <motion.div
            key="chat-recovering"
            initial={{ opacity: 0, y: 10, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.992 }}
            transition={EMPTY_STATE_SPRING}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: wsConnected ? headerOverlayHeight + 8 : 12,
              paddingRight: 18,
              paddingBottom: 18,
              paddingLeft: 18,
            }}
          >
            <div
              className="remodex-loading-card"
              style={{
                maxWidth: 320,
                textAlign: 'center',
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--t-text)' }}>
                Recovering lane
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-text-muted)' }}>
                This lane is reattaching to the workspace after restore. Hold here until the runtime inventory settles.
              </div>
            </div>
          </motion.div>
        ) : showLaneMissingState ? (
          <motion.div
            key="chat-missing"
            initial={{ opacity: 0, y: 10, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.992 }}
            transition={EMPTY_STATE_SPRING}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: wsConnected ? headerOverlayHeight + 8 : 12,
              paddingRight: 18,
              paddingBottom: 18,
              paddingLeft: 18,
            }}
          >
            <div
              className="remodex-loading-card"
              style={{
                maxWidth: 320,
                textAlign: 'center',
                lineHeight: 1.6,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--t-text)' }}>
                Lane missing
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-text-muted)' }}>
                The selected lane no longer has a live workspace binding. Re-focus a live lane or relaunch it from Thoughts.
              </div>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="chat-live"
            initial={{ opacity: 0, y: 10, scale: 0.992 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.992 }}
            transition={EMPTY_STATE_SPRING}
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>
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
