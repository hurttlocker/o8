'use client';

/**
 * ModeChip — compact mode selector that lives in the composer footer.
 *
 * Operator decision 2026-05-27: inside an orchestrator-kind tab this
 * chip toggles "Fleet orchestration" (spawn sub-agents, default) vs
 * "Single agent" (talk to the orchestrator solo, no dispatch). The
 * Orchestrator-vs-Chat decision is made on the empty-state Kind toggle
 * once per tab; once a tab is locked in, this chip stays in-tab and
 * never spawns a new one.
 *
 * Chat-kind (llm-chat) tabs MUST NOT mount this chip — see callsite
 * gate in ThoughtsChatPanel (chip hides when lockedMode is set).
 */

import { useRef, useState } from 'react';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { useComposerChipCompact } from '@/components/desktop/thoughts/composer-compact-context';
import { ComposerPopover } from '@/components/desktop/thoughts/chat-panel/ComposerPopover';

interface ModeChipProps {
  selectedMode: OrchestrationMode;
  selectedSingleRuntime: OrchestratorRuntime;
  onSelectFleet: () => void;
  onSelectSingle: () => void;
  onSelectFusion: () => void;
  /**
   * Kept for backwards-compatible call sites that still pass these
   * handlers in (legacy single-runtime spawn flows). The chip itself
   * no longer offers a "spawn new tab" path — Fleet vs Single is an
   * in-tab toggle now. These props are reserved for future use.
   */
  onSpawnSingleTab?: (runtime: OrchestratorRuntime) => void;
  onSpawnChatTab?: () => void;
}

const FONT_FAMILY = 'var(--font-sans-system)';

function chipLabel(mode: OrchestrationMode, runtime: OrchestratorRuntime): string {
  if (mode === 'fleet') return 'Fleet orchestration';
  if (mode === 'single') return 'Solo';
  if (mode === 'fusion') return 'Fusion';
  // Legacy 'chat' literal — should never render here under the new
  // gating, but if it does (stale tab record), fall back to the
  // runtime label so we never paint a bare 'Chat' inside an
  // orchestrator-kind tab.
  if (mode === 'chat') return 'Solo';
  return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

export function ModeChip({
  selectedMode,
  selectedSingleRuntime,
  onSelectFleet,
  onSelectSingle,
  onSelectFusion,
}: ModeChipProps) {
  const [open, setOpen] = useState(false);
  // Collapses to icon-only when the composer button row is too narrow for
  // labels — same signal that drops the model picker's label, kept in lockstep.
  const compact = useComposerChipCompact();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const label = chipLabel(selectedMode, selectedSingleRuntime);

  const handlePickFleet = () => {
    onSelectFleet();
    setOpen(false);
  };

  const handlePickSingle = () => {
    onSelectSingle();
    setOpen(false);
  };

  const handlePickFusion = () => {
    onSelectFusion();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch mode"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 18,
          // Squeeze-band behavior: the composer row shrinks this chip via its
          // minWidth:0 wrapper. Without these the nowrap label spills past the
          // shrunken box and paints UNDER the clarify/permission icons that
          // follow (Sydney's minimized-workspace report, 2026-07-10). Clip and
          // ellipsize instead.
          minWidth: 0,
          maxWidth: '100%',
          overflow: 'hidden',
          paddingTop: 0,
          paddingRight: 6,
          paddingBottom: 0,
          paddingLeft: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? 'var(--t-border)' : 'transparent',
          background: open ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-faint)',
          cursor: 'pointer',
          fontFamily: FONT_FAMILY,
          fontSize: 10.5,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
          transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1), border-color 120ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
        onMouseEnter={(event) => {
          if (open) return;
          event.currentTarget.style.background = 'var(--t-hover)';
        }}
        onMouseLeave={(event) => {
          if (open) return;
          event.currentTarget.style.background = 'transparent';
        }}
      >
        <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--t-brand-orange, #FF5A1F)', marginRight: 1 }}>
          <svg width={9} height={9} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="6" r="2" />
            <circle cx="6" cy="18" r="2" />
            <circle cx="18" cy="18" r="2" />
            <path d="M12 8v4" />
            <path d="m12 12-6 4" />
            <path d="m12 12 6 4" />
          </svg>
        </span>
        {compact ? null : <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>}
        <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0, opacity: 0.7 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="start">
        <div
          role="menu"
          style={{
            minWidth: 240,
            paddingTop: 6,
            paddingRight: 6,
            paddingBottom: 6,
            paddingLeft: 6,
            borderRadius: 12,
            background: 'var(--t-panel-solid, #ffffff)',
            border: '1px solid var(--t-border, rgba(15,23,42,0.12))',
            boxShadow: '0 18px 42px rgba(15, 23, 42, 0.16)',
            fontFamily: FONT_FAMILY,
          }}
        >
          <PopoverSectionLabel>Mode</PopoverSectionLabel>
          <PopoverRow
            active={selectedMode === 'fleet'}
            title="Fleet orchestration"
            detail="Orchestrator dispatches sub-agents in worktrees."
            onClick={handlePickFleet}
            glyph={<FleetGlyph />}
          />
          <PopoverRow
            active={selectedMode === 'single'}
            title="Solo"
            detail="The orchestrator works alone · no dispatch."
            onClick={handlePickSingle}
            glyph={<SingleGlyph />}
          />
          <PopoverRow
            active={selectedMode === 'fusion'}
            title="Fusion"
            detail="Deep multi-agent pass · parallel and cross-verified."
            onClick={handlePickFusion}
            glyph={<FusionGlyph />}
          />
        </div>
      </ComposerPopover>
    </>
  );
}

function PopoverSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        paddingTop: 6,
        paddingRight: 8,
        paddingBottom: 4,
        paddingLeft: 8,
        fontSize: 9,
        fontWeight: 300,
        color: 'var(--t-text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {children}
    </div>
  );
}

interface PopoverRowProps {
  active: boolean;
  title: string;
  detail: string;
  onClick: () => void;
  glyph: React.ReactNode;
  disabled?: boolean;
}

function PopoverRow({ active, title, detail, onClick, glyph, disabled }: PopoverRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="menuitem"
      style={{
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) 14px',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        paddingTop: 7,
        paddingRight: 8,
        paddingBottom: 7,
        paddingLeft: 8,
        borderRadius: 8,
        borderWidth: 0,
        background: active ? 'var(--t-accent-soft)' : 'transparent',
        color: 'var(--t-text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      onMouseEnter={(event) => {
        if (active || disabled) return;
        event.currentTarget.style.background = 'var(--t-hover)';
      }}
      onMouseLeave={(event) => {
        if (active || disabled) return;
        event.currentTarget.style.background = 'transparent';
      }}
    >
      <span aria-hidden style={{ display: 'inline-flex', color: active ? 'var(--t-brand-orange, #FF5A1F)' : 'var(--t-text-muted)' }}>
        {glyph}
      </span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 300,
            color: 'var(--t-text)',
            letterSpacing: '-0.1px',
            lineHeight: 1.25,
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            letterSpacing: '-0.1px',
            lineHeight: 1.35,
          }}
        >
          {detail}
        </span>
      </span>
      <span aria-hidden style={{ opacity: active ? 1 : 0, color: 'var(--t-brand-orange, #FF5A1F)' }}>
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12 4 4 10-10" />
        </svg>
      </span>
    </button>
  );
}

function FleetGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M12 8v4" />
      <path d="m12 12-6 4" />
      <path d="m12 12 6 4" />
    </svg>
  );
}

function SingleGlyph() {
  // One node — visual counterpart to FleetGlyph's three-node fan-out.
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

function FusionGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z" />
    </svg>
  );
}
