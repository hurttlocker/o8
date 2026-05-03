import { useRef } from 'react';
import { AttachFilesButton } from './AttachFilesButton';
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
// xhigh stays in the menu but reads as a sibling option to max, NOT as
// "even better than max". max gets the brand orange to anchor it as the
// climax tier; xhigh gets a muted dot so it doesn't outshine max.
const EFFORT_OPTIONS: ThinkingEffort[] = ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_DOT: Record<ThinkingEffort, string> = {
  adaptive: 'var(--t-text-faint)',
  low: 'var(--t-text-faint)',
  medium: 'var(--t-text-muted)',
  high: 'var(--t-text-muted)',
  xhigh: 'var(--t-text-muted)',
  max: '#FF5A1F',
};

/**
 * Thinking effort control — Rams pill matching ThreadsDropdown aesthetic.
 * <details>-based popover that opens UPWARD (bottom: 30) so it never
 * collides with the bottom edge of the composer.
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
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const label = EFFORT_LABELS[effort];
  const dotColor = EFFORT_DOT[effort];
  const options = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');

  const menuItem = (option: ThinkingEffort) => {
    const active = option === effort;
    return (
      <button
        key={option}
        type="button"
        onClick={() => { detailsRef.current?.removeAttribute('open'); onChange?.(option); }}
        style={{
          height: 28, paddingTop: 0, paddingRight: 10, paddingBottom: 0, paddingLeft: 10, borderWidth: 0,
          background: active ? 'var(--t-accent-soft)' : 'transparent',
          color: active ? 'var(--t-accent)' : 'var(--t-text)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          cursor: 'pointer', fontSize: 12, fontWeight: 400,
          fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 999, background: EFFORT_DOT[option] }}
          />
          <span>{EFFORT_LABELS[option]}</span>
        </span>
        {active ? <span style={{ fontSize: 11, color: 'var(--t-accent)' }}>•</span> : null}
      </button>
    );
  };

  return (
    <details ref={detailsRef} style={{ position: 'relative', flexShrink: 0 }}>
      <summary
        title={`Thinking ${label}`}
        style={{
          listStyle: 'none',
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
          style={{ width: 6, height: 6, borderRadius: 999, flexShrink: 0, background: dotColor }}
        />
        <span style={{ color: 'var(--t-text-muted)' }}>thinking</span>
        <span style={{ color: 'var(--t-text)' }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div
        style={{
          position: 'absolute', bottom: 30, left: 0, width: 156,
          paddingTop: 4, paddingRight: 4, paddingBottom: 4, paddingLeft: 4,
          borderRadius: 10, borderWidth: 1, borderStyle: 'solid',
          borderColor: 'var(--t-border)', background: 'var(--t-panel)',
          backdropFilter: 'blur(18px) saturate(1.3)', boxShadow: 'var(--t-panel-shadow)',
          display: 'flex', flexDirection: 'column', gap: 2, zIndex: 20,
        }}
      >
        {options.map((option) => menuItem(option))}
      </div>
    </details>
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
  repoLabel,
  working = false,
  onStop,
  onUploadDiskFiles,
  onFileReferenceSelect,
  repoPath,
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
  repoLabel?: string | null;
  working?: boolean;
  onStop?: () => void;
  onUploadDiskFiles?: (files: FileList | File[]) => void;
  onFileReferenceSelect?: (path: string) => void;
  repoPath?: string | null;
}) {
  const canSubmit = Boolean(input.trim());
  const effortCycle: ThinkingEffort[] = adaptiveEnabled
    ? ['adaptive', 'low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'xhigh', 'max'];

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

      <div style={{ flex: 1 }} />

      <AttachFilesButton
        onUploadDiskFiles={onUploadDiskFiles}
        onFileReferenceSelect={onFileReferenceSelect}
        repoPath={repoPath}
      />

      {/* Send — Rams pill matching ContextMeter/ThinkingChip aesthetic.
          Three states with 180ms morph: idle (hairline faint) → armed
          (accent border + soft bg + dot) → working (orange hairline +
          pulsing dot + "stop" if onStop provided, else "working"). */}
      <SendPill
        canSubmit={canSubmit}
        working={working}
        onSubmit={onSubmit}
        onStop={onStop}
      />
    </div>
  );
}

function SendPill({
  canSubmit,
  working,
  onSubmit,
  onStop,
}: {
  canSubmit: boolean;
  working: boolean;
  onSubmit: () => void;
  onStop?: () => void;
}) {
  const canStop = working && Boolean(onStop);
  const interactive = canStop || (!working && canSubmit);
  const stateColor = working ? '#FF5A1F' : canSubmit ? '#2563eb' : 'var(--t-text-faint)';
  const borderColor = working
    ? 'rgba(255, 90, 31, 0.32)'
    : canSubmit
      ? 'rgba(37, 99, 235, 0.32)'
      : 'var(--t-border)';
  const background = working
    ? 'rgba(255, 90, 31, 0.08)'
    : canSubmit
      ? 'rgba(37, 99, 235, 0.06)'
      : 'transparent';
  const label = working ? (canStop ? 'stop' : 'working') : 'send';
  const title = working
    ? (canStop ? 'Stop orchestrator' : 'Orchestrator working…')
    : canSubmit ? 'Send (Enter)' : 'Type to send';

  return (
    <button
      type="button"
      onClick={canStop ? onStop : onSubmit}
      disabled={!interactive}
      title={title}
      aria-label={title}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 26,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor,
        background,
        color: stateColor,
        cursor: interactive ? 'pointer' : 'default',
        minWidth: 0,
        fontSize: 11.5,
        fontWeight: 500,
        letterSpacing: '0.01em',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace",
        flexShrink: 0,
        transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1), border-color 180ms cubic-bezier(0.22, 1, 0.36, 1), color 180ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {/* status dot — pulses during working */}
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          flexShrink: 0,
          background: stateColor,
          animation: working ? 'sendpill-pulse 1.6s ease-in-out infinite' : 'none',
          transition: 'background 180ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      />
      <span style={{ color: stateColor }}>{label}</span>
      {/* glyph — up-arrow when send/armed, small square when stop */}
      {canStop ? (
        <svg width={9} height={9} viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0 }}>
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill={stateColor} />
        </svg>
      ) : working ? null : (
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
          <path d="M12 19V5" stroke={stateColor} />
          <path d="m5 12 7-7 7 7" stroke={stateColor} />
        </svg>
      )}
      <style>{`@keyframes sendpill-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }`}</style>
    </button>
  );
}
