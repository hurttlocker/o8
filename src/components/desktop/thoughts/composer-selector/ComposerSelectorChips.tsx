'use client';

import { useEffect, type RefObject } from 'react';
import { type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { useComposerChipCompact } from '../composer-compact-context';
import { ProviderMarkGlyph } from './provider-marks';
import {
  providerMarkForLead,
  composerRuntimeLabel,
  providerMarkForRuntime,
  type ComposerSelectorMode,
  type ResolvedComposerSelectorState,
} from './state';

const sharedChipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 22,
  paddingTop: 0,
  paddingRight: 6,
  paddingBottom: 0,
  paddingLeft: 6,
  borderRadius: 7,
  borderWidth: 1,
  borderStyle: 'solid',
  fontFamily: 'var(--font-sans-system)',
  whiteSpace: 'nowrap',
  minWidth: 0,
} as const;

export function LeadChip({ state, open, saving, buttonRef, onClick }: {
  state: ResolvedComposerSelectorState;
  open: boolean;
  saving: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const compact = useComposerChipCompact();
  return <button ref={buttonRef} data-testid="composer-selector-lead" type="button" title={`Orchestrator: ${state.leadModelLabel}`} aria-label={`Lead: ${state.leadModelLabel}`} aria-expanded={open} disabled={saving} onClick={onClick}
    style={{ ...sharedChipStyle, gap: 5, maxWidth: 190, minWidth: compact ? 56 : 0, borderColor: open ? 'var(--t-border)' : 'transparent', background: open ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text-secondary)', cursor: saving ? 'default' : 'pointer', fontSize: 11, fontWeight: 300, opacity: saving ? 0.6 : 1, overflow: 'hidden' }}>
    {compact ? null : <span style={{ display: 'inline-flex', flexShrink: 0 }}><ProviderMarkGlyph mark={providerMarkForLead(state.leadBackend, state.leadModelId)} /></span>}
    <span data-testid="composer-selector-lead-label" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{state.leadModelLabel}</span>
  </button>;
}

export function WorkersChip({
  availableRuntimes,
  mode,
  runtime,
  model,
  open,
  saving,
  buttonRef,
  onClick,
}: {
  availableRuntimes?: OrchestratorRuntime[];
  mode: Exclude<ComposerSelectorMode, 'solo'>;
  runtime: OrchestratorRuntime;
  model: string | null;
  open: boolean;
  saving: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const compact = useComposerChipCompact();
  useEffect(() => {
    const node = buttonRef.current;
    if (!node || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    node.animate?.(
      [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'translateY(0)' }],
      { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [buttonRef]);
  const runtimes = availableRuntimes?.length ? availableRuntimes : [runtime];
  const selectedIndex = Math.max(0, runtimes.indexOf(runtime));
  const stack = mode === 'fusion'
    ? [0, 1, 2].map((offset) => runtimes[(selectedIndex + offset) % runtimes.length])
    : [runtime];
  const label = mode === 'fusion'
    ? availableRuntimes ? `${availableRuntimes.length} ready` : 'Workers'
    : mode === 'moa'
      ? `2 ${composerRuntimeLabel(runtime)}`
      : composerRuntimeLabel(runtime);
  const selectionLabel = model ? `${label}, ${model}` : `${label}, runtime default`;
  return (
    <button
      ref={buttonRef}
      data-testid="composer-selector-workers"
      type="button"
      title={`Workers: ${selectionLabel}`}
      aria-label={`Workers: ${selectionLabel}`}
      aria-expanded={open}
      disabled={saving}
      onClick={onClick}
      style={{
        ...sharedChipStyle,
        gap: 6,
        borderColor: open ? 'var(--t-border)' : 'transparent',
        background: open ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-secondary)',
        cursor: saving ? 'default' : 'pointer',
        fontSize: 11,
        fontWeight: 450,
        flexShrink: 0,
        maxWidth: 180,
        overflow: 'hidden',
        opacity: saving ? 0.6 : 1,
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', alignItems: 'center', paddingLeft: stack.length > 1 ? 5 : 0 }}>
        {stack.map((stackRuntime, index) => (
          <span
            key={`${stackRuntime}:${index}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              marginLeft: index === 0 ? 0 : -5,
              borderRadius: 999,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-panel-border)',
              background: 'var(--t-popover-surface)',
              color: 'var(--t-text-secondary)',
            }}
          >
            <ProviderMarkGlyph mark={providerMarkForRuntime(stackRuntime)} size={10} />
          </span>
        ))}
      </span>
      <span
        data-testid="composer-selector-workers-label"
        style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', display: compact ? 'none' : undefined }}
      >
        {label}
      </span>
    </button>
  );
}
