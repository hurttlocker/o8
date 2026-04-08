'use client';
/* eslint-disable @next/next/no-img-element -- transcript media here intentionally renders raw URLs from mixed runtimes */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSharedDesktopWs } from '../hooks/DesktopWebSocketContext';
import type { DesktopWsCallbacks } from '../hooks/useDesktopWebSocket';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
  MobileTranscriptToolCall,
} from '@/lib/mobile/types';
import { buildProjectGroups } from '@/components/mobile/utils';
import { DiffModal } from '../DiffModal';
import {
  deriveSidebarRuntimeCapabilities,
  type SidebarRuntimeCapabilities,
} from '@/lib/chat/sidebar-events';
import {
  getSlashCommandSuggestions,
  isSlashCommandText,
  autocompleteSlashCommand,
  buildSlashTerminalInput,
} from '@/lib/slash-commands';
import {
  orchestratorRuntimeTone,
  orchestratorStatusTone,
} from '@/lib/orchestrator/display';

import { EMPTY_STATE_SPRING, SIDEBAR_KEYFRAME_STYLES } from './constants';
import type { AgentPanelChatProps, SessionPickerChip, SessionPickerChipTone, SessionSummary, SidebarApproval } from './types';
import {
  snapshotFp,
  sessionsFp,
  updateTranscriptEntry,
  getAgentName,
  sessionHeaderTitle,
  sessionPickerChips,
  sessionTaskLabel,
  buildPickerFallbackSnapshot,
  buildChatStarterPrompts,
  resolveChatScopeLabel,
  compactChatScopeLabel,
  advanceToolStack,
  activityToLiveToolCall,
  lastTurnToolCalls,
  dedupeTranscriptEntries,
  mergeTranscriptEntries,
} from './shared';
import { DesktopChatHeader } from './DesktopChatHeader';
import { DesktopTranscriptPane } from './TranscriptPane';
import { DesktopComposePane } from './ComposePane';
import { ChatEmptyState } from './ChatEmptyState';

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
}: AgentPanelChatProps = {}) {
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
    if (selectedSession) lastHeaderSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => {
    if (effectiveSessions.length > 0) lastNonEmptySessionsRef.current = effectiveSessions;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only auto-select when sessions change
  }, [effectiveSessions, snapshot?.primarySessionKey]);

  const streamingTextRef = useRef('');

  useEffect(() => { selectedKeyRef.current = selectedKey; }, [selectedKey]);
  useEffect(() => { initialInboxReadyRef.current = false; }, []);

  // ── WebSocket -- real-time updates ──
  const wsCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onChatDelta: (text: string) => {
      streamingTextRef.current = text;
      setStreamingText(text);
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
      if (text) {
        setTranscript(prev => {
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
    return () => { sendTerminalDetach(selectedSession.tmuxSession!); };
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
    selectedKey && !selectedSession && !loading && stablePickerSessions.length > 0,
  );
  const laneTranscriptState = useMemo(() => {
    if (workspaceLane?.transcriptState) {
      if (workspaceLane.transcriptState === 'ready' && loading && transcript.length === 0) return 'waiting_activity';
      return workspaceLane.transcriptState;
    }
    if (selectedOrchestratorPacket?.status === 'recovering') return 'recovering';
    if (missingSelectedSession) return 'missing';
    if (workspaceScopeProvided && !selectedSession && effectiveSessions.length === 0) return 'no_lane';
    if ((selectedSession || selectedOrchestratorPacket) && loading && transcript.length === 0) return 'waiting_activity';
    return 'ready';
  }, [effectiveSessions.length, loading, missingSelectedSession, selectedOrchestratorPacket, selectedSession, transcript.length, workspaceLane, workspaceScopeProvided]);

  const pickerEmptyStateLabel = useMemo(
    () => (
      workspaceScopeProvided
        ? (laneTranscriptState === 'recovering' ? 'Recovering lane' : laneTranscriptState === 'missing' ? 'Lane missing' : laneTranscriptState === 'waiting_activity' ? 'Waiting for first activity' : 'Choose a lane to begin')
        : ((loading || connectionState !== 'connected' || stablePickerSessions.length > 0) ? 'Refreshing sessions...' : 'No IDE sessions yet')
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
  const chatEmptyCopy = useMemo(() => {
    const prompts = buildChatStarterPrompts(chatEmptyScopeLabel, chatEmptyTaskLabel, chatEmptyRepoLabel, showWorkspaceEmptyState);
    if (showWorkspaceEmptyState) {
      return { title: 'Pick a lane to anchor this chat', body: chatEmptyRepoLabel ? `Choose a lane first. I'll keep the draft attached to ${chatEmptyRepoLabel} once it is active.` : "Choose a lane first. I'll keep the draft attached to the active workspace once it is live.", primaryActionLabel: 'Choose a lane', scopeLabel: chatEmptyRepoLabel ?? null, prompts };
    }
    if (showLaneWaitingState) {
      return { title: chatEmptyTaskLabel ? `Ready for ${chatEmptyTaskLabel}` : chatEmptyScopeLabel ? `Ready for ${chatEmptyScopeLabel}` : 'Ready when you are', body: chatEmptyTaskLabel && chatEmptyScopeLabel ? `I'll keep replies scoped to ${chatEmptyScopeLabel} and surface the next useful move for ${chatEmptyTaskLabel}.` : chatEmptyScopeLabel ? `I'll keep replies scoped to ${chatEmptyScopeLabel} and surface the next useful move as soon as activity lands.` : "I'll keep replies scoped to the active lane and surface the next useful move as soon as activity lands.", scopeLabel: chatEmptyScopeLabel ?? chatEmptyRepoLabel, prompts };
    }
    return { title: 'Ready when you are', body: chatEmptyScopeLabel ? `I'll keep replies scoped to ${chatEmptyScopeLabel}.` : "Start with a prompt and I'll keep replies scoped once a lane is active.", scopeLabel: chatEmptyScopeLabel ?? chatEmptyRepoLabel, prompts };
  }, [chatEmptyRepoLabel, chatEmptyScopeLabel, chatEmptyTaskLabel, showLaneWaitingState, showWorkspaceEmptyState]);

  const handleEmptyStatePromptSelect = useCallback((prompt: { text: string }) => {
    setDraft(prompt.text);
    composeRef.current?.focus();
    if (showWorkspaceEmptyState) setPickerOpen(true);
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
      if (workspaceLane.packet?.referenceLabel) chips.push({ label: workspaceLane.packet.referenceLabel, tone: 'blue' });
      if (runtimeTone) chips.push({ label: runtimeTone.label, tone: workspaceLane.runtime === 'claude-code' ? 'purple' : 'green' });
      if (statusTone) {
        const tone: SessionPickerChipTone = statusTone.label === 'Running' ? 'green' : statusTone.label === 'Review' ? 'purple' : statusTone.label === 'Blocked' ? 'red' : statusTone.label === 'Queued' || statusTone.label === 'Launching' ? 'blue' : 'slate';
        chips.push({ label: statusTone.label, tone });
      }
      return chips;
    }
    if (headerSession) return sessionPickerChips(headerSession);
    if (!selectedOrchestratorPacket) return [];
    const runtimeTone = orchestratorRuntimeTone(selectedOrchestratorPacket.runtime);
    const statusTone = orchestratorStatusTone(selectedOrchestratorPacket.status);
    const runtimeChipTone: SessionPickerChipTone = selectedOrchestratorPacket.runtime === 'claude-code' ? 'purple' : 'green';
    const statusChipTone: SessionPickerChipTone = statusTone.label === 'Running' ? 'green' : statusTone.label === 'Review' ? 'purple' : statusTone.label === 'Blocked' ? 'red' : statusTone.label === 'Queued' || statusTone.label === 'Launching' ? 'blue' : 'slate';
    return [
      { label: selectedOrchestratorPacket.referenceLabel, tone: 'blue' as SessionPickerChipTone },
      { label: runtimeTone.label, tone: runtimeChipTone },
      { label: statusTone.label, tone: statusChipTone },
    ];
  }, [headerSession, selectedOrchestratorPacket, workspaceLane]);

  const connectionDotColor = workspaceLane?.status
    ? orchestratorStatusTone(workspaceLane.status).dot
    : selectedOrchestratorPacket
      ? orchestratorStatusTone(selectedOrchestratorPacket.status).dot
      : headerSession?.status === 'running' ? '#34c759' : headerSession?.status === 'reviewing' ? '#ff9f0a' : '#8e8e93';

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
    requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });
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

      let didChange = false;
      setTranscript(prev => {
        const normalizedPrev = dedupeTranscriptEntries(prev);
        const optimistic = normalizedPrev.filter(m => m.id.startsWith('local-'));
        let realPrev = normalizedPrev.filter(m => !m.id.startsWith('local-'));

        if (realPrev.length === 0) {
          const initial = optimistic.length > 0 ? [...serverEntries, ...optimistic] : serverEntries;
          didChange = initial.length > 0;
          return dedupeTranscriptEntries(initial);
        }

        const lastRealId = realPrev[realPrev.length - 1]?.id;
        const serverIdx = serverEntries.findIndex(e => e.id === lastRealId);

        let newFromServer: MobileTranscriptEntry[] = [];
        if (serverIdx >= 0) {
          newFromServer = serverEntries.slice(serverIdx + 1);
        } else {
          const existingIds = new Set(realPrev.map(e => e.id));
          newFromServer = serverEntries.filter(e => !existingIds.has(e.id));
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

        const serverTexts = new Set(
          [...realPrev, ...newFromServer].filter(e => !e.id.startsWith('local-') && !e.id.startsWith('ws:')).map(e => e.text)
        );
        const wsInjected = realPrev.filter(e => e.id.startsWith('ws:'));
        if (wsInjected.length > 0 && newFromServer.length > 0) {
          const wsTexts = new Set(wsInjected.map(e => e.text));
          const serverHasWs = newFromServer.some(e => wsTexts.has(e.text));
          if (serverHasWs) {
            realPrev = realPrev.filter(e => !e.id.startsWith('ws:') || !serverTexts.has(e.text));
          }
        }
        const pendingOptimistic = optimistic.filter(m => !serverTexts.has(m.text));

        if (newFromServer.length === 0 && pendingOptimistic.length === optimistic.length) return normalizedPrev;

        didChange = newFromServer.length > 0;
        const merged = mergeTranscriptEntries(realPrev, newFromServer);
        return pendingOptimistic.length > 0
          ? dedupeTranscriptEntries([...merged, ...pendingOptimistic])
          : merged;
      });
      setLoading(false);
      if (didChange && stickToBottomRef.current) scrollToBottom();
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
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPendingFiles(prev => [...prev, { name: file.name, mimeType: file.type || 'application/octet-stream', content: base64, preview }]);
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

  const handleDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); }, []);
  const handleDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); }, []);
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files); }, [processFiles]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') { const file = items[i].getAsFile(); if (file) files.push(file); }
      }
      if (files.length > 0) processFiles(files);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [processFiles]);

  const playSendSound = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(1800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);
      osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.06);
    } catch { /* silent */ }
  }, []);

  // ── Send to Claude Code / Codex ──
  const sendToClaudeCode = useCallback(async (text: string) => {
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;
    const assistantId = `claude-${Date.now()}`;
    setTranscript(prev => [...prev, { id: assistantId, role: 'assistant' as const, text: '', timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
    setAgentRunning(true); liveToolCallsRef.current = []; setActiveToolCalls([]);
    try {
      const res = await fetch('/api/claude-code/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, cwd, sessionId: claudeSessionIdRef.current }) });
      if (!res.ok || !res.body) { setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${res.statusText}` })); return; }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let accumulated = ''; let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { type: string; text?: string; name?: string; sessionId?: string; exitCode?: number };
            if (event.type === 'delta' && event.text) { accumulated += event.text; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated })); scrollToBottom(false); }
            if (event.type === 'tool' && event.name) { const nextTools = advanceToolStack(liveToolCallsRef.current, event.name); liveToolCallsRef.current = nextTools; setActiveToolCalls(nextTools); setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated, toolCalls: nextTools })); }
            if (event.type === 'done' || event.type === 'close') { const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const })); if (settledTools.length > 0) { liveToolCallsRef.current = settledTools; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { toolCalls: settledTools })); } if (event.sessionId) claudeSessionIdRef.current = event.sessionId; if (event.type === 'close' && event.text && !accumulated) { accumulated = event.text; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated })); } }
            if (event.type === 'error' && event.text) { accumulated += `\n${event.text}`; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated })); }
          } catch { /* skip */ }
        }
      }
    } catch (err) { setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${err instanceof Error ? err.message : 'unknown'}` })); }
    finally { setAgentRunning(false); liveToolCallsRef.current = []; setActiveToolCalls([]); }
  }, [effectiveSessions, selectedKey, scrollToBottom]);

  const sendToCodex = useCallback(async (text: string) => {
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);
    const cwd = session?.workspace || undefined;
    const assistantId = `codex-${Date.now()}`;
    setTranscript(prev => [...prev, { id: assistantId, role: 'assistant' as const, text: '', timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }]);
    setAgentRunning(true); liveToolCallsRef.current = []; setActiveToolCalls([]);
    try {
      const res = await fetch('/api/codex/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, cwd, threadId: codexThreadIdRef.current }) });
      if (!res.ok || !res.body) { setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${res.statusText}` })); return; }
      const reader = res.body.getReader(); const decoder = new TextDecoder(); let accumulated = ''; let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { type: string; text?: string; name?: string; threadId?: string };
            if (event.type === 'session' && event.threadId) codexThreadIdRef.current = event.threadId;
            if (event.type === 'delta' && event.text) { accumulated += event.text; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated })); scrollToBottom(false); }
            if (event.type === 'tool' && event.name) { const nextTools = advanceToolStack(liveToolCallsRef.current, event.name); liveToolCallsRef.current = nextTools; setActiveToolCalls(nextTools); setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated, toolCalls: nextTools })); }
            if ((event.type === 'done' || event.type === 'close') && event.threadId) codexThreadIdRef.current = event.threadId;
            if (event.type === 'done' || event.type === 'close') { const settledTools = liveToolCallsRef.current.map((tool) => ({ ...tool, status: 'done' as const })); if (settledTools.length > 0) { liveToolCallsRef.current = settledTools; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { toolCalls: settledTools })); } }
            if (event.type === 'error' && event.text) { accumulated += `\n${event.text}`; setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: accumulated })); }
          } catch { /* skip */ }
        }
      }
    } catch (err) { setTranscript(prev => updateTranscriptEntry(prev, assistantId, { text: `Error: ${err instanceof Error ? err.message : 'unknown'}` })); }
    finally { setAgentRunning(false); liveToolCallsRef.current = []; setActiveToolCalls([]); }
  }, [effectiveSessions, selectedKey, scrollToBottom]);

  const send = useCallback(async () => {
    if ((!draft.trim() && pendingFiles.length === 0) || !selectedKey || sending || !selectedSession?.runtimeSurface?.capabilities.sendInput) return;
    const text = draft.trim(); const files = [...pendingFiles];
    const relaySlashToTerminal = Boolean(text && files.length === 0 && isSlashCommandText(text) && supportsSlashTerminalRelay && selectedSession?.tmuxSession);
    setDraft(''); setPendingFiles([]); setSending(true); liveToolCallsRef.current = []; setActiveToolCalls([]); playSendSound();
    const optimisticText = files.length > 0 ? `${text}${text ? '\n' : ''}${files.map(f => f.name).join(', ')}` : text;
    const optimistic: MobileTranscriptEntry = { id: `local-${Date.now()}`, role: 'user', text: optimisticText, timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
    setTranscript(prev => [...prev, optimistic]); scrollToBottom(true);
    try {
      if (relaySlashToTerminal && selectedSession?.tmuxSession) {
        sendTerminalAttach(selectedSession.tmuxSession, 120, 32);
        await new Promise((resolve) => setTimeout(resolve, 120));
        sendTerminalInput(selectedSession.tmuxSession, buildSlashTerminalInput(text));
        return;
      }
      if (isClaudeCode) { await sendToClaudeCode(text); }
      else if (isCodexLocal) { await sendToCodex(text); }
      else {
        const payload: Record<string, unknown> = { sessionKey: selectedKey, action: 'steer', message: text || (files.length > 0 ? `[${files.map(f => f.name).join(', ')}]` : '') };
        if (files.length > 0) payload.attachments = files.map(f => ({ mimeType: f.mimeType, fileName: f.name, content: f.content }));
        fetch('/api/mobile/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
      }
    } catch { /* silent */ }
    finally { files.forEach(f => { if (f.preview) URL.revokeObjectURL(f.preview); }); setSending(false); }
  }, [draft, pendingFiles, selectedKey, sending, isClaudeCode, isCodexLocal, sendTerminalAttach, sendTerminalInput, supportsSlashTerminalRelay, selectedSession, sendToClaudeCode, sendToCodex, scrollToBottom, playSendSound]);

  const stopRun = useCallback(async () => {
    if (!selectedKey || stopping) return;
    setStopping(true);
    try {
      await fetch('/api/mobile/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionKey: selectedKey, action: 'stop' }) });
      setTimeout(() => void fetchTranscript(selectedKey), 1000);
    } catch { /* silent */ }
    finally { setStopping(false); setAgentRunning(false); }
  }, [selectedKey, stopping, fetchTranscript]);

  useEffect(() => {
    if (transcript.length === 0) { setAgentRunning(false); return; }
    const last = transcript[transcript.length - 1];
    if ((last.role === 'user' || last.id.startsWith('local-')) && !isSlashCommandText(last.text)) setAgentRunning(true);
    else setAgentRunning(false);
  }, [transcript]);

  useEffect(() => {
    if (agentRunning || streamingText) return;
    liveToolCallsRef.current = []; setActiveToolCalls([]);
  }, [agentRunning, streamingText]);

  useEffect(() => {
    async function fetchDiffStats() {
      try {
        const res = await fetch('/api/review/workspace'); if (!res.ok) return;
        const data = await res.json(); const files = data.changedFiles ?? [];
        setDiffStats({ additions: files.reduce((s: number, f: { additions?: number }) => s + (f.additions ?? 0), 0), deletions: files.reduce((s: number, f: { deletions?: number }) => s + (f.deletions ?? 0), 0), files: files.length });
      } catch { /* silent */ }
    }
    void fetchDiffStats();
    const handler = () => { void fetchDiffStats(); };
    const wsEvents = ['o8:agent-lifecycle', 'o8:lane-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(fetchDiffStats, wsConnected ? 300_000 : 30_000);
    return () => { clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [wsConnected]);

  useEffect(() => {
    if (workspaceScopeProvided && workspaceLane) {
      if (workspaceLane.sessionKey) {
        if (workspaceLane.sessionKey !== lastAppliedExternalSessionKeyRef.current) { lastAppliedExternalSessionKeyRef.current = workspaceLane.sessionKey; setSelectedKey(workspaceLane.sessionKey); }
      } else if (workspaceLane.transcriptState !== 'missing' && selectedKey) { lastAppliedExternalSessionKeyRef.current = ''; setSelectedKey(''); setTranscript([]); }
      return;
    }
    if (!externalSessionKey) return;
    if (workspaceScopeProvided && !effectiveSessions.some((session) => session.sessionKey === externalSessionKey)) return;
    if (externalSessionKey !== lastAppliedExternalSessionKeyRef.current) { lastAppliedExternalSessionKeyRef.current = externalSessionKey; setSelectedKey(externalSessionKey); }
  }, [effectiveSessions, externalSessionKey, selectedKey, workspaceLane, workspaceScopeProvided]);

  useEffect(() => {
    if (!draftInjection?.id) return;
    setDraft((prev) => prev.trim() ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n` : `${draftInjection.text}\n\n`);
    requestAnimationFrame(() => composeRef.current?.focus());
  }, [draftInjection?.id, draftInjection?.text]);

  const enhance = useCallback(async () => {
    if (!draft.trim() || enhancing) return;
    setEnhancing(true);
    try {
      const res = await fetch('/api/mobile/enhance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: draft }) });
      if (res.ok) { const data = await res.json(); if (data.enhanced) setDraft(data.enhanced); }
    } catch { /* silent */ }
    finally { setEnhancing(false); }
  }, [draft, enhancing]);

  const handleSessionFocus = useCallback((sessionKey: string) => {
    const session = effectiveSessions.find(s => s.sessionKey === sessionKey);
    if (session) { setSelectedKey(session.sessionKey); onSelectSession?.(session.sessionKey); }
  }, [effectiveSessions, onSelectSession]);

  useEffect(() => {
    const session = effectiveSessions.find(s => s.sessionKey === selectedKey);
    claudeSessionIdRef.current = undefined; codexThreadIdRef.current = undefined;
    if (!session) return;
    if (session.runtime === 'claude-code' && session.sessionKey.startsWith('claude-code:')) claudeSessionIdRef.current = session.sessionKey.replace('claude-code:', '');
    if (session.runtime === 'codex' && session.sessionKey.startsWith('codex:')) codexThreadIdRef.current = session.sessionKey.replace('codex:', '');
  }, [effectiveSessions, selectedKey]);

  useEffect(() => { void fetchSessions(); }, [fetchSessions]);
  useEffect(() => {
    const handler = () => { void fetchSessions(); };
    const wsEvents = ['o8:inbox', 'o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(() => void fetchSessions(), wsConnected ? 120_000 : 8_000);
    return () => { clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [fetchSessions, wsConnected]);

  useEffect(() => {
    if (selectedKey) { setLoading(true); setTranscript([]); liveToolCallsRef.current = []; setActiveToolCalls([]); seenIdsRef.current.clear(); void fetchTranscript(selectedKey); }
  }, [selectedKey, fetchTranscript]);

  useEffect(() => {
    if (!selectedKey) return;
    const handler = () => { void fetchTranscript(selectedKey); };
    const wsEvents = ['o8:agent-lifecycle'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    const fallbackId = setInterval(() => void fetchTranscript(selectedKey), wsConnected ? 120_000 : 15_000);
    return () => { clearInterval(fallbackId); for (const e of wsEvents) window.removeEventListener(e, handler); };
  }, [selectedKey, fetchTranscript, wsConnected]);

  useEffect(() => {
    const pollApprovals = async () => {
      try {
        const res = await fetch('/api/panel/approvals'); if (!res.ok) return;
        const data = await res.json() as { approvals?: SidebarApproval[] };
        setApprovals((data.approvals ?? []).filter((approval) => approval.sessionKey === selectedKey));
      } catch { /* silent */ }
    };
    if (!selectedKey) { setApprovals([]); return; }
    void pollApprovals();
    const handler = () => { void pollApprovals(); };
    const wsEvents = ['o8:inbox', 'o8:realtime'];
    for (const e of wsEvents) window.addEventListener(e, handler);
    approvalPollRef.current = setInterval(pollApprovals, 120_000);
    return () => { for (const e of wsEvents) window.removeEventListener(e, handler); if (approvalPollRef.current) clearInterval(approvalPollRef.current); };
  }, [selectedKey]);

  const handleApprovalResolve = useCallback(async (id: string, action: 'approve' | 'reject', strategy?: string) => {
    setResolvingApprovalId(id);
    try {
      const payload: Record<string, string> = { id, action };
      if (strategy) payload.strategy = strategy;
      const res = await fetch('/api/panel/approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) setApprovals((prev) => prev.filter((approval) => approval.id !== id));
    } catch { /* silent */ }
    finally { setResolvingApprovalId(null); }
  }, []);

  useEffect(() => { if (!pickerOpen) setExpandedGroup(null); }, [pickerOpen]);
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => { if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false); };
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

  const getIsNewEntry = useCallback((entryId: string) => {
    const isNew = !seenIdsRef.current.has(entryId);
    if (isNew) queueMicrotask(() => seenIdsRef.current.add(entryId));
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
        minHeight: 0,
        background: '#ffffff',
        position: 'relative',
        outline: dragOver ? '2px solid #3b82f6' : 'none',
        outlineOffset: -2,
      ['--remodex-compose-active' as string]: '0',
      ['--remodex-dock-fade-progress' as string]: '0',
      ['--remodex-dock-motion-progress' as string]: '0',
    }}>
      {dragOver && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(59, 130, 246, 0.08)', backdropFilter: 'blur(4px)', pointerEvents: 'none' }}>
          <div style={{ paddingTop: 16, paddingRight: 32, paddingBottom: 16, paddingLeft: 32, borderRadius: 16, background: 'var(--t-panel-translucent)', border: '2px dashed #3b82f6', fontSize: 15, fontWeight: 600, color: '#3b82f6' }}>
            Drop files here
          </div>
        </div>
      )}

      <input ref={fileInputRef} name="agentPanelAttachments" aria-label="Attach files" type="file" multiple accept="image/*,.pdf,.txt,.md,.json,.csv,.tsx,.ts,.js,.py" style={{ display: 'none' }} onChange={(e) => { if (e.target.files) processFiles(e.target.files); e.target.value = ''; }} />

      <div style={{ position: 'absolute', top: 0, left: 0, right: headerScrollbarGutter, zIndex: 20, pointerEvents: 'none' }}>
        <div style={{ pointerEvents: 'auto' }}>
          <DesktopChatHeader pickerRef={pickerRef} pickerOpen={pickerOpen} setPickerOpen={setPickerOpen} projectGroups={projectGroups} selectedSession={selectedSession} activeTitle={activeTitle} activeChips={activeChips} emptyStateLabel={pickerEmptyStateLabel} connectionDotColor={connectionDotColor} handleSessionFocus={handleSessionFocus} expandedGroup={expandedGroup} setExpandedGroup={setExpandedGroup} diffStats={diffStats} onOpenDiff={onOpenDiff} setDiffOpen={setDiffOpen} />
        </div>
      </div>

      {!wsConnected && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '6px 12px', background: 'rgba(245, 158, 11, 0.06)', borderBottom: '1px solid rgba(245, 158, 11, 0.12)', fontSize: 11, color: '#d97706', fontWeight: 500, marginTop: headerOverlayHeight }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#d97706', animation: 'reviewingBreathe 2s ease-in-out infinite' }} />
          Reconnecting to gateway...
        </div>
      )}

      {!workspaceScopeProvided && missingSelectedSession && fallbackLiveSession ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between', padding: '8px 12px', background: 'rgba(239, 68, 68, 0.06)', borderBottom: '1px solid rgba(239, 68, 68, 0.12)', fontSize: 11, color: '#b91c1c', fontWeight: 600, marginTop: !wsConnected ? 0 : headerOverlayHeight }}>
          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
            {connectionState === 'connected' ? `Lane missing. Jump to ${fallbackLiveSession.name} or refresh the workspace snapshot.` : 'Recovering lane. The last selected lane is waiting for the runtime inventory to return.'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button type="button" onClick={() => handleSessionFocus(fallbackLiveSession.sessionKey)} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', borderRadius: 999, background: 'rgba(185, 28, 28, 0.1)', color: '#b91c1c', padding: '4px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 700, fontFamily: '-apple-system, system-ui, sans-serif' }}>
              Open live lane
            </button>
            <button type="button" onClick={() => window.location.reload()} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', borderRadius: 999, background: 'rgba(185, 28, 28, 0.1)', color: '#b91c1c', padding: '4px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 700, fontFamily: '-apple-system, system-ui, sans-serif' }}>
              Reload
            </button>
          </div>
        </div>
      ) : null}

      <AnimatePresence initial={false} mode="wait">
        {showWorkspaceEmptyState || showLaneWaitingState ? (
          <motion.div key="chat-empty" initial={{ opacity: 0, y: 10, scale: 0.992 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.992 }} transition={EMPTY_STATE_SPRING} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: wsConnected ? headerOverlayHeight + 8 : 12 }}>
            <ChatEmptyState scopeLabel={chatEmptyCopy.scopeLabel} title={chatEmptyCopy.title} body={chatEmptyCopy.body} primaryActionLabel={chatEmptyCopy.primaryActionLabel} onPrimaryAction={chatEmptyCopy.primaryActionLabel ? () => setPickerOpen(true) : undefined} prompts={chatEmptyCopy.prompts} onPromptSelect={handleEmptyStatePromptSelect} />
          </motion.div>
        ) : showLaneRecoveringState ? (
          <motion.div key="chat-recovering" initial={{ opacity: 0, y: 10, scale: 0.992 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.992 }} transition={EMPTY_STATE_SPRING} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: wsConnected ? headerOverlayHeight + 8 : 12, paddingRight: 18, paddingBottom: 18, paddingLeft: 18 }}>
            <div className="remodex-loading-card" style={{ maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--t-text)' }}>Recovering lane</div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-text-muted)' }}>This lane is reattaching to the workspace after restore. Hold here until the runtime inventory settles.</div>
            </div>
          </motion.div>
        ) : showLaneMissingState ? (
          <motion.div key="chat-missing" initial={{ opacity: 0, y: 10, scale: 0.992 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.992 }} transition={EMPTY_STATE_SPRING} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: wsConnected ? headerOverlayHeight + 8 : 12, paddingRight: 18, paddingBottom: 18, paddingLeft: 18 }}>
            <div className="remodex-loading-card" style={{ maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
              <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--t-text)' }}>Lane missing</div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--t-text-muted)' }}>The selected lane no longer has a live workspace binding. Re-focus a live lane or relaunch it from Thoughts.</div>
            </div>
          </motion.div>
        ) : (
          <motion.div key="chat-live" initial={{ opacity: 0, y: 10, scale: 0.992 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -10, scale: 0.992 }} transition={EMPTY_STATE_SPRING} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <DesktopTranscriptPane loading={loading} transcript={transcript} currentAgentName={currentAgentName} onOpenMermaid={onOpenMermaid} onRunInTerminal={onRunInTerminal} streamingText={streamingText} agentRunning={agentRunning} activityHeadline={liveActivityHeadline} liveToolCalls={liveToolCalls} onOpenDiff={onOpenDiff ? onOpenDiff : () => setDiffOpen(true)} onOpenFile={onOpenFile} currentWorkspace={selectedSession?.workspace} runtimeCapabilities={sidebarCapabilities} approvals={approvals} resolvingApprovalId={resolvingApprovalId} onResolveApproval={handleApprovalResolve} scrollRef={scrollRef} handleScroll={handleScroll} showScrollPill={showScrollPill} scrollToBottom={scrollToBottom} getIsNewEntry={getIsNewEntry} topInset={wsConnected ? headerOverlayHeight + 8 : 12} />
            <div onMouseDown={(e) => { e.preventDefault(); const startY = e.clientY; const startH = composeHeight; const onMove = (ev: MouseEvent) => { const delta = startY - ev.clientY; setComposeHeight(Math.min(Math.max(startH + delta, 60), 400)); }; const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }; document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp); }} style={{ height: 8, cursor: 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'var(--t-divider)', transition: 'background-color 150ms' }} />
            </div>
            <DesktopComposePane pendingFiles={pendingFiles} removePendingFile={removePendingFile} selectedSession={selectedSession} composeRef={composeRef} draft={draft} setDraft={setDraft} showSlashSuggestions={showSlashSuggestions} slashSuggestions={slashSuggestions} composeHeight={composeHeight} currentAgentName={currentAgentName} send={send} fileInputRef={fileInputRef} enhancing={enhancing} enhance={enhance} agentRunning={agentRunning} streamingText={streamingText} sending={sending} stopping={stopping} stopRun={stopRun} chatSendDisabled={chatSendDisabled} canInterruptSelected={canInterruptSelected} />
          </motion.div>
        )}
      </AnimatePresence>
      {diffOpen ? <DiffModal onClose={() => setDiffOpen(false)} /> : null}
      <style>{SIDEBAR_KEYFRAME_STYLES}</style>
    </div>
  );
}
