'use client';

import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { InputButtons, type ThinkingEffort } from '../InputButtons';
import { SlashCommandPicker } from './SlashCommandPicker';
import type { ThoughtsChatPermissionMode } from './types';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(1, '0')}:${s.toString().padStart(2, '0')}`;
}

function ComposerStatusBar({
  displayWaiting,
  runningTools,
  activeTargetLabel,
}: {
  displayWaiting: boolean;
  runningTools: MobileTranscriptToolCall[];
  activeTargetLabel: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const startedAtRef = useRef<number | null>(null);
  const hasRunningTools = runningTools.length > 0;
  const active = displayWaiting || hasRunningTools;

  useEffect(() => {
    if (!active) {
      startedAtRef.current = null;
      return;
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
      setNow(Date.now());
    }
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;

  const elapsed = startedAtRef.current !== null ? now - startedAtRef.current : 0;
  const runningSummary = hasRunningTools
    ? runningTools.slice(0, 2).map((t) => t.name).join(', ') + (runningTools.length > 2 ? ` +${runningTools.length - 2}` : '')
    : null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(37, 99, 235, 0.22)',
        borderRadius: 12,
        background: 'linear-gradient(180deg, rgba(37, 99, 235, 0.07), rgba(37, 99, 235, 0.03))',
        boxShadow: '0 8px 22px rgba(37, 99, 235, 0.08)',
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#2563eb"
        strokeWidth="3"
        strokeLinecap="round"
        style={{ animation: 'spin 0.9s linear infinite', flexShrink: 0 }}
        aria-hidden="true"
      >
        <path d="M21 12a9 9 0 1 1-6.22-8.56" />
      </svg>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 12,
          fontWeight: 700,
          color: 'var(--t-text)',
          letterSpacing: '-0.01em',
        }}>
          <span>{activeTargetLabel} is working</span>
          <span style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: '#2563eb',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            letterSpacing: '0',
          }}>
            {formatElapsed(elapsed)}
          </span>
        </div>
        {runningSummary ? (
          <div style={{
            fontSize: 10.5,
            color: 'var(--t-text-muted)',
            fontFamily: '"SF Mono", ui-monospace, monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            running: {runningSummary}
          </div>
        ) : null}
      </div>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: '#2563eb',
            opacity: 0.8,
            animation: `llmDot 1.2s ease-in-out ${index * 0.18}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

interface ComposerAreaProps {
  input: string;
  onInputChange: (next: string) => void;
  isOrchestratorMode: boolean;
  displayWaiting: boolean;
  chatMessages: MobileTranscriptEntry[];
  activeTargetLabel: string;
  targetAgentExists: boolean;
  thoughtsBodyBackground: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSubmit: () => void;
  onSlashCommand: (cmd: string) => void;
  modelLabel: string;
  effort: ThinkingEffort;
  onEffortChange: (next: ThinkingEffort) => void;
  permissionMode: ThoughtsChatPermissionMode;
  onTogglePermission?: () => void;
  missionOpen?: boolean;
  onToggleMission?: () => void;
  repoLabel?: string | null;
  displayMessagesCount: number;
  hasAssistantActivity: boolean;
}

export const ComposerArea = forwardRef<HTMLTextAreaElement, ComposerAreaProps>(function ComposerArea({
  input,
  onInputChange,
  isOrchestratorMode,
  displayWaiting,
  chatMessages,
  activeTargetLabel,
  targetAgentExists,
  thoughtsBodyBackground,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  onSlashCommand,
  modelLabel,
  effort,
  onEffortChange,
  permissionMode,
  onTogglePermission,
  missionOpen,
  onToggleMission,
  repoLabel,
  displayMessagesCount,
  hasAssistantActivity,
}, inputRef) {
  const runningTools = useMemo<MobileTranscriptToolCall[]>(() => {
    if (!isOrchestratorMode) return [];
    // Scan the latest assistant message for any tool calls still marked as
    // running. This is what the sticky status bar uses to stay visible even
    // if orchStream.status flickers — if there are live tool calls, the user
    // should see the bar regardless of the top-level status flag.
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg.role !== 'assistant') continue;
      const tools = msg.toolCalls ?? [];
      const running = tools.filter((t) => t.status === 'running' || t.status === 'calling');
      if (running.length > 0) return running;
      // Stop at the most recent assistant message — older tool calls are done.
      break;
    }
    return [];
  }, [chatMessages, isOrchestratorMode]);
  const isDisabled = (displayWaiting || runningTools.length > 0) || (!isOrchestratorMode && !targetAgentExists);

  return (
    <div style={{
      padding: '10px 12px 12px',
      borderTop: '1px solid var(--t-divider-subtle)',
      flexShrink: 0,
      background: thoughtsBodyBackground,
    }}>
      {isOrchestratorMode ? (
        <ComposerStatusBar
          displayWaiting={displayWaiting}
          runningTools={runningTools}
          activeTargetLabel={activeTargetLabel}
        />
      ) : null}
      <div style={{ position: 'relative' }}>
        <SlashCommandPicker
          input={input}
          isOrchestratorMode={isOrchestratorMode}
          onSelect={onSlashCommand}
        />
        <div
          style={{
            borderRadius: 14,
            border: '1px solid var(--t-input-border)',
            background: 'var(--t-input-bg)',
            boxShadow: '0 14px 30px rgba(15, 23, 42, 0.08)',
            overflow: 'hidden',
            opacity: isDisabled ? 0.6 : 1,
          }}
        >
          <textarea
            ref={inputRef}
            className={isOrchestratorMode ? 'thoughts-orchestrate-input' : undefined}
            value={input}
            onChange={(event) => {
              onInputChange(event.target.value);
              const el = event.target;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' && !input.trim()) {
                event.preventDefault();
                const lastUserMsg = [...chatMessages].reverse().find((message) => message.role === 'user');
                if (lastUserMsg) onInputChange(lastUserMsg.text);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
                if (event.currentTarget) {
                  event.currentTarget.style.height = 'auto';
                }
              }
            }}
            placeholder={displayWaiting ? `${activeTargetLabel} is thinking...` : (isOrchestratorMode ? 'Type a message...' : `Message ${activeTargetLabel}…`)}
            disabled={isDisabled}
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
              fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
              lineHeight: 1.4,
              boxSizing: 'border-box',
              overflow: 'auto',
            }}
          />
          <InputButtons
            input={input}
            enhancing={enhancing}
            preEnhanceInput={preEnhanceInput}
            onEnhance={onEnhance}
            onUndoEnhance={onUndoEnhance}
            onSubmit={onSubmit}
            modelLabel={modelLabel}
            effort={effort}
            onEffortChange={onEffortChange}
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
          <span>{displayMessagesCount} messages</span>
        </div>
      ) : null}
    </div>
  );
});
