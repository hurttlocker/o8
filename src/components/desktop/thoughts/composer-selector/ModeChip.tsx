'use client';

import { useRef, useState } from 'react';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import { FloatingSurface } from '../../FloatingSurface';
import {
  COMPOSER_SELECTOR_MODES,
  VISIBLE_COMPOSER_SELECTOR_MODES,
  composerSupportsFastMode,
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
  const label = state.mode === 'solo' ? 'Delegation off' : state.modeLabel;
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
        title={`${label}. ${state.modeSublabel}. Shift+Tab changes checkout.`}
        aria-label={`Mode: ${label}`} aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setPopoverOpen(!open)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center', width: 28, height: 28,
          padding: 0, borderRadius: 7, border: 0, background: 'transparent',
          color: open || state.mode === 'multitask' ? 'var(--t-accent)' : fusion ? FUSION_ACCENT : 'var(--t-text-muted)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.05px',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        {fusion ? <FusionGlyph /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {state.mode === 'multitask' ? <><path d="M6 6v12m0-9h8a4 4 0 0 0 4-4" /><circle cx="6" cy="4" r="2" /><circle cx="6" cy="20" r="2" /><circle cx="18" cy="3" r="2" /></> : <><rect x="3" y="5" width="18" height="14" rx="3" /><path d={state.mode === 'solo' ? 'M8 12h8' : 'M8 10v4m-2-2h4m5 0h3'} /></>}
        </svg>}
      </button>
      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setPopoverOpen(false)} align="start">
        <ModeSelectorModeMenu mode={state.mode} leadBackend={state.leadBackend} onSelect={(next) => {
          onModeChange(next);
          setPopoverOpen(false);
        }} />
      </ComposerPopover>
    </>
  );
}

function ModeSelectorModeMenu({
  mode,
  leadBackend,
  onSelect,
}: {
  mode: ComposerSelectorMode;
  leadBackend: ResolvedComposerSelectorState['leadBackend'];
  onSelect: (mode: ComposerSelectorMode) => void;
}) {
  return (
    <FloatingSurface role="menu" aria-label="Work mode" style={{
      width: 224,
      maxWidth: 'min(224px, calc(100vw - 32px))',
    }} contentStyle={{
      paddingTop: 6,
      paddingRight: 5,
      paddingBottom: 5,
      paddingLeft: 5,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 2, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}>
        <span>Worker checkout</span><span style={{ textTransform: 'none', letterSpacing: '-0.05px' }}>Shift+Tab cycles</span>
      </div>
      {mode === 'solo' ? <div style={{ paddingTop: 6, paddingRight: 8, paddingBottom: 6, paddingLeft: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>Delegation is off. Select a checkout option to enable workers.</div> : null}
      {VISIBLE_COMPOSER_SELECTOR_MODES.map(id => COMPOSER_SELECTOR_MODES.find(spec => spec.id === id)!).map((spec) => {
        const selected = spec.id === mode;
        const unavailable = spec.id === 'fast' && !composerSupportsFastMode(leadBackend);
        return (
          <button
            key={spec.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            disabled={unavailable}
            title={unavailable ? 'Shared requires a compatible lead runtime.' : undefined}
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
              color: unavailable ? 'var(--t-text-faint)' : 'var(--t-text-secondary)',
              cursor: unavailable ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <span style={{ width: 13, flexShrink: 0, color: spec.id === 'fusion' ? FUSION_ACCENT : 'var(--t-accent)', visibility: selected ? 'visible' : 'hidden' }}><CheckGlyph /></span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px' }}>{spec.long}</span>
              <span style={{ fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)' }}>{unavailable ? 'Use a compatible lead runtime' : spec.sublabel}</span>
            </span>
          </button>
        );
      })}
    </FloatingSurface>
  );
}
