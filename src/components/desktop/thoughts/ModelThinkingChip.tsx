import { useRef, useState } from 'react';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import { type ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorBackendSetting } from './operator-defaults';
import { MODEL_IDS } from '@/lib/models';
import { useEntitlement } from '@/lib/entitlement/context';

const EFFORT_LABELS: Record<ThinkingEffort, string> = {
  adaptive: 'adaptive',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
  // "Extra" reads cleaner than "Xhigh" on the slider (Q ruling 2026-07-11,
  // matching the Claude Code reference).
  xhigh: 'extra',
  ultra: 'ultra',
};

// Adaptive sits BETWEEN medium and high — that's the band it auto-picks in,
// and its half-lit fourth bar reads the same way (operator, 2026-07-06).
// 'ultra' is codex gpt-5.6-sol-only (appended dynamically below) — not in the
// base list, so it never shows for Claude/Fable turns.
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
  ultra: 6,
};

const SWARM_ACCENT = 'var(--t-brand-orange, #FF5A1F)';
const MODEL_THINKING_MENU_WIDTH = 200;

// Synthetic model id for the free o8 backend — there is no underlying model name
// exposed in the UI (monetization doctrine: we own the brand, hide the model).
// This value is what `onModelChange` stores and what `activeModelOption` matches.
const O8_FREE_MODEL_ID = 'o8-free';

type ComposerModelOption = {
  value: string;
  label: string;
  backend: OrchestratorBackendSetting;
  model?: string;
  sub?: string;
  /** Compact name for the composer trigger (defaults to `label`). */
  triggerLabel?: string;
};

type ComposerModelGroup = {
  key: 'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8';
  label: string;
  options: ComposerModelOption[];
};

