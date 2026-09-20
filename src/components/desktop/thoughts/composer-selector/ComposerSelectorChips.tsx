'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import { listDispatchableRuntimes, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { useComposerChipCompact } from '../composer-compact-context';
import { ProviderMarkGlyph } from './provider-marks';
import {
  isHotComposerEffort,
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

export function LeadChip({
  state,
  open,
  saving,
  buttonRef,
  onClick,
}: {
  state: ResolvedComposerSelectorState;
  open: boolean;
  saving: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const compact = useComposerChipCompact();
  const selectedIndex = Math.max(0, state.effortOptions.indexOf(state.effort));
  const topActive = isHotComposerEffort(state.effort);
  const accent = topActive ? 'var(--t-brand-orange)' : 'var(--t-accent)';
  const meterRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const previousIndexRef = useRef<number | null>(null);
  useEffect(() => {
    const previousIndex = previousIndexRef.current;
    previousIndexRef.current = selectedIndex;
    if (
      previousIndex === null
      || selectedIndex <= previousIndex
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) return;
    for (let index = previousIndex + 1; index <= selectedIndex; index += 1) {
      meterRefs.current[index]?.animate?.(
        [
          { transform: 'scaleY(1)' },
          { transform: 'scaleY(1.35)', offset: 0.5 },
          { transform: 'scaleY(1)' },
        ],
        { duration: 240, delay: (index - previousIndex - 1) * 30, easing: 'cubic-bezier(.34,1.56,.64,1)' },
      );
    }
  }, [selectedIndex]);
  return (
    <button
      ref={buttonRef}
      data-testid="composer-selector-lead"
      data-accent={topActive ? 'swarm' : 'lead'}
      type="button"
      title={state.chipTitle}
      aria-label={`Lead: ${state.leadModelLabel}, ${THINKING_EFFORT_LABELS[state.effort].long}`}
      aria-expanded={open}
      disabled={saving}
      onClick={onClick}
      style={{
        ...sharedChipStyle,
        gap: compact ? 4 : 5,
        maxWidth: 260,
        // A floor reserves a readable model prefix before the row collapses
        // anything else; the effort meter yields into it first.
        minWidth: compact ? 68 : 0,
        borderColor: open ? 'var(--t-border)' : 'transparent',
        background: open ? 'var(--t-hover)' : 'transparent',
        color: 'var(--t-text-secondary)',
        cursor: saving ? 'default' : 'pointer',
        fontSize: 11,
        opacity: saving ? 0.6 : 1,
        // The row clamps at narrow widths; keep the model label inside the
        // chip instead of letting the mark/meter paint over the Workers chip.
        overflow: 'hidden',
      }}
    >
      {compact ? null : (
        <span style={{ display: 'inline-flex', flexShrink: 0, color: 'currentColor' }}>
          <ProviderMarkGlyph mark={providerMarkForLead(state.leadBackend, state.leadModelId)} />
        </span>
      )}
      <span
        data-testid="composer-selector-lead-label"
        style={{
          // Guarantee a readable model prefix (roughly the first several
          // glyphs) when the row is tight; the effort meter yields first.
          minWidth: compact ? 40 : 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontWeight: 550,
        }}
      >
        {state.leadModelLabel}
      </span>
      <span
        data-testid="composer-selector-effort-meter"
        aria-hidden
        style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 9, flexShrink: 0 }}
      >
        {state.effortOptions.map((effort, index) => {
          const lit = index <= selectedIndex;
          return (
            <span
              key={effort}
              ref={(node) => { meterRefs.current[index] = node; }}
              data-testid="composer-selector-meter-bar"
              data-lit={lit ? 'true' : 'false'}
              data-accent={topActive ? 'swarm' : 'lead'}
              style={{
                width: 2,
                height: 4 + index,
                borderRadius: 2,
                background: lit ? accent : 'var(--t-border)',
                opacity: lit ? 1 : topActive ? 0.32 : 0.65,
                transformOrigin: 'bottom',
              }}
            />
          );
        })}
      </span>
      {compact ? null : (
        <span
          data-testid="composer-selector-effort-word"
          style={{ flexShrink: 0, color: accent, fontWeight: 450 }}
        >
          {THINKING_EFFORT_LABELS[state.effort].short}
        </span>
      )}
    </button>
  );
}

export function WorkersChip({
  mode,
  runtime,
  model,
  open,
  saving,
  buttonRef,
  onClick,
}: {
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
  const runtimes = listDispatchableRuntimes();
  const selectedIndex = Math.max(0, runtimes.indexOf(runtime));
  const stack = mode === 'fusion'
    ? [0, 1, 2].map((offset) => runtimes[(selectedIndex + offset) % runtimes.length])
    : [runtime];
  const label = mode === 'fusion'
    ? `${runtimes.length} runtimes`
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
              background: 'var(--t-panel-solid, var(--t-panel))',
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
