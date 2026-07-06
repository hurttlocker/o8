import { useRef, useState } from 'react';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorBackendSetting } from './operator-defaults';
import { MODEL_IDS } from '@/lib/models';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  adaptive: 'adaptive',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  xhigh: 'xhigh',
};

// Adaptive sits BETWEEN medium and high — that's the band it auto-picks in,
// and its half-lit fourth bar reads the same way (operator, 2026-07-06).
const EFFORT_OPTIONS: ThinkingEffort[] = ['low', 'medium', 'adaptive', 'high', 'xhigh', 'max'];
const EFFORT_LEVEL: Record<ThinkingEffort, number> = {
  // Between medium (3) and high (4): adaptive auto-picks in that band, so its
  // bars fill 3 solid + a half-lit fourth — reading as "between medium and high".
  adaptive: 3.5,
  low: 1,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

const SWARM_ACCENT = 'var(--t-brand-orange, #FF5A1F)';
const MODEL_THINKING_MENU_WIDTH = 172;

type ComposerModelOption = {
  value: string;
  label: string;
  backend: OrchestratorBackendSetting;
  model?: string;
};

const COMPOSER_MODEL_OPTIONS: ComposerModelOption[] = [
  { value: 'codex-gpt-5-5', label: 'Codex GPT-5.5', backend: 'codex' },
  { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5', backend: 'fable', model: MODEL_IDS.fableDefault },
  { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8', backend: 'claude', model: MODEL_IDS.orchestratorDefault },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5', backend: 'claude', model: MODEL_IDS.claudeQaDefault },
];

function ThinkingBars({ effort, active = false }: { effort: ThinkingEffort; active?: boolean }) {
  const level = EFFORT_LEVEL[effort];
  const color = active
    ? (effort === 'max' ? SWARM_ACCENT : 'var(--t-accent)')
    : 'var(--t-text-faint)';
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 1.25, width: 18, height: 9, flexShrink: 0 }}>
      {Array.from({ length: 6 }).map((_, index) => {
        const full = index < Math.floor(level);
        // Fractional step (adaptive's 3.5): the boundary bar is half-lit, so
        // adaptive reads as sitting between medium and high. Integer levels never
        // trigger this, so every other option renders exactly as before.
        const partial = !full && index < level;
        const on = full || partial;
        return (
          <span
            key={index}
            style={{
              width: 2,
              height: 2.25 + (index * 0.8),
              borderRadius: 999,
              background: on ? color : 'color-mix(in srgb, var(--t-text-faint) 22%, transparent)',
              opacity: full ? 1 : partial ? 0.5 : 0.7,
            }}
          />
        );
      })}
    </span>
  );
}

function SwarmGlyph({ size = 12, color = SWARM_ACCENT }: { size?: number; color?: string }) {
  return (
    <span aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="3.4" r="2" fill={color} />
        <circle cx="3.4" cy="11.6" r="2" fill={color} />
        <circle cx="12.6" cy="11.6" r="2" fill={color} />
      </svg>
    </span>
  );
}

