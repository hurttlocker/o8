'use client';

import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { onboardingQuietButtonStyle } from './onboarding-style';
import { RuntimeIdentity } from './RuntimeIdentity';

export function runtimeReadinessLabel(runtime: SetupRuntime): string {
  if (runtime.available) return 'Ready';
  if (runtime.unavailableReason === 'not_installed') return 'Not installed';
  if (runtime.unavailableReason === 'needs_auth') return 'Sign-in needed';
  if (runtime.unavailableReason === 'needs_restart') return 'Restart needed';
  return 'Needs attention';
}

/** Installation and sign-in readiness. This does not claim a completed model turn. */
export function AgentReadiness({ inventory, selectedRuntime, disabled, onSelect }: {
  inventory: readonly SetupRuntime[];
  selectedRuntime?: string | null;
  disabled?: boolean;
  onSelect?: (runtime: SetupRuntime) => void;
}) {
  return <div aria-label="Agent readiness" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    {inventory.map((runtime) => {
      const selected = selectedRuntime === runtime.id;
      const status = runtimeReadinessLabel(runtime);
      const detail = runtime.available ? /^(ready|ready to code)\.?$/i.test(runtime.detail) ? 'Available on this computer' : runtime.detail
        : runtime.fix || runtime.detail;
      const content = <>
        <RuntimeIdentity runtime={runtime.id} />
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px' }}>{runtime.label}</span>
          <span style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>{detail}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, fontSize: 11, fontWeight: 300, color: runtime.available ? 'var(--t-success)' : 'var(--t-text-muted)' }}>
          <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />{status}
          {selected && onSelect ? <span style={{ color: 'var(--t-text-secondary)' }}>· Selected</span> : null}
        </span>
      </>;
      const style = { ...onboardingQuietButtonStyle, display: 'flex', alignItems: 'center', gap: 16, width: '100%', minHeight: 76,
        paddingTop: 16, paddingBottom: 16, paddingLeft: 16, paddingRight: 16, textAlign: 'left' as const,
        border: `1px solid ${selected && onSelect ? 'var(--t-accent)' : 'var(--t-divider)'}`,
        background: selected && onSelect ? 'var(--t-input-bg)' : 'var(--t-bg-card)', color: 'var(--t-text)' };
      return onSelect ? <button key={runtime.id} type="button" aria-label={`${runtime.label}: ${status}`} aria-pressed={selected}
        disabled={disabled || !runtime.available} onClick={() => onSelect(runtime)} style={{ ...style, cursor: disabled || !runtime.available ? 'default' : 'pointer' }}>{content}</button>
        : <div key={runtime.id} style={style}>{content}</div>;
    })}
  </div>;
}