// Grouped by house (Q ruling 2026-07-11): a Claude drawer and a Codex drawer,
// models nested under each. Codex exposes Sol (flagship, Opus-class) AND Terra
// (Sonnet-class) as orchestrator-worthy picks — both run as the codex
// orchestrator model via resolveOrchestratorModelSync.
const COMPOSER_MODEL_GROUPS: ComposerModelGroup[] = [
  {
    key: 'claude',
    label: 'Claude',
    options: [
      { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5', backend: 'fable', model: MODEL_IDS.fableDefault, sub: 'flagship' },
      { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8', backend: 'claude', model: MODEL_IDS.orchestratorDefault, sub: 'deep reasoning' },
      { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5', backend: 'claude', model: MODEL_IDS.claudeQaDefault, sub: 'everyday' },
    ],
  },
  {
    key: 'codex',
    label: 'Codex',
    options: [
      { value: MODEL_IDS.raw.openAiGpt56Sol, label: 'GPT-5.6 Sol', triggerLabel: 'Sol', backend: 'codex', model: MODEL_IDS.raw.openAiGpt56Sol, sub: 'flagship · Fable-class' },
      { value: MODEL_IDS.raw.openAiGpt56Terra, label: 'GPT-5.6 Terra', triggerLabel: 'Terra', backend: 'codex', model: MODEL_IDS.raw.openAiGpt56Terra, sub: 'Sonnet-class worker' },
    ],
  },
  // OpenClaw + Hermes pulled from the picker (Q ruling 2026-07-16): neither
  // is on the one-click path the official CLIs are. OpenClaw's governed clone
  // needs its own gateway + credential story that broke three ways in one
  // night (invalid config key, model allowlist, SQLite auth migration);
  // Hermes is a Python-venv install that the 2026-07-07 storage cleanup
  // deleted outright while its wrapper script kept reporting "installed".
  // Both backend modules stay registered so existing threads keep working
  // and either can return when its setup story is one-click. Settings →
  // Operator Defaults still offers Hermes when a HEALTHY binary is present
  // (isHermesAvailable now exec-probes instead of existsSync).
  // The free house (operator ruling 2026-07-12): one conversational model that
  // streams with no subscription draw, so the operator can drive the full
  // orchestrator UI without burning Claude/Codex usage. Named only 'o8' — the
  // underlying model is never surfaced.
  {
    key: 'o8',
    label: 'o8',
    options: [
      { value: O8_FREE_MODEL_ID, label: 'o8', triggerLabel: 'o8', backend: 'o8', model: O8_FREE_MODEL_ID, sub: 'free · no usage' },
    ],
  },
];

function ThinkingBars({ effort, active = false }: { effort: ThinkingEffort; active?: boolean }) {
  const level = EFFORT_LEVEL[effort];
  const color = active
    ? (effort === 'max' || effort === 'ultra' ? SWARM_ACCENT : 'var(--t-accent)')
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

type EffortStop =
  | { kind: 'effort'; effort: ThinkingEffort; label: string; sub: string }
  | { kind: 'ultracode'; label: string; sub: string };

/**
 * Effort slider (Claude Code reference, Q ruling 2026-07-11). A horizontal
 * track of discrete stops — one per selectable effort — with a final purple
 * "Ultracode" notch that arms Swarm mode. The live title above updates as the
 * handle moves; click a stop or drag the handle to pick.
 *
 * (The animated glitch-fill inside the track that the reference shows at the
 * Ultracode tier is a deliberate follow-up pass — slider first.)
 */
function EffortSlider({
  stops,
  index,
  onPick,
}: {
  stops: EffortStop[];
  index: number;
  onPick: (index: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const last = stops.length - 1;
  const clamped = Math.max(0, Math.min(last, index));
  const active = stops[clamped];
  const atUltracode = active?.kind === 'ultracode';
  const accent = atUltracode ? SWARM_ACCENT : 'var(--t-accent)';

  const pickFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || last <= 0) return;
    const rect = el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onPick(Math.round(t * last));
  };

  const pct = last <= 0 ? 0 : (clamped / last) * 100;

  return (
    <div style={{ paddingLeft: 9, paddingRight: 9, paddingTop: 2, paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 9 }}>
        <span style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: atUltracode ? SWARM_ACCENT : 'var(--t-text)' }}>
          {active?.label}
        </span>
        <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.2 }}>
          {active?.sub}
        </span>
      </div>
      {/* Track — 8px inset each side so the handle centers on the end stops
          without clipping. Pointer-drag + click-to-stop. */}
      <div
        role="slider"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={clamped}
        aria-valuetext={active?.label}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); onPick(Math.min(last, clamped + 1)); }
          else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); onPick(Math.max(0, clamped - 1)); }
        }}
        style={{ position: 'relative', height: 22, marginLeft: 8, marginRight: 8, cursor: 'pointer', outline: 'none', touchAction: 'none' }}
        onPointerDown={(event) => {
          (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
          setDragging(true);
          pickFromClientX(event.clientX);
        }}
        onPointerMove={(event) => { if (dragging) pickFromClientX(event.clientX); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        {/* Rail */}
        <div ref={trackRef} style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 3, transform: 'translateY(-50%)', borderRadius: 999, background: 'color-mix(in srgb, var(--t-text-faint) 22%, transparent)' }} />
        {/* Filled portion */}
        <div style={{ position: 'absolute', top: '50%', left: 0, width: `${pct}%`, height: 3, transform: 'translateY(-50%)', borderRadius: 999, background: accent, transition: dragging ? 'none' : 'width 140ms cubic-bezier(0.22, 1, 0.36, 1)' }} />
        {/* Stops */}
        {stops.map((stop, i) => {
          const on = i <= clamped;
          const isUltra = stop.kind === 'ultracode';
          return (
            <span
              key={i}
              aria-hidden
              style={{
                position: 'absolute',
                top: '50%',
                left: `${last <= 0 ? 0 : (i / last) * 100}%`,
                width: isUltra ? 6 : 5,
                height: isUltra ? 6 : 5,
                borderRadius: 999,
                transform: 'translate(-50%, -50%)',
                background: on ? (isUltra ? SWARM_ACCENT : accent) : 'color-mix(in srgb, var(--t-text-faint) 40%, transparent)',
              }}
            />
          );
        })}
        {/* Handle */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            left: `${pct}%`,
            width: 13,
            height: 13,
            borderRadius: 999,
            transform: 'translate(-50%, -50%)',
            background: 'var(--t-panel-solid, #fff)',
            border: `2px solid ${accent}`,
            boxShadow: '0 1px 3px rgba(15, 23, 42, 0.18)',
            transition: dragging ? 'none' : 'left 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      </div>
    </div>
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
  split = false,
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
  /** Claude Code-style presentation (Q ruling 2026-07-11): model and thinking
      level render as two separate quiet-text triggers ("Fable 5" · "High")
      instead of one bordered chip with bars. Both open the shared menu. */
  split?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const splitRef = useRef<HTMLSpanElement>(null);
  const baseEffortOptions = adaptiveEnabled ? EFFORT_OPTIONS : EFFORT_OPTIONS.filter((option) => option !== 'adaptive');
  // 'ultra' (codex gpt-5.6-sol's internal-fan-out tier) is only selectable on the
  // codex backend, whose composer model is always Sol. Every other backend caps
  // at 'max' — see resolveCodexReasoningEffort / claudeEffortFlagValue.
  const options = activeBackend === 'codex' ? [...baseEffortOptions, 'ultra' as ThinkingEffort] : baseEffortOptions;
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
  // The composer trigger should name the actual MODEL, not the provider
  // (Q ruling 2026-07-11 — "you might need to know what model you're on").
  // Resolve it from the picked (backend, modelId); fall back to the provider
  // label only when nothing matches (e.g. a fresh 'auto' session before a pick).
  const activeModelOption = COMPOSER_MODEL_GROUPS
    .flatMap((g) => g.options)
    .find((o) => activeBackend === o.backend && (!o.model || normalizedModelId === o.model));
  const triggerModelLabel = activeModelOption?.triggerLabel ?? activeModelOption?.label ?? modelLabel;
  // Collide's aggregator is now the model you actually picked (Q ruling
  // 2026-07-11) — the label follows it, not a hardcoded house.
  const shortModelLabel = (activeModelOption?.triggerLabel ?? modelLabel).replace(/^Codex\s+/i, '').replace(/^GPT-5\.6\s+/i, '');
  const decideLabel = `${shortModelLabel} decides`;
  const modeLabel = collideActive ? 'Mixture of Agents' : ultraActive ? 'Ultracode' : 'Solo';
  // Which house drawer is open in the model picker. Defaults to the active
  // backend's house so the current model is visible on open.
  const [openHouse, setOpenHouse] = useState<'claude' | 'codex' | 'openclaw' | 'hermes' | 'o8'>(
    activeBackend === 'codex' || activeBackend === 'openclaw' || activeBackend === 'hermes' || activeBackend === 'o8'
      ? activeBackend
      : 'claude',
  );
  // Thinking levels are only KNOWN for the Claude-family and Codex backends
  // ('auto' resolves to one of them). Every other runtime uses its default
  // effort and the thinking trigger stays hidden — no bespoke picker for
  // levels we can't actually steer (Q ruling 2026-07-11).
  const thinkingKnown = activeBackend === 'claude' || activeBackend === 'fable'
    || activeBackend === 'codex' || activeBackend === 'auto';
  // o8 tiers (Q ruling 2026-07-12): Low = the free rail, High = the founders
  // rail. Founders default High, free defaults Low, and High never renders for
  // the free plan — the proxy enforces the same gate server-side, this is
  // just the honest UI for it. Mode rows (Solo/Collide) stay hidden for o8.
  const isO8Backend = activeBackend === 'o8';
  const { plan: entitlementPlan } = useEntitlement();
  const isFreePlan = entitlementPlan === 'free';
  // Hide the effort UI when the free o8 rail is active OR the backend has no
  // steerable thinking and isn't o8 (o8 keeps its own Low/High tier UI for
  // founders). OpenClaw/Hermes accept no effort, so the slider must not render
  // and pretend otherwise (adversarial review 2026-07-15).
  const hideEffortUi = (isO8Backend && isFreePlan) || (!thinkingKnown && !isO8Backend);
  const useSplit = split && !compact;

  // Effort slider stops (Q ruling 2026-07-11): one per selectable effort, then
  // a final "Ultracode" notch that arms Swarm mode. Swarm is no longer a
  // separate Mode row — it's the top of the slider.
  const effortStops: EffortStop[] = isO8Backend
    ? [
      { kind: 'effort', effort: 'low', label: 'Low', sub: 'free' },
      ...(!isFreePlan
        ? [{ kind: 'effort' as const, effort: 'high' as ThinkingEffort, label: 'High', sub: 'founders' }]
        : []),
    ]
    : [
      ...options.map((option): EffortStop => ({
        kind: 'effort',
        effort: option,
        label: EFFORT_LABELS[option].charAt(0).toUpperCase() + EFFORT_LABELS[option].slice(1),
        sub: option === 'adaptive' ? 'auto' : `${EFFORT_LEVEL[option]}/6`,
      })),
      ...(onSetSwarm ? [{ kind: 'ultracode' as const, label: 'Ultracode', sub: 'native sub-agents + every runtime’s workers, in parallel' }] : []),
    ];
  const currentEffortIndex = isO8Backend
    ? (effort === 'high' && !isFreePlan ? 1 : 0)
    : ultraActive
      ? effortStops.length - 1
      : Math.max(0, options.indexOf(effort));
  const handleEffortPick = (idx: number) => {
    const stop = effortStops[idx];
    if (!stop) return;
    if (stop.kind === 'ultracode') {
      onSetSwarm?.(true);
      onSetCollide?.(false);
      onEffortChange?.('xhigh');
    } else {
      onEffortChange?.(stop.effort);
      onSetSwarm?.(false);
    }
  };

  const quietTriggerStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    maxWidth: 180,
    paddingTop: 0,
    paddingRight: 5,
    paddingBottom: 0,
    paddingLeft: 5,
    borderWidth: 0,
    borderRadius: 6,
    background: active ? 'var(--t-hover)' : 'transparent',
    color: active ? 'var(--t-text-muted)' : 'var(--t-text-faint)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans-system)',
    fontSize: 11,
    fontWeight: 300,
    letterSpacing: '0',
    whiteSpace: 'nowrap',
    transition: 'color 140ms, background 140ms',
  });

  return (
    <>
      {useSplit ? (
        // Claude Code-style right cluster: "Fable 5   High" — two quiet text
        // triggers, no border/bars/chevron at rest. Both open the shared menu.
        <span ref={splitRef} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {ultraActive || collideActive ? <SwarmGlyph size={11} /> : null}
          <button
            type="button"
            onClick={() => { if (canOpen) setOpen((current) => !current); }}
            disabled={!canOpen}
            title={`${modelLabel} · ${modeLabel}`}
            aria-haspopup="menu"
            aria-expanded={open}
            style={quietTriggerStyle(open)}
            onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = open ? 'var(--t-text-muted)' : 'var(--t-text-faint)'; }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{triggerModelLabel}</span>
          </button>
          {thinkingKnown && onEffortChange ? (() => {
            // When swarm is armed the effort tier reads "Ultracode" (the
            // slider's top notch), not the raw base effort underneath it.
            const tierLabel = ultraActive
              ? 'Ultracode'
              : selectedLabel.charAt(0).toUpperCase() + selectedLabel.slice(1);
            return (
              <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                title={`${effortSectionLabel}: ${tierLabel}`}
                aria-haspopup="menu"
                aria-expanded={open}
                style={{ ...quietTriggerStyle(open), color: ultraActive ? SWARM_ACCENT : (open ? 'var(--t-text-muted)' : 'var(--t-text-faint)') }}
                onMouseEnter={(event) => { event.currentTarget.style.color = ultraActive ? SWARM_ACCENT : 'var(--t-text)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = ultraActive ? SWARM_ACCENT : (open ? 'var(--t-text-muted)' : 'var(--t-text-faint)'); }}
              >
                {tierLabel}
              </button>
            );
          })() : null}
        </span>
      ) : (
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
        {isO8Backend ? null : <ThinkingBars effort={effort} active={open || effort === 'max' || effort === 'ultra' || (isCodexBackend && effort === 'xhigh')} />}
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: canOpen ? 0.72 : 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      )}

      <ComposerPopover anchorRef={useSplit ? splitRef : buttonRef} open={open} onClose={() => setOpen(false)} align={useSplit ? 'end' : 'start'}>
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
                {COMPOSER_MODEL_GROUPS.map((group) => {
                  const houseOpen = openHouse === group.key;
                  const houseHasActive = group.options.some((o) => activeBackend === o.backend && (!o.model || normalizedModelId === o.model));
                  return (
                    <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {/* Drawer header — click to expand this house. */}
                      <button
                        type="button"
                        aria-expanded={houseOpen}
                        onClick={() => setOpenHouse(group.key)}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'minmax(0, 1fr) auto',
                          alignItems: 'center',
                          gap: 6,
                          minHeight: 24,
                          paddingTop: 2,
                          paddingRight: 6,
                          paddingBottom: 2,
                          paddingLeft: 7,
                          borderWidth: 0,
                          borderRadius: 8,
                          background: 'transparent',
                          color: 'var(--t-text)',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: 'var(--font-sans-system)',
                        }}
                        onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ fontSize: 13, fontWeight: 400, letterSpacing: '0', lineHeight: 1.2 }}>{group.label}</span>
                          {!houseOpen && houseHasActive ? <span style={{ width: 5, height: 5, borderRadius: 999, background: 'var(--t-accent)', flexShrink: 0 }} /> : null}
                        </span>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6, transform: houseOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)' }}>
                          <path d="m6 9 6 6 6-6" />
                        </svg>
                      </button>
                      {/* Models nested under the open house. */}
                      {houseOpen ? group.options.map((option) => {
                        const active = activeBackend === option.backend && (!option.model || normalizedModelId === option.model);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              if (option.model) onModelChange?.(option.model);
                              if (!active) onBackendChange?.(option.backend);
                              // Codex/Sol keeps ultra available; Terra + any Claude
                              // model cap at max — drop a stale ultra selection.
                              if (option.model !== MODEL_IDS.raw.openAiGpt56Sol && effort === 'ultra') onEffortChange?.('max');
                              // Backends without fan-out must clear Collide/Swarm:
                              // a persisted `collide` flag replaces the selected
                              // backend with 'collide' at send time, so the turn
                              // would never reach o8/OpenClaw/Hermes (adversarial
                              // review 2026-07-15).
                              if (option.backend === 'o8' || option.backend === 'openclaw' || option.backend === 'hermes') {
                                onSetCollide?.(false);
                                onSetSwarm?.(false);
                              }
                              // o8 auto tier (Q ruling 2026-07-12): founders land on
                              // High, free lands on Low — the server enforces the
                              // same gate regardless.
                              if (option.backend === 'o8') {
                                onEffortChange?.(isFreePlan ? 'low' : 'high');
                              }
                              setOpen(false);
                            }}
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(0, 1fr) auto',
                              alignItems: 'center',
                              gap: 6,
                              minHeight: 26,
                              paddingTop: 3,
                              paddingRight: 6,
                              paddingBottom: 3,
                              paddingLeft: 18,
                              borderWidth: 0,
                              borderRadius: 8,
                              background: active ? 'var(--t-accent-soft)' : 'transparent',
                              color: active ? 'var(--t-accent)' : 'var(--t-text)',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'var(--font-sans-system)',
                            }}
                            onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
                            onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                              <span style={{ fontSize: 13, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.label}</span>
                              {option.sub ? <span style={{ fontSize: 9, fontWeight: 300, letterSpacing: '0', lineHeight: 1.2, color: active ? 'var(--t-accent)' : 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{option.sub}</span> : null}
                            </span>
                            <span style={{ width: 6, height: 6, borderRadius: 999, background: active ? 'var(--t-accent)' : 'transparent', flexShrink: 0 }} />
                          </button>
                        );
                      }) : null}
                    </div>
                  );
                })}
              </div>
              {hideEffortUi ? null : (
                <div style={{ marginTop: 4, paddingLeft: 7, paddingRight: 7, paddingTop: 6, paddingBottom: 2, borderTop: '1px solid var(--t-divider-subtle)' }}>
                  <div style={{ fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
                </div>
              )}
            </>
          ) : (
            <div style={{ paddingLeft: 7, paddingRight: 7, paddingTop: 2, paddingBottom: 6, borderBottom: '1px solid var(--t-divider-subtle)' }}>
              <div style={{ fontSize: 13.5, fontWeight: 300, letterSpacing: '0', color: 'var(--t-text)', lineHeight: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel}</div>
              <div style={{ marginTop: 2, fontSize: 9.5, fontWeight: 260, letterSpacing: '0', color: 'var(--t-text-faint)', lineHeight: 1.25 }}>{effortSectionLabel}</div>
            </div>
          )}
          {onEffortChange && !hideEffortUi ? (
            <EffortSlider stops={effortStops} index={currentEffortIndex} onPick={handleEffortPick} />
          ) : null}

          {/* Mode section removed (Q 2026-07-17): Solo / Multitask /
              Mixture of Agents live in the composer's "+" switcher now —
              this picker is models + thinking only. */}
        </div>
      </ComposerPopover>
    </>
  );
}