export function ModelThinkingChip({
  modelLabel,
  modelId,
  onModelChange,
  activeBackend,
  onBackendChange,
  effort,
  adaptiveEnabled,
  onEffortChange,
  swarmEnabled = false,
  onSetSwarm,
  collideEnabled = false,
  onSetCollide,
  compact = false,
}: {
  modelLabel: string;
  modelId?: string;
  onModelChange?: (model: string) => void;
  activeBackend?: OrchestratorBackendSetting;
  onBackendChange?: (backend: OrchestratorBackendSetting) => void;
  effort: ThinkingEffort;
  adaptiveEnabled: boolean;
  onEffortChange?: (effort: ThinkingEffort) => void;
  swarmEnabled?: boolean;
  onSetSwarm?: (enabled: boolean) => void;
  collideEnabled?: boolean;
  onSetCollide?: (enabled: boolean) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const options = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');
  const selectedLabel = EFFORT_LABELS[effort];
  const ultraActive = Boolean(swarmEnabled);
  const collideActive = Boolean(collideEnabled);
  const modelSwitchable = Boolean(onModelChange || onBackendChange);
  const canOpen = Boolean(onEffortChange || onSetSwarm || onSetCollide || onModelChange || onBackendChange);
  const showingAffordance = canOpen && (hovered || focused || open);
  const isCodexBackend = activeBackend === 'codex';
  const effortSectionLabel = isCodexBackend ? 'Reasoning' : 'Thinking';
  const effortTitle = isCodexBackend ? 'reasoning' : 'thinking';
  const normalizedModelId = modelId?.replace(/\[[^\]]*\]$/, '');
  const decideLabel = isCodexBackend ? 'Codex decides' : 'Claude decides';
  const modeLabel = collideActive ? 'Collide' : ultraActive ? 'Swarm' : 'Solo';

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => { if (canOpen) setOpen((current) => !current); }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={!canOpen}
        title={`${modelLabel} · ${modeLabel} · ${effortTitle} ${selectedLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          height: 22,
          maxWidth: 200,
          paddingTop: 0,
          paddingRight: canOpen ? 6 : 0,
          paddingBottom: 0,
          paddingLeft: canOpen ? 5 : 0,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: ultraActive || collideActive ? `color-mix(in srgb, ${SWARM_ACCENT} 32%, transparent)` : showingAffordance ? 'var(--t-border)' : 'transparent',
          borderRadius: 7,
          background: ultraActive || collideActive ? `color-mix(in srgb, ${SWARM_ACCENT} 8%, transparent)` : showingAffordance ? 'var(--t-hover)' : 'transparent',
          color: ultraActive || collideActive ? 'var(--t-text)' : showingAffordance ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
          cursor: canOpen ? 'pointer' : 'default',
          outline: focused && canOpen ? '2px solid var(--t-focus-ring)' : 'none',
          outlineOffset: 1,
          fontFamily: 'var(--font-sans-system)',
          transition: 'background 160ms cubic-bezier(0.22, 1, 0.36, 1), border-color 160ms cubic-bezier(0.22, 1, 0.36, 1), color 160ms cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        {compact ? null : (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 300, letterSpacing: '0' }}>
            {modelLabel}
          </span>
        )}
        {ultraActive || collideActive ? <SwarmGlyph size={11} /> : null}
        <ThinkingBars effort={effort} active={open || effort === 'max' || (isCodexBackend && effort === 'xhigh')} />
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: canOpen ? 0.72 : 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <ComposerPopover anchorRef={buttonRef} open={open} onClose={() => setOpen(false)} align="start">
        <div
          role="menu"
          aria-label="Model and thinking"
          style={{
            width: MODEL_THINKING_MENU_WIDTH,
            paddingTop: 7,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            background: 'var(--t-panel)',
            backdropFilter: 'blur(18px) saturate(1.3)',
            boxShadow: 'var(--t-panel-shadow)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {modelSwitchable ? (
            <>
              <div style={{ paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 2 }}>
                <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>Model</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {COMPOSER_MODEL_OPTIONS.map((option) => {
                  const active = option.backend === 'codex'
                    ? activeBackend === 'codex'
                    : activeBackend === option.backend && normalizedModelId === option.model;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => {
                        if (option.model) onModelChange?.(option.model);
                        if (!active) onBackendChange?.(option.backend);
                        if (option.backend === 'codex') onEffortChange?.('xhigh');
                        setOpen(false);
                      }}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'minmax(0, 1fr) auto',
                        alignItems: 'center',
                        gap: 6,
                        minHeight: 23,
                        paddingTop: 2,
                        paddingRight: 6,
                        paddingBottom: 2,
                        paddingLeft: 7,
                        borderWidth: 0,
                        borderRadius: 8,
                        background: active ? 'var(--t-accent-soft)' : 'transparent',
                        color: active ? 'var(--t-accent)' : 'var(--t-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: 'var(--font-sans-system)',
                      }}
                      onMouseEnter={(event) => {
                        if (!active) event.currentTarget.style.background = 'var(--t-hover)';
                      }}
                      onMouseLeave={(event) => {
                        if (!active) event.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                      <span style={{ width: 6, height: 6, borderRadius: 999, background: active ? 'var(--t-accent)' : 'transparent', flexShrink: 0 }} />
                    </button>
                  );
                })}
              </div>
              <div style={{ marginTop: 4, paddingLeft: 7, paddingRight: 7, paddingTop: 6, paddingBottom: 2, borderTop: '1px solid var(--t-divider-subtle)' }}>
                <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
              </div>
            </>
          ) : (
            <div style={{ paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 6, borderBottom: '1px solid var(--t-divider-subtle)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', color: 'var(--t-text)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel}</div>
              <div style={{ marginTop: 2, fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {options.map((option) => {
              const active = option === effort;
              return (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    onEffortChange?.(option);
                    setOpen(false);
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 6,
                    minHeight: 23,
                    paddingTop: 2,
                    paddingRight: 6,
                    paddingBottom: 2,
                    paddingLeft: 7,
                    borderWidth: 0,
                    borderRadius: 8,
                    background: active ? 'var(--t-accent-soft)' : 'transparent',
                    color: active ? 'var(--t-accent)' : 'var(--t-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans-system)',
                  }}
                  onMouseEnter={(event) => {
                    if (!active) event.currentTarget.style.background = 'var(--t-hover)';
                  }}
                  onMouseLeave={(event) => {
                    if (!active) event.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.25 }}>{EFFORT_LABELS[option]}</span>
                    <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0', color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', lineHeight: 1.25 }}>
                      {option === 'adaptive' ? 'auto' : `${EFFORT_LEVEL[option]}/6`}
                    </span>
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <ThinkingBars effort={option} active={active} />
                    <span style={{ width: 6, height: 6, borderRadius: 999, background: active ? (option === 'max' ? SWARM_ACCENT : 'var(--t-accent)') : 'transparent', flexShrink: 0 }} />
                  </span>
                </button>
              );
            })}
          </div>

          {onSetSwarm || onSetCollide ? (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--t-divider-subtle)', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ paddingLeft: 7, paddingRight: 7, paddingBottom: 2 }}>
                <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>Mode</div>
              </div>
              {[
                { key: 'solo', order: 1, active: !ultraActive && !collideActive, label: 'Solo', detail: 'one orchestrator driving the fleet', hint: 'One orchestrator plans, dispatches, and reviews the whole worker fleet. Still many agents working — one brain directing them.' },
                { key: 'collide', order: 3, active: collideActive, label: 'Collide', detail: `Claude + Codex propose · ${decideLabel}`, hint: 'Claude and Codex propose independently, then one synthesizes and does the work — a built-in second opinion for hard problems.' },
              ].map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode.active}
                  title={mode.hint}
                  onClick={() => {
                    onSetSwarm?.(false);
                    onSetCollide?.(mode.key === 'collide' ? !collideActive : false);
                    setOpen(false);
                  }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                    alignItems: 'center',
                    gap: 8,
                    minHeight: 30,
                    paddingTop: 4,
                    paddingRight: 6,
                    paddingBottom: 4,
                    paddingLeft: 7,
                    borderWidth: 0,
                    borderRadius: 8,
                    background: mode.active ? `color-mix(in srgb, ${SWARM_ACCENT} 10%, transparent)` : 'transparent',
                    color: 'var(--t-text)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans-system)',
                    order: mode.order,
                  }}
                  onMouseEnter={(event) => { if (!mode.active) event.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(event) => { if (!mode.active) event.currentTarget.style.background = 'transparent'; }}
                >
                  <SwarmGlyph size={13} color={mode.active ? SWARM_ACCENT : 'var(--t-text-muted)'} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: mode.active ? SWARM_ACCENT : 'var(--t-text)' }}>{mode.label}</span>
                    <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', lineHeight: 1.3, color: 'var(--t-text-faint)' }}>{mode.detail}</span>
                  </span>
                  <span style={{ width: 6, height: 6, borderRadius: 999, background: mode.active ? SWARM_ACCENT : 'transparent', flexShrink: 0 }} />
                </button>
              ))}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={ultraActive}
                title="The orchestrator fans out its own parallel sub-agents alongside the Codex workers — maximum throughput for big jobs."
                onClick={() => {
                  const next = !ultraActive;
                  onSetSwarm?.(next);
                  onSetCollide?.(false);
                  if (next) onEffortChange?.('xhigh');
                  setOpen(false);
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                  alignItems: 'center',
                  gap: 8,
                  minHeight: 30,
                  paddingTop: 4,
                  paddingRight: 6,
                  paddingBottom: 4,
                  paddingLeft: 7,
                  borderWidth: 0,
                  borderRadius: 8,
                  background: ultraActive ? `color-mix(in srgb, ${SWARM_ACCENT} 10%, transparent)` : 'transparent',
                  color: 'var(--t-text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  order: 2,
                }}
                onMouseEnter={(event) => { if (!ultraActive) event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { if (!ultraActive) event.currentTarget.style.background = 'transparent'; }}
              >
                <SwarmGlyph size={13} color={ultraActive ? SWARM_ACCENT : 'var(--t-text-muted)'} />
                <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: ultraActive ? SWARM_ACCENT : 'var(--t-text)' }}>Swarm</span>
                  <span style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', lineHeight: 1.3, color: 'var(--t-text-faint)' }}>sub-agents + Codex workers in parallel</span>
                </span>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: ultraActive ? SWARM_ACCENT : 'transparent', flexShrink: 0 }} />
              </button>
            </div>
          ) : null}
        </div>
      </ComposerPopover>
    </>
  );
}
