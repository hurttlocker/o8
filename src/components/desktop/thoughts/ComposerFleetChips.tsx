'use client';

/**
 * ComposerModeChip + FleetWorkerChip — the right-cluster pair (Q 2026-08-05).
 *
 * The operating-mode chip moved OUT of the "+" cluster to the right side so
 * the composer reads as one runtime story: mode → who does the work → which
 * orchestrator model drives it. When the mode dispatches (Multitask / MoA),
 * the fleet chip appears beside it showing the worker runtime + the model the
 * fleet is riding at the time; clicking it selects the dispatch worker without
 * a trip to Settings. Solo hides the fleet chip — nothing dispatches.
 *
 * Worker-model display mirrors the dispatch ladder in scheduling.ts
 * (per-packet model → operator pin → capability default) for DISPLAY only;
 * dispatch truth stays server-side.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { COMPOSER_MODES, type ComposerMode } from './composer-mode';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import {
  getRuntimeCapability,
  listDispatchableRuntimes,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';

interface DispatchDefaults {
  defaultDispatchRuntime: OrchestratorRuntime;
  defaultDispatchModel: string;
  opencodeWorkerModel: string | null;
}

const FALLBACK_DEFAULTS: DispatchDefaults = {
  defaultDispatchRuntime: 'codex',
  defaultDispatchModel: '',
  opencodeWorkerModel: null,
};

/** Last path segment of a provider-qualified model id, for chip width. */
function shortModelLabel(model: string): string {
  const cut = model.lastIndexOf('/');
  return cut >= 0 ? model.slice(cut + 1) : model;
}

function workerModelForDisplay(runtime: OrchestratorRuntime, defaults: DispatchDefaults): string {
  if (runtime === 'opencode' && defaults.opencodeWorkerModel) {
    return defaults.opencodeWorkerModel;
  }
  if (defaults.defaultDispatchModel && runtime === defaults.defaultDispatchRuntime) {
    return defaults.defaultDispatchModel;
  }
  return getRuntimeCapability(runtime).defaultModel ?? '';
}

