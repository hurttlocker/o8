'use client';

import { forwardRef } from 'react';
import { InputButtons, type ThinkingEffort } from '../InputButtons';
import { SlashCommandPicker } from './SlashCommandPicker';
import type { ThoughtsChatPermissionMode } from './types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

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
  const isDisabled = displayWaiting || (!isOrchestratorMode && !targetAgentExists);

  return (
    <div style={{
      padding: '10px 12px 12px',
      borderTop: '1px solid var(--t-divider-subtle)',
      flexShrink: 0,
      background: thoughtsBodyBackground,
    }}>
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
