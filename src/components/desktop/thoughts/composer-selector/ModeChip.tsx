'use client';

import { useRef, useState } from 'react';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import { useComposerChipCompact } from '../composer-compact-context';
import {
  COMPOSER_SELECTOR_MODES,
  type ResolvedComposerSelectorState,
  type ComposerSelectorMode,
} from './state';

const FUSION_ACCENT = 'var(--t-brand-orange)';

function CheckGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function FusionGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <circle cx="8" cy="3.4" r="2" />
      <circle cx="3.4" cy="11.6" r="2" />
      <circle cx="12.6" cy="11.6" r="2" />
    </svg>
  );
}

export function ModeChip({
  state,
  onModeChange,
  onOpenChange,
}: {
  state: ResolvedComposerSelectorState;
  onModeChange: (mode: ComposerSelectorMode) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const compact = useComposerChipCompact();
  const fusion = state.mode === 'fusion';
  const setPopoverOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <>
      <button
        ref={triggerRef}
        data-testid="composer-selector-mode"
        type="button"
        title={`${state.modeLabel}. ${state.modeSublabel}. Shift+Tab cycles.`}
        aria-label={`Mode: ${state.modeLabel}`}
        aria-expanded={open}
        onClick={() => setPopoverOpen(!open)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 20,
          paddingTop: 0,
          paddingRight: 7,
          paddingBottom: 0,
          paddingLeft: 7,
          borderRadius: 6,
          borderWidth: 0,
          background: fusion
            ? `color-mix(in srgb, ${FUSION_ACCENT} 10%, transparent)`
            : state.mode === 'solo' ? 'transparent' : 'var(--t-accent-soft)',
          color: fusion ? FUSION_ACCENT : state.mode === 'solo' ? 'var(--t-text-faint)' : 'var(--t-accent)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.05px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {fusion ? <FusionGlyph /> : null}
        {state.modeShortLabel}
        <span
          data-testid="composer-selector-mode-hint"
          style={{
            fontSize: 9,
            color: 'var(--t-text-faint)',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            borderRadius: 4,
            paddingLeft: 3,
            paddingRight: 3,
            lineHeight: '13px',
            // Narrow rows drop the decorative shortcut hint; the mode label,
            // title/aria, menu, and Shift+Tab handling all stay intact.
            display: compact ? 'none' : undefined,
          }}
        >
          ⇧⇥
        </span>
      </button>
      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setPopoverOpen(false)} align="start">
        <ModeSelectorModeMenu mode={state.mode} onSelect={(next) => {
          onModeChange(next);
          setPopoverOpen(false);
        }} />
      </ComposerPopover>
    </>
  );
}

function ModeSelectorModeMenu({
  mode,
  onSelect,
}: {
  mode: ComposerSelectorMode;
  onSelect: (mode: ComposerSelectorMode) => void;
}) {
  return (
    <div style={{
      width: 224,
      maxWidth: 'min(224px, calc(100vw - 32px))',
      borderRadius: 14,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'var(--t-panel-border)',
      background: 'var(--t-popover-surface)',
      boxShadow: 'var(--t-panel-shadow)',
      paddingTop: 6,
      paddingRight: 5,
      paddingBottom: 5,
      paddingLeft: 5,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 2, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
        <span>Work mode</span><span style={{ textTransform: 'none', letterSpacing: '-0.05px' }}>Shift+Tab cycles</span>
      </div>
      {COMPOSER_SELECTOR_MODES.map((spec) => {
        const selected = spec.id === mode;
        return (
          <button
            key={spec.id}
            type="button"
            onClick={() => onSelect(spec.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              minHeight: 34,
              paddingTop: 3,
              paddingRight: 8,
              paddingBottom: 3,
              paddingLeft: 8,
              borderRadius: 8,
              borderWidth: 0,
              background: selected ? 'var(--t-hover)' : 'transparent',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <span style={{ width: 13, flexShrink: 0, color: spec.id === 'fusion' ? FUSION_ACCENT : 'var(--t-accent)', visibility: selected ? 'visible' : 'hidden' }}><CheckGlyph /></span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px' }}>{spec.long}</span>
              <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-faint)' }}>{spec.sublabel}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
