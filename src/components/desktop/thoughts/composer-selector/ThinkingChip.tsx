'use client';

import { useRef } from 'react';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import { FloatingSurface } from '../../FloatingSurface';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import { useComposerChipCompact } from '../composer-compact-context';
import { EffortSlider } from './EffortSlider';
import { isHotComposerEffort, type ResolvedComposerSelectorState } from './state';
import { ServiceTierPicker } from './ServiceTierPicker';

export function ThinkingChip({ state, saving, onPick, open, onOpenChange }: {
  state: ResolvedComposerSelectorState;
  saving: boolean;
  onPick: (effort: ResolvedComposerSelectorState['effort']) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const compact = useComposerChipCompact();
  const topActive = isHotComposerEffort(state.effort);
  const accent = topActive ? 'var(--t-brand-orange)' : 'var(--t-accent)';
  const index = Math.max(0, state.effortOptions.indexOf(state.effort));
  const changeOpen = onOpenChange;
  if (state.effortOptions.length === 0) return null;
  return <>
    <button ref={ref} type="button" data-testid="composer-selector-thinking" data-accent={topActive ? 'swarm' : 'lead'} aria-label={`Thinking: ${THINKING_EFFORT_LABELS[state.effort].long}`} aria-expanded={open} disabled={saving}
      title="Thinking effort · Option+T cycles" onClick={() => changeOpen(!open)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, flexShrink: 0, paddingTop: 0, paddingRight: 5, paddingBottom: 0, paddingLeft: 5, borderRadius: 7, borderWidth: 0, background: open ? 'var(--t-hover)' : 'transparent', color: accent, fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, cursor: saving ? 'default' : 'pointer' }}>
      <span data-testid="composer-selector-effort-meter" aria-hidden style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 10 }}>
        {state.effortOptions.map((effort, barIndex) => <span key={effort} data-testid="composer-selector-meter-bar" data-lit={barIndex <= index ? 'true' : 'false'} data-accent={topActive ? 'swarm' : 'lead'} style={{ width: 2, height: 4 + barIndex, borderRadius: 2, background: barIndex <= index ? accent : 'var(--t-border)' }} />)}
      </span>
      {compact ? null : <span data-testid="composer-selector-effort-word" style={{ color: accent }}>{THINKING_EFFORT_LABELS[state.effort].short}</span>}
    </button>
    <ComposerPopover anchorRef={ref} open={open} onClose={() => changeOpen(false)} align="end">
      <FloatingSurface data-testid="composer-thinking-popover" role="dialog" aria-label="Orchestrator thinking" style={{ width: 300, maxWidth: 'calc(100vw * var(--zoom-inverse, 1) - 32px)', borderRadius: 18 }} contentStyle={{ paddingTop: 10, paddingRight: 6, paddingBottom: 10, paddingLeft: 6 }}>
        <div style={{ paddingRight: 10, paddingBottom: 6, paddingLeft: 10, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}>Thinking · {state.leadModelLabel}</div>
        <EffortSlider state={state} onPick={onPick} disabled={saving} />
        <ServiceTierPicker backend={state.leadBackend} model={state.leadModelId} disabled={saving} />
        {state.leadBackend === 'codex' && /gpt-6(?:\.|-).*astra/i.test(state.leadModelId) ? <div data-testid="astra-effort-note" style={{ paddingTop: 5, paddingRight: 10, paddingBottom: 2, paddingLeft: 10, fontSize: 10.5, lineHeight: '15px', color: 'var(--t-text-muted)' }}>Effort applies to your next turn. Cache reuse depends on keeping the earlier prompt and configuration stable.</div> : null}
      </FloatingSurface>
    </ComposerPopover>
  </>;
}
