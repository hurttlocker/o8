'use client';

import type { OrchestratorBackendSetting } from '../operator-defaults';

export interface PendingBackendSwitch {
  backend: OrchestratorBackendSetting;
  model?: string;
  label: string;
}

export function BackendSwitchChoice({
  target,
  onHandoff,
  onStartFresh,
  onCancel,
}: {
  target: PendingBackendSwitch;
  onHandoff: () => void;
  onStartFresh: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-label={`Switch this conversation to ${target.label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 54,
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 6,
        paddingLeft: 12,
        borderTop: '1px solid var(--t-divider)',
        background: 'var(--t-input-bg)',
        color: 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
      }}
    >
      <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 12.5, fontWeight: 400, lineHeight: 1.3 }}>Continue with {target.label}?</span>
        <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
          Hand off the measured context, or keep this thread and start a clean one.
        </span>
      </span>
      <button
        type="button"
        onClick={onStartFresh}
        style={{ minHeight: 44, paddingRight: 10, paddingLeft: 10, borderWidth: 0, borderRadius: 9, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 11.5, fontWeight: 400 }}
      >
        Start fresh
      </button>
      <button
        type="button"
        onClick={onHandoff}
        style={{ minHeight: 44, paddingRight: 12, paddingLeft: 12, borderWidth: 0, borderRadius: 9, background: 'var(--t-accent)', color: 'var(--t-accent-contrast, #fff)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 11.5, fontWeight: 400 }}
      >
        Hand off
      </button>
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancel backend switch"
        style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 0, borderWidth: 0, borderRadius: 9, background: 'transparent', color: 'var(--t-text-faint)', cursor: 'pointer' }}
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
          <path d="M3 3l10 10M13 3 3 13" />
        </svg>
      </button>
    </div>
  );
}
