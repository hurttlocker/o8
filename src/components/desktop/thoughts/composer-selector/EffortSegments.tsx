'use client';

import { useState } from 'react';
import { MODEL_EFFORT_LABELS } from '../ModelThinkingChip';
import {
  composerEffortConsequence,
  isTopComposerEffort,
  type ResolvedComposerSelectorState,
} from './state';

export function EffortSegments({
  state,
  onPick,
  disabled = false,
}: {
  state: ResolvedComposerSelectorState;
  onPick: (effort: ResolvedComposerSelectorState['effort']) => void;
  disabled?: boolean;
}) {
  const [hoveredLockedEffort, setHoveredLockedEffort] = useState<ResolvedComposerSelectorState['effort'] | null>(null);
  const [focusedLockedEffort, setFocusedLockedEffort] = useState<ResolvedComposerSelectorState['effort'] | null>(null);
  const displayedEfforts = [...state.effortOptions, ...state.lockedEffortOptions];
  const previewEffort = focusedLockedEffort ?? hoveredLockedEffort ?? state.effort;
  return (
    <div
      data-testid="composer-selector-lead-effort"
      style={{
        marginTop: 2,
        marginRight: 6,
        marginBottom: 6,
        marginLeft: 31,
        paddingTop: 5,
        paddingRight: 6,
        paddingBottom: 5,
        paddingLeft: 6,
        borderRadius: 9,
        background: 'var(--t-bg-card)',
      }}
    >
      <div style={{ display: 'flex', gap: 2 }}>
        {displayedEfforts.map((effort) => {
          const selected = effort === state.effort;
          const locked = state.lockedEffortOptions.includes(effort);
          const top = isTopComposerEffort(effort, state.effortOptions);
          const accent = top ? 'var(--t-brand-orange)' : 'var(--t-accent)';
          return (
            <button
              key={effort}
              data-testid="composer-selector-effort-segment"
              data-accent={top ? 'swarm' : 'lead'}
              type="button"
              aria-pressed={selected}
              aria-disabled={locked ? true : undefined}
              disabled={disabled}
              onClick={() => { if (!locked && !disabled) onPick(effort); }}
              onMouseEnter={() => { if (locked) setHoveredLockedEffort(effort); }}
              onMouseLeave={() => { if (locked) setHoveredLockedEffort(null); }}
              onFocus={() => { if (locked) setFocusedLockedEffort(effort); }}
              onBlur={() => { if (locked) setFocusedLockedEffort(null); }}
              style={{
                flex: '1 1 auto',
                minWidth: 0,
                height: 22,
                paddingTop: 0,
                paddingRight: 2,
                paddingBottom: 0,
                paddingLeft: 2,
                borderRadius: 5,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: selected && !locked ? accent : 'var(--t-border)',
                background: selected
                  ? `color-mix(in srgb, ${accent} 12%, transparent)`
                  : 'transparent',
                color: locked ? 'var(--t-text-faint)' : selected || top ? accent : 'var(--t-text-muted)',
                fontFamily: 'var(--font-sans-system)',
                fontSize: 9,
                fontWeight: selected ? 500 : 300,
                cursor: disabled || locked ? 'default' : 'pointer',
                opacity: disabled ? 0.6 : locked ? 0.55 : 1,
              }}
            >
              {`${MODEL_EFFORT_LABELS[effort][0].toUpperCase()}${MODEL_EFFORT_LABELS[effort].slice(1)}`}
            </button>
          );
        })}
      </div>
      <div
        data-testid="composer-selector-effort-consequence"
        style={{
          marginTop: 4,
          color: isTopComposerEffort(previewEffort, state.effortOptions)
            ? 'var(--t-brand-orange)'
            : 'var(--t-text-muted)',
          fontSize: 9.5,
          fontWeight: 300,
          lineHeight: '13px',
          minHeight: 13,
          textAlign: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {composerEffortConsequence(state.leadBackend, previewEffort)}
      </div>
    </div>
  );
}
