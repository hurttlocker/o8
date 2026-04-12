'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import { DesktopAgentMessage } from '../DesktopAgentMessage';
import type {
  OrchestratorMissionState,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { InputButtons, type ThinkingEffort } from './InputButtons';
import { CheckIcon } from './ThoughtsIcons';
import type { AgentTarget, FleetAgent } from './types';
import {
  createDraftPacket,
  entrySignature,
  generateSuggestions,
  isRenderableThoughtEntry,
  packetTitleFromPrompt,
  pickWorkspaceTargetForText,
  isRunnableCliSession,
  mergeTranscriptEntries,
} from './utils';
import { useOrchestratorStream } from './useOrchestratorStream';

export interface ThoughtsChatPanelHandle {
  focusInput: () => void;
  reset: () => void;
  loadThread: (tabId: string) => void;
  /**
   * Append a system-role message to the chat stream without going
   * through the orchestrator. Used for in-app echoes like mission
   * dispatch notifications — Phase 5 cross-tile bus wires this to
   * postSystemMessageToChat.
   */
  appendSystemMessage: (text: string) => void;
  /**
   * Replace the current input field contents. Used by parent empty-state
   * components (e.g. Orchestrator quick-action cards) to prefill the
   * composer without auto-sending.
   */
  fillInput: (text: string) => void;
  /**
   * Fire a send with optional pre-fill. If `text` is provided, replaces
   * the input first then sends. Used by Orchestrator quick-action cards
   * that click-to-dispatch.
   */
  sendNow: (text?: string) => void;
}

export interface ThoughtsChatPanelChromeState {
  activeTargetLabel: string;
  waitingForReply: boolean;
  hasMessages: boolean;
  threadId: string | null;
}

export type ThoughtsChatPermissionMode = 'full' | 'plan';

export const ThoughtsChatPanel = forwardRef<ThoughtsChatPanelHandle, {
  open: boolean;
  draftInjection?: { id: string; text: string } | null;
  agents: FleetAgent[];
  missionState: OrchestratorMissionState;
  preferredRuntime: OrchestratorRuntime;
  sessionTargets: AgentTarget[];
  workspaceTargets: OrchestratorWorkspaceTarget[];
  repoPath?: string | null;
  thoughtsBodyBackground: string;
  thoughtsElevatedSurface: string;
  thoughtsElevatedBorder: string;
  thoughtsElevatedShadow: string;
  thoughtsMutedGlass: string;
  /**
   * Per-message permission mode passed to the orchestrator. 'full' keeps
   * the legacy --dangerously-skip-permissions behavior; 'plan' swaps in
   * --permission-mode plan so writes must be user-approved. Defaults to
   * 'full' to match legacy callers that don't pass the prop.
   */
  permissionMode?: ThoughtsChatPermissionMode;
  /** Callback to toggle permission mode (full ↔ plan). */
  onTogglePermission?: () => void;
  /** Whether the issues/mission sidebar is open. */
  missionOpen?: boolean;
  /** Toggle the issues/mission sidebar. */
  onToggleMission?: () => void;
  /** Repo label shown in input toolbar as focus indicator. */
  repoLabel?: string | null;
  /**
   * Optional custom empty-state render. When provided and the chat has
   * no messages, this replaces the built-in "Claude Code" welcome card.
   * Use the imperative handle's `fillInput` / `sendNow` to wire quick
   * actions in the override back into the composer.
   */
  emptyStateOverride?: React.ReactNode;
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: import('@/lib/orchestrator/types').OrchestratorPacket) => void;
  onChromeChange: (state: ThoughtsChatPanelChromeState) => void;
}>(function ThoughtsChatPanel({
  open,
  draftInjection,
  agents,
  missionState,
  preferredRuntime,
  sessionTargets,
  workspaceTargets,
  repoPath: repoPathProp,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  thoughtsMutedGlass,
  permissionMode = 'full',
  onTogglePermission,
  missionOpen,
  onToggleMission,
  repoLabel,
  emptyStateOverride,
  onMissionStateChange,
  onLaunchPacket,
  onChromeChange,
}, ref) {
  const [input, setInput] = useState('');
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [thinkingEffort, setThinkingEffort] = useState<ThinkingEffort>('max');
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<MobileTranscriptEntry[]>([]);
  const [injectedSystemMessages, setInjectedSystemMessages] = useState<MobileTranscriptEntry[]>([]);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [targetAgentKey, setTargetAgentKey] = useState<string>('__claude__');
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const orchestratorHistoryRef = useRef<Array<{ role: string; content: string }>>([]);
  // Managed Claude Code orchestrator session — spawned on first message
  const orchestratorSessionRef = useRef<string | null>(null);
  const [orchestratorSpawning, setOrchestratorSpawning] = useState(false);
  // Thread persistence — each conversation gets a unique ID for history.
  // threadIdRef mirrors threadId synchronously so the first-message mint path
  // can't race setThreadId across rapid streaming effect runs (which was
  // creating orphan single-assistant-message files).
  const [threadId, setThreadId] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Resolved repo path for the orchestrator stream
  const [resolvedRepoPath, setResolvedRepoPath] = useState<string | null>(repoPathProp ?? null);

  // Claude Code CLI is the default orchestrator — API chat is secondary
  const isOrchestratorMode = targetAgentKey === '__claude__' || !sessionTargets.some((s) => s.key === targetAgentKey);

  // ── WebSocket orchestrator stream (real-time) ──
  const orchStream = useOrchestratorStream(isOrchestratorMode ? resolvedRepoPath : null);
  const useStream = orchStream.connected && isOrchestratorMode;

  const targetAgent = useMemo(
    () => isOrchestratorMode ? null : (sessionTargets.find((agent) => agent.key === targetAgentKey) ?? null),
    [isOrchestratorMode, sessionTargets, targetAgentKey],
  );
  const targetSessionKey = targetAgent?.key ?? null;

  // ── Resolve repo path for orchestrator stream ──
  useEffect(() => {
    if (repoPathProp) {
      setResolvedRepoPath(repoPathProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/panel/repos');
        if (res.ok && !cancelled) {
          const data = await res.json() as { repos?: Array<{ localPath: string }> };
          const path = data.repos?.[0]?.localPath ?? null;
          if (path) setResolvedRepoPath(path);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [repoPathProp]);

  // ── Pre-warm orchestrator session on mount ──
  useEffect(() => {
    if (!isOrchestratorMode || orchestratorSessionRef.current || orchestratorSpawning) return;

    let cancelled = false;
    (async () => {
      // Resolve repo path
      let repoPath = repoPathProp;
      if (!repoPath) {
        try {
          const res = await fetch('/api/panel/repos');
          if (res.ok) {
            const data = await res.json() as { repos?: Array<{ localPath: string }> };
            repoPath = data.repos?.[0]?.localPath ?? null;
          }
        } catch { /* silent */ }
      }
      if (!repoPath || cancelled) return;

      // Check if there's already a recent idle Claude Code session we can reuse
      try {
        const invRes = await fetch('/api/runtime/inventory?fresh=1');
        if (invRes.ok && !cancelled) {
          const invData = await invRes.json() as { agents?: Array<{ sessionKey: string; runtime: string; status: string; workspace: string }> };
          const existing = (invData.agents ?? []).find(
            (a) => a.runtime === 'claude-code' && (a.status === 'idle' || a.status === 'reviewing') && a.workspace?.includes(repoPath!),
          );
          if (existing) {
            orchestratorSessionRef.current = existing.sessionKey;
            console.log(`[thoughts] Pre-warm: reusing existing session ${existing.sessionKey}`);
            return;
          }
        }
      } catch { /* silent */ }

      // No existing session — spawn one with a minimal prompt
      if (cancelled) return;
      try {
        setOrchestratorSpawning(true);
        const launchRes = await fetch('/api/runtime/launch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runtime: 'claude-code',
            prompt: 'You are the orchestrator for Cortex IDE. Acknowledge ready.',
            repoPath,
            cwd: repoPath,
            skipSetup: true,
          }),
        });
        const data = await launchRes.json() as { ok?: boolean; surfaceId?: string };
        if (data.ok && data.surfaceId && !cancelled) {
          orchestratorSessionRef.current = data.surfaceId;
          console.log(`[thoughts] Pre-warm: spawned ${data.surfaceId}`);
        }
      } catch { /* silent */ } finally {
        if (!cancelled) setOrchestratorSpawning(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isOrchestratorMode, orchestratorSpawning, repoPathProp]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !draftInjection?.id) return;
    setInput((prev) => prev.trim()
      ? `${prev.trimEnd()}\n\n${draftInjection.text}\n\n`
      : `${draftInjection.text}\n\n`);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [draftInjection?.id, draftInjection?.text, open]);

  // Auto-scroll — RAF-batched to avoid forced layout during streaming
  useEffect(() => {
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    });
  }, [chatMessages, orchStream.messages]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
    };
  }, []);

  const clearPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollDelayRef.current !== null) {
      window.clearTimeout(pollDelayRef.current);
      pollDelayRef.current = null;
    }
  }, []);

  const transcriptUrl = useCallback((sessionKey: string) => {
    // Claude Code and Codex sessions use the runtime adapter transcript
    if (sessionKey.startsWith('claude-code:') || sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:') || sessionKey.startsWith('codex-discovered:')) {
      return `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=20`;
    }
    // Other session types fall back to the mobile history API.
    return `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=20&fresh=1`;
  }, []);

  const captureServerSnapshot = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetch(transcriptUrl(sessionKey));
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
      const nextSeen = new Map<string, string>();
      for (const entry of entries) {
        nextSeen.set(entry.id, entrySignature(entry));
      }
      seenServerEntriesRef.current = nextSeen;
    } catch {
      // silent
    }
  }, [transcriptUrl]);

  const startPollingForSession = useCallback((sessionKey: string) => {
    clearPolling();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;

    let attempts = 0;
    const maxAttempts = 60;

    const poll = async () => {
      attempts++;
      if (attempts > maxAttempts) {
        clearPolling();
        setWaitingForReply(false);
        return;
      }

      try {
        const res = await fetch(transcriptUrl(sessionKey));
        if (!res.ok) return;

        const data = await res.json();
        const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
        const nextSeen = new Map(seenServerEntriesRef.current);
        const incoming: MobileTranscriptEntry[] = [];

        for (const entry of entries) {
          const signature = entrySignature(entry);
          const previousSignature = nextSeen.get(entry.id);
          nextSeen.set(entry.id, signature);

          if (previousSignature === signature) continue;
          if (entry.role === 'user') continue;
          if (!isRenderableThoughtEntry(entry)) continue;
          incoming.push(entry);
        }

        seenServerEntriesRef.current = nextSeen;

        if (incoming.length > 0) {
          responseSeenRef.current = true;
          idlePollsRef.current = 0;
          setChatMessages((prev) => mergeTranscriptEntries(prev, incoming));
          return;
        }

        if (responseSeenRef.current) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 4) {
            clearPolling();
            setWaitingForReply(false);
          }
        }
      } catch {
        // silent retry
      }
    };

    pollDelayRef.current = window.setTimeout(() => {
      void poll();
      pollRef.current = window.setInterval(() => {
        void poll();
      }, 1200);
    }, 400);
  }, [clearPolling, transcriptUrl]);

  const startPolling = useCallback(() => {
    const sessionKey = isOrchestratorMode ? orchestratorSessionRef.current : targetSessionKey;
    if (!sessionKey) {
      setWaitingForReply(false);
      return;
    }
    startPollingForSession(sessionKey);
  }, [isOrchestratorMode, startPollingForSession, targetSessionKey]);

  const handleOrchestratorSend = useCallback(async (msg: string) => {
    setWaitingForReply(true);

    // If we already have a managed orchestrator session, resume it
    if (orchestratorSessionRef.current) {
      try {
        await captureServerSnapshot(orchestratorSessionRef.current);
        const res = await fetch('/api/runtime/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'steer',
            surfaceId: orchestratorSessionRef.current,
            message: msg,
          }),
        });
        if (!res.ok) throw new Error('Resume failed');
        startPollingForSession(orchestratorSessionRef.current);
        return;
      } catch {
        // Session may have died — try to re-spawn
        orchestratorSessionRef.current = null;
      }
    }

    // Spawn a new Claude Code session as the orchestrator
    setOrchestratorSpawning(true);
    try {
      // Resolve repo path — use prop, or fetch from repos API
      let resolvedRepoPath = repoPathProp;
      if (!resolvedRepoPath) {
        try {
          const reposRes = await fetch('/api/panel/repos');
          if (reposRes.ok) {
            const reposData = await reposRes.json() as { repos?: Array<{ localPath: string }> };
            resolvedRepoPath = reposData.repos?.[0]?.localPath ?? null;
          }
        } catch { /* silent */ }
      }

      const launchRes = await fetch('/api/runtime/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runtime: 'claude-code',
          prompt: msg,
          repoPath: resolvedRepoPath || undefined,
          cwd: resolvedRepoPath || undefined,
          skipSetup: true,
        }),
      });
      const launchData = await launchRes.json() as { ok?: boolean; surfaceId?: string; note?: string; error?: string };

      if (!launchData.ok || !launchData.surfaceId) {
        throw new Error(launchData.note ?? launchData.error ?? 'Failed to launch Claude Code session.');
      }

      console.log(`[thoughts] Orchestrator launch key: ${launchData.surfaceId}`);

      // Claude Code needs time to spawn and write JSONL
      await new Promise((resolve) => setTimeout(resolve, 6000));

      // The launch key may not match the actual JSONL session ID.
      // Try the launch key first, then discover the correct one.
      const candidateKeys = [launchData.surfaceId];

      // Also discover recent Claude Code sessions from the repo
      try {
        const invRes = await fetch('/api/runtime/inventory?fresh=1');
        if (invRes.ok) {
          const invData = await invRes.json() as { agents?: Array<{ sessionKey: string; runtime: string; lastEventAt: string; status: string }> };
          const ccRecent = (invData.agents ?? [])
            .filter((a) => a.runtime === 'claude-code' && a.sessionKey && a.sessionKey !== launchData.surfaceId)
            .sort((a, b) => (b.lastEventAt ?? '').localeCompare(a.lastEventAt ?? ''))
            .slice(0, 3);
          for (const a of ccRecent) {
            if (!candidateKeys.includes(a.sessionKey)) candidateKeys.push(a.sessionKey);
          }
        }
      } catch { /* silent */ }

      // Try each candidate — use the first one that has our message in its transcript
      let resolvedKey = launchData.surfaceId;
      for (const key of candidateKeys) {
        try {
          const txRes = await fetch(transcriptUrl(key));
          if (!txRes.ok) continue;
          const txData = await txRes.json() as { transcript?: MobileTranscriptEntry[] };
          const entries = txData.transcript ?? [];
          const hasOurMessage = entries.some((e) => e.role === 'user' && e.text === msg);
          if (hasOurMessage) {
            resolvedKey = key;
            const assistantEntries = entries.filter((e) => e.role !== 'user' && isRenderableThoughtEntry(e));
            if (assistantEntries.length > 0) {
              setChatMessages((prev) => mergeTranscriptEntries(prev, assistantEntries));
              const nextSeen = new Map<string, string>();
              for (const entry of entries) nextSeen.set(entry.id, entrySignature(entry));
              seenServerEntriesRef.current = nextSeen;
              setWaitingForReply(false);
              orchestratorSessionRef.current = resolvedKey;
              console.log(`[thoughts] Resolved session: ${resolvedKey} (response found)`);
              return;
            }
            break;
          }
        } catch { /* try next */ }
      }

      orchestratorSessionRef.current = resolvedKey;
      console.log(`[thoughts] Using session: ${resolvedKey}`);
      seenServerEntriesRef.current.clear();
      startPollingForSession(resolvedKey);
    } catch (err) {
      setChatMessages((prev) => [...prev, {
        id: `claude-error-${Date.now()}`,
        role: 'system',
        text: `Unable to launch Claude Code: ${(err as Error).message ?? 'Unknown error.'}`,
        timestamp: Date.now(),
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }]);
      setWaitingForReply(false);
    } finally {
      setOrchestratorSpawning(false);
    }
  }, [captureServerSnapshot, startPolling]);

  const handleTaskSend = useCallback(async () => {
    const effectiveWaiting = isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
    if (!input.trim() || effectiveWaiting) return;
    const msg = input.trim();
    setInput('');

    // Orchestrator mode: always route through WebSocket stream
    // The WS handler spawns the session if needed — no polling fallback
    if (isOrchestratorMode) {
      orchStream.send(msg, { permissionMode, thinkingEffort });
      return;
    }

    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: msg,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages((prev) => [...prev, userMsg]);

    if (isOrchestratorMode) {
      void handleOrchestratorSend(msg);
      return;
    }

    const sessionKey = targetSessionKey;
    if (!sessionKey) return;
    setWaitingForReply(true);

    try {
      await captureServerSnapshot(sessionKey);

      // Use the runtime adapter for all session types
      const isRuntimeSession = sessionKey.startsWith('claude-code:') || sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-owned:');
      const response = await fetch(isRuntimeSession ? '/api/runtime/action' : '/api/mobile/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: isRuntimeSession
          ? JSON.stringify({ action: 'steer', surfaceId: sessionKey, message: msg })
          : JSON.stringify({ action: 'resume', sessionKey, message: msg }),
      });

      if (!response.ok) {
        throw new Error('Send failed');
      }

      startPolling();
    } catch {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'system',
          text: 'Unable to reach the selected CLI lane. Make sure the Codex or Claude Code session is available.',
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      setWaitingForReply(false);
    }
  }, [captureServerSnapshot, handleOrchestratorSend, input, isOrchestratorMode, orchStream, startPolling, targetSessionKey, useStream, waitingForReply]);

  const handleSendAsTask = useCallback(() => {
    const prompt = input.trim();
    if (!prompt) {
      return;
    }

    const target = pickWorkspaceTargetForText(prompt, workspaceTargets);
    const packet = createDraftPacket('codex', workspaceTargets, missionState.packets, {
      title: packetTitleFromPrompt(prompt),
      summary: prompt,
      runtime: 'codex',
      workspaceTargetPath: target?.localPath ?? null,
      branchTarget: target?.branch ?? 'main',
      queueState: 'queued',
      status: 'queued',
    });

    onMissionStateChange((current) => ({
      ...current,
      packets: [...current.packets, packet],
    }));
    onLaunchPacket?.(packet);
    setInput('');
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
  }, [input, missionState.packets, onLaunchPacket, onMissionStateChange, workspaceTargets]);

  const handleReset = useCallback(() => {
    setInput('');
    setPreEnhanceInput(null);
    setChatMessages([]);
    setWaitingForReply(false);
    setAgentPickerOpen(false);
    clearPolling();
    seenServerEntriesRef.current.clear();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;
    orchestratorHistoryRef.current = [];
    orchStream.reset();
    threadIdRef.current = null;
    setThreadId(null);
    if (persistTimerRef.current) { clearTimeout(persistTimerRef.current); persistTimerRef.current = null; }
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [clearPolling, orchStream]);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.enhanced) setInput(data.enhanced);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput]);

  // ── Thread persistence ──

  const persistThread = useCallback((msgs: MobileTranscriptEntry[], tid: string | null) => {
    if (!tid || msgs.length === 0) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      const messages = msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.text,
        timestamp: m.timestamp ?? Date.now(),
      }));
      void fetch('/api/v2/chat-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tabId: tid,
          messages,
          model: 'claude-code',
          repoPath: resolvedRepoPath,
        }),
      }).catch(() => { /* silent */ });
    }, 800);
  }, [resolvedRepoPath]);

  // Auto-persist on message changes — merge historical + live in orchestrator mode
  useEffect(() => {
    let msgs: typeof chatMessages;
    if (isOrchestratorMode) {
      if (orchStream.messages.length > 0 && chatMessages.length > 0) {
        const seen = new Set(orchStream.messages.map((m) => m.timestamp));
        const historical = chatMessages.filter((m) => !seen.has(m.timestamp));
        msgs = [...historical, ...orchStream.messages];
      } else if (orchStream.messages.length > 0) {
        msgs = orchStream.messages;
      } else {
        msgs = chatMessages;
      }
    } else {
      msgs = chatMessages;
    }
    if (msgs.length === 0 || !isOrchestratorMode) return;

    // Never persist a thread that has no user message yet — the orchestrator
    // streams assistant messages in bursts and a bare assistant-only payload
    // with no threadId would mint a new "Untitled conversation" file every
    // time the effect re-fires. Real threads always start with a user turn.
    const hasUserMessage = msgs.some((m) => m.role === 'user');
    if (!hasUserMessage) return;

    // Create thread ID on first message if none exists. threadIdRef is
    // checked synchronously so rapid effect re-runs during streaming can't
    // each mint their own ID before setThreadId commits.
    if (!threadIdRef.current) {
      const newId = `thoughts-${Date.now()}`;
      threadIdRef.current = newId;
      setThreadId(newId);
      persistThread(msgs, newId);
    } else {
      persistThread(msgs, threadIdRef.current);
    }
  }, [chatMessages, orchStream.messages, isOrchestratorMode, persistThread]);

  // Auto-restore last orchestrator thread on mount (survives page reload)
  const autoRestoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (!isOrchestratorMode) return;
    if (autoRestoreAttemptedRef.current) return;
    if (orchStream.messages.length > 0 || chatMessages.length > 0) return;
    autoRestoreAttemptedRef.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/v2/chat-history/list');
        if (!res.ok) return;
        const data = await res.json() as { conversations?: Array<{ tabId: string; modifiedAt?: string }> };
        const thoughtsThreads = (data.conversations ?? [])
          .filter((t) => t.tabId.startsWith('thoughts-'))
          .sort((a, b) => new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime());
        if (thoughtsThreads.length > 0) {
          const latest = thoughtsThreads[0];
          const histRes = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(latest.tabId)}`);
          if (!histRes.ok) return;
          const histData = await histRes.json() as {
            messages?: Array<{ id: string; role: string; content: string; timestamp?: number }>;
          };
          const msgs = (histData.messages ?? []).map((m) => ({
            id: m.id,
            role: m.role as MobileTranscriptEntry['role'],
            text: m.content,
            timestamp: m.timestamp ?? Date.now(),
            timestampLabel: m.timestamp
              ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '',
          }));
          if (msgs.length > 0) {
            setChatMessages(msgs);
            threadIdRef.current = latest.tabId;
            setThreadId(latest.tabId);
          }
        }
      } catch {
        // silent — best-effort restore
      }
    })();
  }, [isOrchestratorMode, orchStream.messages.length, chatMessages.length]);

  const handleLoadThread = useCallback(async (tabId: string) => {
    try {
      const res = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(tabId)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        messages?: Array<{ id: string; role: string; content: string; timestamp?: number }>;
      };
      const msgs = (data.messages ?? []).map((m) => ({
        id: m.id,
        role: m.role as MobileTranscriptEntry['role'],
        text: m.content,
        timestamp: m.timestamp ?? Date.now(),
        timestampLabel: m.timestamp
          ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '',
      }));
      setChatMessages(msgs);
      threadIdRef.current = tabId;
      setThreadId(tabId);
      setWaitingForReply(false);
      clearPolling();
      orchStream.reset();
      seenServerEntriesRef.current.clear();
      orchestratorSessionRef.current = null;
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // silent
    }
  }, [clearPolling, orchStream]);

  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const targetAgentState = useMemo(
    () => targetAgent
      ? agents.find((agent) => agent.sessionKey === targetAgent.key || agent.name?.toLowerCase() === targetAgent.name.toLowerCase())
      : null,
    [agents, targetAgent],
  );
  const targetAgentModel = isOrchestratorMode
    ? (useStream ? 'Claude Code (live)' : (orchestratorSpawning ? 'Launching...' : (orchestratorSessionRef.current ? 'Claude Code' : 'Opus 4.6')))
    : (targetAgentState?.model ?? (targetAgent ? orchestratorRuntimeTone(targetAgent.runtime).label : orchestratorRuntimeTone(preferredRuntime).label));
  const targetAgentContext = isOrchestratorMode ? undefined : targetAgentState?.context?.usedPercent;
  const targetAgentTask = isOrchestratorMode ? null : (targetAgentState?.activity?.headline ?? targetAgentState?.currentTask);
  // Derive display state: in orchestrator mode, merge historical chatMessages
  // (loaded via handleLoadThread) with live orchStream.messages, deduplicating
  // by timestamp so sending a new message doesn't discard history.
  const displayMessages = useMemo(() => {
    let base: typeof chatMessages;
    if (isOrchestratorMode) {
      if (orchStream.messages.length > 0 && chatMessages.length > 0) {
        // Merge: historical first, then live, deduplicate by timestamp
        const seen = new Set(orchStream.messages.map((m) => m.timestamp));
        const historical = chatMessages.filter((m) => !seen.has(m.timestamp));
        base = [...historical, ...orchStream.messages];
      } else if (orchStream.messages.length > 0) {
        base = orchStream.messages;
      } else {
        base = chatMessages;
      }
    } else {
      base = chatMessages;
    }
    if (injectedSystemMessages.length === 0) return base;
    const merged = [...base, ...injectedSystemMessages];
    merged.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    return merged;
  }, [chatMessages, injectedSystemMessages, isOrchestratorMode, orchStream.messages]);
  const displayWaiting = isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
  const hasAssistantActivity = displayMessages.some((message) => message.role !== 'user');
  const activeTargetLabel = isOrchestratorMode ? 'Claude Code' : (targetAgent?.name ?? orchestratorRuntimeTone(preferredRuntime).label);
  const activeTargetColor = isOrchestratorMode ? '#e07a3a' : (targetAgent?.color ?? orchestratorRuntimeTone(preferredRuntime).color);
  const activeTargetRuntimeLabel = isOrchestratorMode ? 'Orchestrator' : (targetAgent ? orchestratorRuntimeTone(targetAgent.runtime).label : orchestratorRuntimeTone(preferredRuntime).label);

  useEffect(() => {
    onChromeChange({
      activeTargetLabel,
      waitingForReply: displayWaiting,
      hasMessages: displayMessages.length > 0,
      threadId,
    });
  }, [activeTargetLabel, displayMessages.length, displayWaiting, onChromeChange, threadId]);

  const appendSystemMessage = useCallback((text: string) => {
    if (!text || !text.trim()) return;
    const now = Date.now();
    const entry: MobileTranscriptEntry = {
      id: `sys-${now}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      text,
      timestamp: now,
      timestampLabel: new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setInjectedSystemMessages((current) => [...current, entry]);
  }, []);

  // Ref used so sendNow() can flush the latest input value right after
  // fillInput() without waiting for React to re-render.
  const latestInputRef = useRef('');
  useEffect(() => { latestInputRef.current = input; }, [input]);

  const fillInput = useCallback((text: string) => {
    setInput(text);
    latestInputRef.current = text;
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  // Send programmatically. Bypasses handleTaskSend to avoid a closure-capture
  // race where a freshly filled input isn't yet visible to the callback.
  const sendNow = useCallback((text?: string) => {
    const msg = (typeof text === 'string' ? text : latestInputRef.current).trim();
    if (!msg) return;

    // Orchestrator mode: route through the WebSocket stream directly.
    if (isOrchestratorMode) {
      if (orchStream.status === 'busy') return;
      setInput('');
      latestInputRef.current = '';
      orchStream.send(msg, { permissionMode, thinkingEffort });
      return;
    }

    // Non-orchestrator path: push into the input and defer to handleTaskSend.
    setInput(msg);
    latestInputRef.current = msg;
    setTimeout(() => { void handleTaskSend(); }, 0);
  }, [handleTaskSend, isOrchestratorMode, orchStream, permissionMode]);

  useImperativeHandle(ref, () => ({
    focusInput() {
      inputRef.current?.focus();
    },
    reset: handleReset,
    loadThread: handleLoadThread,
    appendSystemMessage,
    fillInput,
    sendNow,
  }), [appendSystemMessage, fillInput, handleReset, handleLoadThread, sendNow]);

  return (
    <>
      <div className="thoughts-scroll" style={{
        flex: 1,
        overflowY: 'auto',
        padding: '14px 16px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        background: thoughtsBodyBackground,
        minHeight: 0,
      }}>
        {displayMessages.length === 0 && !displayWaiting && emptyStateOverride ? (
          <div style={{
            display: 'flex',
            flex: 1,
            minHeight: 0,
          }}>
            {emptyStateOverride}
          </div>
        ) : null}
        {displayMessages.length === 0 && !displayWaiting && !emptyStateOverride && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            gap: 12,
            padding: '20px 0',
          }}>
            <div style={{
              width: '100%',
              maxWidth: 340,
              padding: '16px 18px',
              borderRadius: 18,
              background: thoughtsElevatedSurface,
              border: thoughtsElevatedBorder,
              boxShadow: thoughtsElevatedShadow,
              textAlign: 'left',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: activeTargetColor,
                  boxShadow: `0 0 0 4px ${activeTargetColor}18`,
                }} />
                <span style={{
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.01em',
                }}>
                  {activeTargetLabel}
                </span>
                <span style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--t-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>
                  Live Chat
                </span>
              </div>
              <div style={{
                fontSize: 12,
                color: 'var(--t-text-secondary)',
                lineHeight: 1.6,
                marginBottom: 10,
              }}>
                {isOrchestratorMode
                  ? 'Claude Code is your orchestrator. Your first message spawns a live session with full agent capabilities.'
                  : 'Intervene directly with a live Codex or Claude Code lane without leaving the planner surface.'}
              </div>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                fontSize: 11,
                color: 'var(--t-text-secondary)',
              }}>
                {isOrchestratorMode ? (
                  <>
                    <div>Full Claude Code agent — reads files, writes code, runs commands, manages lanes.</div>
                    <div>Same experience as your terminal. Use the picker below to switch targets.</div>
                  </>
                ) : targetAgent ? (
                  <>
                    <div>Messages stay scoped to the selected CLI lane.</div>
                    <div>Use the picker below to redirect the conversation to another live session.</div>
                    <div>Mission Control now slides out beside chat, so planning stays visible without replacing this lane.</div>
                  </>
                ) : (
                  <>
                    <div>No live Codex or Claude Code lane is available right now.</div>
                    <div>Switch to Claude orchestrator or launch a CLI lane from a workspace tab.</div>
                  </>
                )}
              </div>
            </div>

            {suggestions.length > 0 ? (
              <div style={{ width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--t-text-muted)',
                  letterSpacing: '0.05em',
                  padding: '0 2px',
                }}>
                  Suggested
                </div>
                {suggestions.map((suggestion, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      setTargetAgentKey(suggestion.agent.key);
                      setInput(suggestion.action);
                      setTimeout(() => inputRef.current?.focus(), 50);
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 10,
                      textAlign: 'left',
                      border: '1px solid var(--t-divider)',
                      background: 'var(--t-hover)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      flexShrink: 0,
                      background: suggestion.priority === 'critical' ? '#ef4444' : suggestion.priority === 'warn' ? '#f59e0b' : 'var(--t-text-muted)',
                    }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: 'var(--t-text)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {suggestion.text}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--t-text-muted)', marginTop: 1 }}>
                        → {suggestion.agent.name}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {displayMessages.map((msg, index) => (
          <DesktopAgentMessage
            key={msg.id}
            entry={msg}
            isLast={index === displayMessages.length - 1 && !displayWaiting}
          />
        ))}

        {displayWaiting && displayMessages.length > 0 &&
          displayMessages[displayMessages.length - 1]?.text?.toLowerCase().includes('compact') && (
            <div style={{
              padding: '12px 14px',
              borderRadius: 14,
              background: 'linear-gradient(180deg, rgba(254, 249, 195, 0.72), rgba(254, 240, 138, 0.22))',
              border: '1px solid rgba(245, 158, 11, 0.18)',
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              boxShadow: '0 12px 30px rgba(245, 158, 11, 0.08)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: '#b45309', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(245, 158, 11, 0.3)', borderTopColor: '#f59e0b', animation: 'spin 1s linear infinite' }} />
                Compaction in progress
              </div>
              <div style={{ fontSize: 11, color: '#92400e', lineHeight: 1.5 }}>
                Context is being compressed. Messages sent now will be queued and delivered after compaction completes.
              </div>
            </div>
          )}

        {displayWaiting && !(displayMessages.length > 0 &&
          displayMessages[displayMessages.length - 1]?.text?.toLowerCase().includes('compact')) && (
            <div style={{
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderRadius: 16,
              background: thoughtsMutedGlass,
              border: thoughtsElevatedBorder,
              boxShadow: thoughtsElevatedShadow,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, boxShadow: `0 0 0 4px ${activeTargetColor}14`, flexShrink: 0 }} />
              {[0, 1, 2].map((index) => (
                <div key={index} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-text-secondary)', animation: `llmDot 1.2s ease-in-out ${index * 0.18}s infinite` }} />
              ))}
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-secondary)', letterSpacing: '-0.01em' }}>
                {activeTargetLabel} is thinking…
              </span>
            </div>
          )}

        <div ref={chatEndRef} />
      </div>

      <div style={{
        padding: '10px 12px 12px',
        borderTop: '1px solid var(--t-divider-subtle)',
        flexShrink: 0,
        background: thoughtsBodyBackground,
      }}>
        {/* Runtime picker + status badges removed — the model label in the
            composer toolbar is sufficient. The orchestrator always uses
            Claude Code; CLI targets are selected via the workspace tab
            system, not a picker pill. */}
        {false && <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setAgentPickerOpen((value) => !value)}
              disabled={false}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 10,
                border: thoughtsElevatedBorder,
                background: thoughtsMutedGlass,
                boxShadow: thoughtsElevatedShadow,
                cursor: sessionTargets.length > 0 ? 'pointer' : 'default',
                fontSize: 11,
                fontWeight: 700,
                color: activeTargetColor,
                letterSpacing: '-0.01em',
                opacity: sessionTargets.length > 0 ? 1 : 0.6,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTargetColor, display: 'block', flexShrink: 0 }} />
              {activeTargetLabel}
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ display: 'block', transform: agentPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}>
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </button>

            {agentPickerOpen ? (
              <div style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                marginBottom: 6,
                minWidth: 184,
                borderRadius: 14,
                padding: 4,
                background: 'var(--t-panel-translucent)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid var(--t-panel-border)',
                boxShadow: 'var(--t-panel-shadow)',
                zIndex: 10,
              }}>
                {/* Claude orchestrator — always first */}
                <button
                  type="button"
                  onClick={() => {
                    setTargetAgentKey('__claude__');
                    setAgentPickerOpen(false);
                    setChatMessages([]);
                    setWaitingForReply(false);
                    clearPolling();
                    orchestratorHistoryRef.current = [];
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 10,
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: isOrchestratorMode ? 'rgba(224, 122, 58, 0.08)' : 'transparent',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#e07a3a', display: 'block', flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>Claude Code</div>
                    <div style={{ fontSize: 9, color: 'var(--t-text-muted)' }}>Orchestrator</div>
                  </div>
                  {isOrchestratorMode ? (
                    <div style={{ color: '#e07a3a' }}>
                      <CheckIcon />
                    </div>
                  ) : null}
                </button>
                {/* CLI session targets */}
                {sessionTargets.map((agent) => (
                  <button
                    key={agent.key}
                    type="button"
                    onClick={() => {
                      setTargetAgentKey(agent.key);
                      setAgentPickerOpen(false);
                      setChatMessages([]);
                      setWaitingForReply(false);
                      clearPolling();
                      seenServerEntriesRef.current.clear();
                      responseSeenRef.current = false;
                      idlePollsRef.current = 0;
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: targetAgent?.key === agent.key ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
                    }}
                  >
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: agent.color, display: 'block', flexShrink: 0 }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{agent.name}</div>
                      <div style={{ fontSize: 9, color: 'var(--t-text-muted)' }}>{orchestratorRuntimeTone(agent.runtime).label}</div>
                    </div>
                    {targetAgent?.key === agent.key ? (
                      <div style={{ color: '#2563eb' }}>
                        <CheckIcon />
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 8px',
              borderRadius: 999,
              background: thoughtsMutedGlass,
              border: thoughtsElevatedBorder,
              fontSize: 10,
              fontWeight: 700,
              color: 'var(--t-text-secondary)',
              textTransform: 'uppercase',
            }}>
              {targetAgentModel}
            </span>
            {typeof targetAgentContext === 'number' && targetAgentContext != null ? (
              <span style={{ fontSize: 10, color: (targetAgentContext as number) > 85 ? '#b45309' : 'var(--t-text-secondary)', fontWeight: 700 }}>
                {Math.round(targetAgentContext as number)}% ctx
              </span>
            ) : null}
            {targetAgentTask ? (
              <span style={{ minWidth: 0, flex: 1, fontSize: 10, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {targetAgentTask}
              </span>
            ) : null}
          </div>
        </div>}

        <div style={{ position: 'relative' }}>
          {(() => {
            const SLASH_COMMANDS = [
              { cmd: '/compact', title: 'Compact context', desc: 'Compress conversation history to free up space' },
              { cmd: '/clear', title: 'Clear conversation', desc: 'Reset the current conversation' },
              { cmd: '/cost', title: 'Token usage', desc: 'Show token count and estimated cost' },
              { cmd: '/status', title: 'Session status', desc: 'Show current session info and state' },
              { cmd: '/review', title: 'Code review', desc: 'Review current uncommitted changes' },
              { cmd: '/help', title: 'Help', desc: 'Show available commands and usage' },
            ];
            const showSlashPicker = isOrchestratorMode && input.startsWith('/') && !input.includes(' ');
            if (!showSlashPicker) return null;
            const query = input.toLowerCase();
            const filtered = SLASH_COMMANDS.filter(c => c.cmd.startsWith(query));
            if (filtered.length === 0) return null;
            return (
              <div className="thoughts-scroll" style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                marginBottom: 6,
                maxHeight: 220,
                overflowY: 'auto',
                borderRadius: 14,
                padding: 4,
                background: 'var(--t-panel-translucent)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid var(--t-panel-border)',
                boxShadow: 'var(--t-panel-shadow)',
                zIndex: 10,
              }}>
                <div style={{
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--t-text-muted)',
                  letterSpacing: '0.05em',
                  padding: '6px 10px 4px',
                }}>
                  Commands
                </div>
                {filtered.map((c) => (
                  <button
                    key={c.cmd}
                    type="button"
                    onClick={() => {
                      if (useStream) {
                        orchStream.send(c.cmd, { permissionMode });
                        setInput('');
                      } else {
                        setInput(c.cmd);
                        setTimeout(() => inputRef.current?.focus(), 50);
                      }
                    }}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 8,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: 'none',
                      cursor: 'pointer',
                      textAlign: 'left',
                      background: 'transparent',
                    }}
                  >
                    <span style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: 'var(--t-accent, #2563eb)',
                      fontFamily: '"SF Mono", ui-monospace, monospace',
                      flexShrink: 0,
                    }}>
                      {c.cmd}
                    </span>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-text)' }}>{c.title}</div>
                      <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginTop: 1 }}>{c.desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            );
          })()}
          {/* Composer container — textarea + bottom toolbar in one
              bordered card, matching the Superconductor reference. */}
          <div
            style={{
              borderRadius: 14,
              border: '1px solid var(--t-input-border)',
              background: 'var(--t-input-bg)',
              boxShadow: '0 14px 30px rgba(15, 23, 42, 0.08)',
              overflow: 'hidden',
              opacity: displayWaiting || (!isOrchestratorMode && !targetAgent) ? 0.6 : 1,
            }}
          >
            <textarea
              ref={inputRef}
              className={isOrchestratorMode ? 'thoughts-orchestrate-input' : undefined}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                // Auto-grow textarea
                const el = event.target;
                el.style.height = 'auto';
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' && !input.trim()) {
                  event.preventDefault();
                  const lastUserMsg = [...chatMessages].reverse().find((message) => message.role === 'user');
                  if (lastUserMsg) setInput(lastUserMsg.text);
                  return;
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void handleTaskSend();
                  // Reset height after send
                  if (inputRef.current) {
                    inputRef.current.style.height = 'auto';
                  }
                }
              }}
              placeholder={displayWaiting ? `${activeTargetLabel} is thinking...` : (isOrchestratorMode ? 'Type a message...' : `Message ${activeTargetLabel}…`)}
              disabled={displayWaiting || (!isOrchestratorMode && !targetAgent)}
              rows={2}
              style={{
                width: '100%',
                minHeight: 52,
                maxHeight: 200,
                paddingTop: 11,
                paddingRight: 14,
                paddingBottom: 4,
                paddingLeft: 14,
                borderWidth: 0,
                background: 'transparent',
                fontSize: 13,
                color: 'var(--t-text)',
                resize: 'none',
                outline: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.4,
                boxSizing: 'border-box',
                overflow: 'auto',
              }}
            />
            <InputButtons
              input={input}
              enhancing={enhancing}
              preEnhanceInput={preEnhanceInput}
              onEnhance={handleEnhance}
              onUndoEnhance={handleUndoEnhance}
              onSubmit={handleTaskSend}
              modelLabel={isOrchestratorMode ? 'Opus 4.6 (1M)' : activeTargetLabel}
              effort={thinkingEffort}
              onEffortChange={setThinkingEffort}
              permissionMode={permissionMode}
              onTogglePermission={onTogglePermission}
              missionOpen={missionOpen}
              onToggleMission={onToggleMission}
              repoLabel={isOrchestratorMode ? repoLabel : null}
            />
          </div>
        </div>

        {hasAssistantActivity ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 6, paddingLeft: 2, fontSize: 10, color: 'var(--t-text-faint)' }}>
            <span>{displayMessages.length} messages</span>
          </div>
        ) : null}
      </div>
    </>
  );
});