function LayersGlyph({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
      <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
      <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * Standalone operating-mode chip (Solo / Multitask / MoA). Visual clone of
 * the chip that used to sit beside "+" — Solo renders faint, active modes
 * render accent — but it now owns its own switcher popover.
 */
export function ComposerModeChip({
  mode,
  onModeChange,
}: {
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hoveredMode, setHoveredMode] = useState<ComposerMode | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const activeSpec = COMPOSER_MODES.find((m) => m.id === mode) ?? COMPOSER_MODES[0];
  const captionSpec = (hoveredMode ? COMPOSER_MODES.find((m) => m.id === hoveredMode) : undefined) ?? activeSpec;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={activeSpec.sublabel}
        aria-label={`Mode: ${activeSpec.label}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          height: 20,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 6,
          borderWidth: 0,
          background: mode === 'solo' ? 'transparent' : 'var(--t-accent-soft)',
          color: mode === 'solo' ? 'var(--t-text-faint)' : 'var(--t-accent)',
          cursor: 'pointer',
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: '-0.05px',
          fontFamily: 'var(--font-sans-system)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
        onMouseEnter={(event) => { if (mode === 'solo') event.currentTarget.style.color = 'var(--t-text)'; }}
        onMouseLeave={(event) => { if (mode === 'solo') event.currentTarget.style.color = 'var(--t-text-faint)'; }}
      >
        {activeSpec.chip}
      </button>

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
        <div
          style={{
            width: 240,
            maxWidth: 'min(240px, calc(100vw - 32px))',
            borderRadius: 14,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: 'var(--t-panel-shadow)',
            overflow: 'hidden',
            paddingTop: 6,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
          }}
        >
          {COMPOSER_MODES.map((spec) => {
            const active = spec.id === mode;
            return (
              <button
                key={spec.id}
                type="button"
                onClick={() => { onModeChange(spec.id); setOpen(false); }}
                onMouseEnter={(event) => { setHoveredMode(spec.id); event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { setHoveredMode(null); event.currentTarget.style.background = active ? 'var(--t-hover)' : 'transparent'; }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  minHeight: 26,
                  paddingTop: 0,
                  paddingRight: 8,
                  paddingBottom: 0,
                  paddingLeft: 8,
                  borderRadius: 7,
                  borderWidth: 0,
                  background: active ? 'var(--t-hover)' : 'transparent',
                  color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  fontSize: 12.5,
                  fontWeight: active ? 500 : 400,
                  letterSpacing: '-0.1px',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>{spec.label}</span>
                <span style={{ width: 13, flexShrink: 0, color: 'var(--t-accent)', visibility: active ? 'visible' : 'hidden' }}>
                  <CheckGlyph />
                </span>
              </button>
            );
          })}
          <div style={{
            minHeight: 15,
            paddingTop: 3,
            paddingLeft: 8,
            paddingRight: 8,
            fontSize: 10,
            lineHeight: 1.25,
            color: 'var(--t-text-faint)',
            fontFamily: 'var(--font-sans-system)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {captionSpec.sublabel}
          </div>
        </div>
      </ComposerPopover>
    </>
  );
}

/**
 * Fleet worker chip — visible only when the mode dispatches. Shows the worker
 * runtime + the model the fleet rides right now; the popover selects the
 * dispatch runtime (persisted as the operator's `defaultDispatchRuntime`).
 */
export function FleetWorkerChip({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [defaults, setDefaults] = useState<DispatchDefaults>(FALLBACK_DEFAULTS);
  const [saving, setSaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/operator-defaults', { cache: 'no-store' });
      if (!res.ok) return;
      const payload = await res.json() as { values?: Partial<DispatchDefaults> };
      const values = payload.values ?? {};
      setDefaults({
        defaultDispatchRuntime: (values.defaultDispatchRuntime as OrchestratorRuntime) || 'codex',
        defaultDispatchModel: typeof values.defaultDispatchModel === 'string' ? values.defaultDispatchModel : '',
        opencodeWorkerModel: typeof values.opencodeWorkerModel === 'string' && values.opencodeWorkerModel
          ? values.opencodeWorkerModel
          : null,
      });
    } catch { /* chip keeps last known values */ }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => { if (open) void refetch(); }, [open, refetch]);

  const selectRuntime = useCallback(async (runtime: OrchestratorRuntime) => {
    setDefaults((current) => ({ ...current, defaultDispatchRuntime: runtime }));
    setOpen(false);
    setSaving(true);
    try {
      await fetch('/api/panel/operator-defaults', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultDispatchRuntime: runtime }),
      });
    } catch { /* next refetch restores truth */ } finally {
      setSaving(false);
      void refetch();
    }
  }, [refetch]);

  const runtime = defaults.defaultDispatchRuntime;
  const runtimeLabel = getRuntimeCapability(runtime).label;
  const model = workerModelForDisplay(runtime, defaults);
  const chipText = compact
    ? runtimeLabel
    : model ? `${runtimeLabel} · ${shortModelLabel(model)}` : runtimeLabel;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={`Fleet worker: ${runtimeLabel}${model ? ` — ${model}` : ''}. Click to change the dispatch runtime.`}
        aria-label={`Fleet worker: ${runtimeLabel}`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 20,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-faint)',
          cursor: 'pointer',
          fontSize: 10.5,
          fontWeight: 500,
          letterSpacing: '-0.05px',
          fontFamily: 'var(--font-sans-system)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          opacity: saving ? 0.6 : 1,
          transition: 'color 120ms, opacity 120ms',
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = 'var(--t-text)'; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = 'var(--t-text-faint)'; }}
      >
        <LayersGlyph />
        {chipText}
      </button>

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
        <div
          style={{
            width: 268,
            maxWidth: 'min(268px, calc(100vw - 32px))',
            borderRadius: 14,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: 'var(--t-panel-shadow)',
            overflow: 'hidden',
            paddingTop: 6,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
          }}
        >
          <div style={{
            paddingLeft: 8,
            paddingRight: 8,
            paddingBottom: 4,
            fontSize: 10,
            letterSpacing: '0.3px',
            textTransform: 'uppercase',
            color: 'var(--t-text-faint)',
            fontFamily: 'var(--font-sans-system)',
          }}>
            Fleet worker
          </div>
          {listDispatchableRuntimes().map((id) => {
            const active = id === runtime;
            const rowModel = workerModelForDisplay(id, defaults);
            return (
              <button
                key={id}
                type="button"
                onClick={() => { void selectRuntime(id); }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = active ? 'var(--t-hover)' : 'transparent'; }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  minHeight: 26,
                  paddingTop: 0,
                  paddingRight: 8,
                  paddingBottom: 0,
                  paddingLeft: 8,
                  borderRadius: 7,
                  borderWidth: 0,
                  background: active ? 'var(--t-hover)' : 'transparent',
                  color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans-system)',
                  fontSize: 12.5,
                  fontWeight: active ? 500 : 400,
                  letterSpacing: '-0.1px',
                }}
              >
                <span style={{ flexShrink: 0 }}>{getRuntimeCapability(id).label}</span>
                <span style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 10.5,
                  color: 'var(--t-text-faint)',
                  textAlign: 'right',
                }}>
                  {rowModel ? shortModelLabel(rowModel) : ''}
                </span>
                <span style={{ width: 13, flexShrink: 0, color: 'var(--t-accent)', visibility: active ? 'visible' : 'hidden' }}>
                  <CheckGlyph />
                </span>
              </button>
            );
          })}
          <div style={{
            minHeight: 15,
            paddingTop: 3,
            paddingLeft: 8,
            paddingRight: 8,
            fontSize: 10,
            lineHeight: 1.25,
            color: 'var(--t-text-faint)',
            fontFamily: 'var(--font-sans-system)',
          }}>
            Multitask packets dispatch to this runtime. Model pins live in Settings → Dispatch.
          </div>
        </div>
      </ComposerPopover>
    </>
  );
}
