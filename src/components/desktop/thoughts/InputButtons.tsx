import { useState } from 'react';
import { RocketIcon, SendIcon, SparklesIcon } from './ThoughtsIcons';

export function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSendAsTask,
  onSubmit,
  small,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSendAsTask?: () => void;
  onSubmit: () => void;
  small?: boolean;
}) {
  const [taskHovered, setTaskHovered] = useState(false);
  const sz = small ? 24 : 28;
  const sendSz = small ? 40 : 44;
  const taskSz = 44;
  const canSubmit = Boolean(input.trim());

  return (
    <div style={{
      position: 'absolute',
      right: 10,
      bottom: 10,
      display: 'flex',
      gap: 8,
      alignItems: 'center',
    }}>
      {preEnhanceInput !== null && (
        <button type="button" onClick={onUndoEnhance} title="Undo enhancement" style={{
          width: sz,
          height: sz,
          borderRadius: 7,
          border: 'none',
          background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11, fontWeight: 600,
        }}>
          ↩
        </button>
      )}
      <button type="button" onClick={onEnhance} disabled={!input.trim() || enhancing}
        title="Enhance with AI" style={{
          width: sz,
          height: sz,
          borderRadius: 7,
          border: 'none',
          background: input.trim() ? 'rgba(37, 99, 235, 0.1)' : 'var(--t-hover)',
          color: enhancing ? '#93c5fd' : input.trim() ? '#2563eb' : 'var(--t-text-faint)',
          cursor: input.trim() && !enhancing ? 'pointer' : 'default',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 120ms, color 120ms',
          animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
        }}>
        <SparklesIcon />
      </button>
      {onSendAsTask ? (
        <button
          type="button"
          onClick={onSendAsTask}
          onMouseEnter={() => setTaskHovered(true)}
          onMouseLeave={() => setTaskHovered(false)}
          disabled={!canSubmit}
          title="Send as task"
          style={{
            width: taskSz,
            minWidth: taskSz,
            height: taskSz,
            minHeight: taskSz,
            borderRadius: 12,
            border: '1px solid rgba(224, 122, 58, 0.22)',
            background: !canSubmit
              ? 'rgba(148, 163, 184, 0.14)'
              : taskHovered
                ? 'rgba(224, 122, 58, 0.14)'
                : 'rgba(255, 255, 255, 0.72)',
            color: !canSubmit
              ? 'var(--t-text-faint)'
              : taskHovered
                ? '#e07a3a'
                : 'var(--t-text-secondary)',
            cursor: canSubmit ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: taskHovered ? '0 10px 24px rgba(224, 122, 58, 0.16)' : '0 8px 18px rgba(15, 23, 42, 0.08)',
            transition: 'background 120ms, color 120ms, box-shadow 120ms',
          }}
        >
          <RocketIcon />
        </button>
      ) : null}
      <button type="button" onClick={onSubmit} disabled={!input.trim()} style={{
        width: sendSz,
        minWidth: sendSz,
        height: sendSz,
        minHeight: sendSz,
        borderRadius: 12,
        border: 'none',
        background: input.trim() ? '#2563eb' : 'var(--t-divider)',
        color: input.trim() ? '#fff' : 'var(--t-text-faint)',
        cursor: input.trim() ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: input.trim() ? '0 12px 24px rgba(37, 99, 235, 0.24)' : 'none',
        transition: 'background 120ms, box-shadow 120ms',
      }}>
        <SendIcon />
      </button>
    </div>
  );
}
