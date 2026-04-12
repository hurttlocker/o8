import { useState } from 'react';
import { SparklesIcon } from './ThoughtsIcons';

type ThinkingEffort = 'medium' | 'high' | 'max';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  medium: 'Medium thinking',
  high: 'High thinking',
  max: 'Max effort',
};

const EFFORT_CYCLE: ThinkingEffort[] = ['medium', 'high', 'max'];

/**
 * Signal bars icon — 3 bars that light up based on thinking effort level.
 * Clickable: cycles medium → high → max → medium.
 *   medium = 1 bar lit
 *   high   = 2 bars lit
 *   max    = 3 bars lit (default)
 */
function ThinkingBars({
  effort,
  onClick,
}: {
  effort: ThinkingEffort;
  onClick: () => void;
}) {
  const litColor = '#2563eb';
  const dimColor = 'var(--t-text-faint)';
  const lit1 = true; // always at least 1
  const lit2 = effort === 'high' || effort === 'max';
  const lit3 = effort === 'max';

  return (
    <button
      type="button"
      onClick={onClick}
      title={EFFORT_LABELS[effort]}
      style={{
        display: 'inline-flex',
        alignItems: 'flex-end',
        gap: 1.5,
        padding: 2,
        borderWidth: 0,
        background: 'transparent',
        cursor: 'pointer',
        height: 16,
      }}
    >
      <span style={{ width: 3, height: 5, borderRadius: 1, background: lit1 ? litColor : dimColor, transition: 'background 150ms' }} />
      <span style={{ width: 3, height: 9, borderRadius: 1, background: lit2 ? litColor : dimColor, transition: 'background 150ms' }} />
      <span style={{ width: 3, height: 13, borderRadius: 1, background: lit3 ? litColor : dimColor, transition: 'background 150ms' }} />
    </button>
  );
}

/**
 * InputToolbar — sits below the textarea inside the composer container.
 *
 *   [▊▊▊ effort] [model label] [✦ enhance]         [+ attach] [↑ send]
 */
export type { ThinkingEffort };

export function InputButtons({
  input,
  enhancing,
  preEnhanceInput,
  onEnhance,
  onUndoEnhance,
  onSubmit,
  modelLabel,
  effort = 'max',
  onEffortChange,
  permissionMode,
  onTogglePermission,
  missionOpen,
  onToggleMission,
}: {
  input: string;
  enhancing: boolean;
  preEnhanceInput: string | null;
  onEnhance: () => void;
  onUndoEnhance: () => void;
  onSendAsTask?: () => void;
  onSubmit: () => void;
  small?: boolean;
  modelLabel?: string;
  effort?: ThinkingEffort;
  onEffortChange?: (effort: ThinkingEffort) => void;
  permissionMode?: 'full' | 'plan';
  onTogglePermission?: () => void;
  missionOpen?: boolean;
  onToggleMission?: () => void;
}) {
  const canSubmit = Boolean(input.trim());

  const cycleEffort = () => {
    const idx = EFFORT_CYCLE.indexOf(effort);
    const next = EFFORT_CYCLE[(idx + 1) % EFFORT_CYCLE.length];
    onEffortChange?.(next);
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      paddingTop: 4,
      paddingRight: 8,
      paddingBottom: 6,
      paddingLeft: 10,
    }}>
      {/* Thinking effort bars — click to cycle */}
      <ThinkingBars effort={effort} onClick={cycleEffort} />

      {/* Model label */}
      {modelLabel ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10.5,
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
          }}
        >
          {modelLabel}
        </span>
      ) : null}

      {/* Enhance */}
      {preEnhanceInput !== null ? (
        <button
          type="button"
          onClick={onUndoEnhance}
          title="Undo enhancement"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 0,
            background: 'rgba(239, 68, 68, 0.1)',
            color: '#ef4444',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          ↩
        </button>
      ) : (
        <button
          type="button"
          onClick={onEnhance}
          disabled={!input.trim() || enhancing}
          title="Enhance with AI"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            borderWidth: 0,
            background: 'transparent',
            color: enhancing ? '#93c5fd' : input.trim() ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
            cursor: input.trim() && !enhancing ? 'pointer' : 'default',
            transition: 'color 120ms',
            animation: enhancing ? 'spin 1.5s ease-in-out infinite' : 'none',
          }}
        >
          <SparklesIcon />
        </button>
      )}

      {/* Permission toggle — always rendered, icon-only */}
      <button
        type="button"
        onClick={onTogglePermission}
        title={permissionMode === 'full' ? 'Full access — click to switch to read-only' : 'Read-only — click to arm full access'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: permissionMode === 'full' ? '#ef4444' : '#9ca3af',
          cursor: 'pointer',
          transition: 'color 120ms',
        }}
      >
        {permissionMode === 'full' ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m2 2 20 20" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        )}
      </button>

      {/* Issues toggle — always rendered */}
      <button
        type="button"
        onClick={onToggleMission}
        title={missionOpen ? 'Hide issues' : 'Show issues'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: missionOpen ? '#2563eb' : '#9ca3af',
          cursor: 'pointer',
          transition: 'color 120ms',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
          <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
          <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
          <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
      </button>

      <div style={{ flex: 1 }} />

      {/* Attach files placeholder */}
      <button
        type="button"
        title="Attach files"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 24,
          height: 24,
          borderRadius: 7,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-muted)',
          cursor: 'pointer',
          fontSize: 16,
          fontWeight: 300,
          lineHeight: 1,
          transition: 'color 120ms',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; }}
      >
        +
      </button>

      {/* Send */}
      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        title="Send"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 30,
          height: 30,
          borderRadius: 9,
          borderWidth: 0,
          background: canSubmit ? '#2563eb' : 'rgba(148, 163, 184, 0.18)',
          cursor: canSubmit ? 'pointer' : 'default',
          transition: 'background 120ms',
          flexShrink: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
          <path d="M12 19V5" stroke={canSubmit ? '#ffffff' : '#9ca3af'} />
          <path d="m5 12 7-7 7 7" stroke={canSubmit ? '#ffffff' : '#9ca3af'} />
        </svg>
      </button>
    </div>
  );
}
