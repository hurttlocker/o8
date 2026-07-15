'use client';

/**
 * ThreadChatPane — a full, independent chat pane hosting a specific thread
 * (drag-to-split, Claude Code split-screen parity). Rendered by
 * SessionTileSurface for `kind: 'thread'` leaves. Each pane owns its own
 * ThoughtsChatPanel instance (transcript + composer + status row), loaded
 * once with the leaf's threadId and isolated from the main chat: it never
 * writes the last-active thread, never auto-restores, never publishes
 * workspace-thread events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOrchestratorData } from '@/components/desktop/orchestrator-data-context';
import { registerPaneThread, unregisterPaneThread } from '@/lib/orchestrator/pane-thread-registry';
import { ThoughtsChatPanel } from '@/components/desktop/thoughts/ThoughtsChatPanel';
import type {
  ThoughtsChatPanelChromeState,
  ThoughtsChatPanelHandle,
} from '@/components/desktop/thoughts/chat-panel/types';
import { buildAgentTargets } from '@/components/desktop/thoughts/utils';

interface ThreadChatPaneProps {
  threadId: string;
  title: string;
  mode: 'orchestrator' | 'chat';
  repoPath?: string | null;
  onClose: () => void;
}

export function ThreadChatPane({ threadId, title, mode, repoPath, onClose }: ThreadChatPaneProps) {
  const data = useOrchestratorData();
  const chatPanelRef = useRef<ThoughtsChatPanelHandle>(null);
  const loadedThreadRef = useRef<string | null>(null);
  const [chrome, setChrome] = useState<ThoughtsChatPanelChromeState | null>(null);
  const [closeHover, setCloseHover] = useState(false);

  const agents = data?.agents ?? [];
  const sessionTargets = useMemo(
    () => buildAgentTargets(agents, 'codex'),
    [agents],
  );

  // Claim the thread for this pane so other chat views on the same repo
  // drop its stream events (the empty-main-chat hijack, 2026-07-15).
  useEffect(() => {
    registerPaneThread(threadId);
    return () => unregisterPaneThread(threadId);
  }, [threadId]);

  // Load the bound thread once the panel handle exists. Mirrors the
  // OrchestratorTab tab-bound retry loop: on a cold mount the imperative
  // handle is null at t=0, and a single-shot load would silently drop.
  useEffect(() => {
    if (loadedThreadRef.current === threadId) return;
    let cancelled = false;
    let attempts = 0;
    const tryLoad = () => {
      if (cancelled) return;
      if (loadedThreadRef.current === threadId) return;
      const handle = chatPanelRef.current;
      if (handle) {
        loadedThreadRef.current = threadId;
        handle.loadThread(threadId);
        return;
      }
      attempts += 1;
      if (attempts < 40) window.setTimeout(tryLoad, 50);
    };
    const timer = window.setTimeout(tryLoad, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [threadId]);

  const handleChromeChange = useCallback((state: ThoughtsChatPanelChromeState) => {
    setChrome(state);
  }, []);

  if (!data) return null;

  const headerTitle = title || chrome?.activeTargetLabel || 'Chat';

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 10,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background: 'var(--t-chat-surface-bg, var(--t-panel))',
        overflow: 'hidden',
      }}
    >
      {/* Pane header — title + close, matching the reference's per-pane bar. */}
      <div
        style={{
          height: 32,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12,
          paddingRight: 6,
          gap: 8,
          borderBottomWidth: 1,
          borderBottomStyle: 'solid',
          borderBottomColor: 'var(--t-divider-subtle, var(--t-border))',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--t-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={headerTitle}
        >
          {headerTitle}
        </span>
        <button
          type="button"
          aria-label={`Close ${headerTitle} pane`}
          onClick={onClose}
          onMouseEnter={() => setCloseHover(true)}
          onMouseLeave={() => setCloseHover(false)}
          style={{
            width: 22,
            height: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 0,
            borderRadius: 6,
            background: closeHover ? 'var(--t-hover-bg, rgba(127,127,127,0.14))' : 'transparent',
            color: 'var(--t-text-muted, var(--t-text))',
            fontSize: 15,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          &times;
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <ThoughtsChatPanel
          ref={chatPanelRef}
          open
          agents={agents}
          missionState={data.missionState}
          preferredRuntime="codex"
          sessionTargets={sessionTargets}
          workspaceTargets={data.workspaceTargets ?? []}
          repoPath={repoPath ?? null}
          thoughtsBodyBackground="transparent"
          thoughtsElevatedSurface="var(--t-glass-elevated)"
          thoughtsElevatedBorder="1px solid var(--t-glass-border-strong)"
          thoughtsElevatedShadow="var(--t-glass-shadow)"
          thoughtsMutedGlass="var(--t-glass-muted-strong)"
          showInlineExport={false}
          suppressAutoRestore
          lockedMode={mode === 'chat' ? 'chat' : undefined}
          initialMode={mode === 'chat' ? 'chat' : 'fleet'}
          onMissionStateChange={data.onMissionStateChange}
          onLaunchPacket={data.onLaunchPacket}
          onChromeChange={handleChromeChange}
        />
      </div>
    </div>
  );
}
