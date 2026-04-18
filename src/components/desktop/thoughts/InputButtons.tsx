import { SparklesIcon } from './ThoughtsIcons';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  adaptive: 'adaptive',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'xhigh',
};
const EFFORT_OPTIONS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh'];
const EFFORT_DOT: Record<ThinkingEffort, string> = {
  adaptive: 'var(--t-text-faint)',
  low: 'var(--t-text-faint)',
  medium: 'var(--t-text-muted)',
  high: 'var(--t-text-muted)',
  max: 'var(--t-text)',
  xhigh: '#FF5A1F',
};

/**
 * Thinking effort control — matches the ContextMeter pill aesthetic.
 * Transparent background, hairline border, monospace, subtle status dot
 * on the left. Click to open the native dropdown (keeps it a single
 * focusable surface without a popover menu).
 */
export function ThinkingChip({
  effort = 'adaptive',
  adaptiveEnabled = true,
  onChange,
}: {
  effort?: ThinkingEffort;
  adaptiveEnabled?: boolean;
  onChange?: (next: ThinkingEffort) => void;
}) {
  const label = EFFORT_LABELS[effort];
  const dotColor = EFFORT_DOT[effort];
  const options = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');

  return (
    <label
      title={`Thinking ${label}`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 26,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-border)',
        background: 'transparent',
        color: 'var(--t-text-muted)',
        cursor: 'pointer',
        minWidth: 0,
        fontSize: 11.5,
        fontWeight: 400,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          flexShrink: 0,
          background: dotColor,
        }}
      />
      <span style={{ color: 'var(--t-text-muted)' }}>thinking</span>
      <span style={{ color: 'var(--t-text)' }}>{label}</span>
      <select
        value={effort}
        onChange={(event) => onChange?.(event.target.value as ThinkingEffort)}
        aria-label="Thinking effort"
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {EFFORT_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
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
  effort = 'adaptive',
  onEffortChange,
  adaptiveEnabled = true,
  permissionMode,
  onTogglePermission,
  missionOpen,
  onToggleMission,
  repoLabel,
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
  adaptiveEnabled?: boolean;
  permissionMode?: 'full' | 'plan';
  onTogglePermission?: () => void;
  missionOpen?: boolean;
  onToggleMission?: () => void;
  repoLabel?: string | null;
}) {
  const canSubmit = Boolean(input.trim());
  const effortCycle: ThinkingEffort[] = adaptiveEnabled
    ? ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh']
    : ['low', 'medium', 'high', 'max', 'xhigh'];

  const cycleEffort = (next = effortCycle[(Math.max(effortCycle.indexOf(effort), 0)) + 1] ?? effortCycle[0]) => {
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
      <div style={{ display: 'none' }} aria-hidden="true">
        <ThinkingChip effort={effort} adaptiveEnabled={adaptiveEnabled} onChange={cycleEffort} />
      </div>

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
            fontFamily: '"Plus Jakarta Sans", -apple-system, system-ui, sans-serif',
          }}
        >
          {modelLabel}
        </span>
      ) : null}

      {/* Repo focus label */}
      {repoLabel ? (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 10,
            fontWeight: 500,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--t-text-faint)' }}>·</span>
          {repoLabel}
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
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <path d="m2 2 20 20" />
          </svg>
        ) : (
          <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
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
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
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
        <svg width={14} height={14} viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
          <path d="M12 19V5" stroke={canSubmit ? '#ffffff' : '#9ca3af'} />
          <path d="m5 12 7-7 7 7" stroke={canSubmit ? '#ffffff' : '#9ca3af'} />
        </svg>
      </button>
    </div>
  );
}
