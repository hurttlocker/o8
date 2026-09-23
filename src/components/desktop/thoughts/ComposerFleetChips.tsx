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

import { useRef, useState } from 'react';

import { COMPOSER_MODES, type ComposerMode } from './composer-mode';
import { composerRuntimeLabel } from './composer-selector/state';
import { AcpModelPicker } from './AcpModelPicker';
import { ComposerPopover } from './chat-panel/ComposerPopover';
import {
  getRuntimeCapability,
  listDispatchableRuntimes,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import { WORKER_START_OPTIONS, type WorkerStartMode } from '@/lib/operator/worker-start-mode';
import {
  FALLBACK_COMPOSER_WORKER_DEFAULTS,
  shortWorkerModelLabel,
  workerModelForDisplay,
  type ComposerWorkerDefaults,
} from './composer-selector/worker-settings';

type FleetPickerView = 'runtimes' | 'opencode-model' | 'threecode-model';

export type DispatchDefaults = ComposerWorkerDefaults;
export const FALLBACK_DISPATCH_DEFAULTS = FALLBACK_COMPOSER_WORKER_DEFAULTS;
export { shortWorkerModelLabel, workerModelForDisplay };

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

function BackGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
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
        aria-label={`Mode: ${activeSpec.long}`}
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
        {activeSpec.short}
      </button>

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
        <div
          style={{
            width: 240,
            maxWidth: 'min(240px, calc(100vw - 32px))',
            borderRadius: 14,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-popover-surface)',
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
                <span style={{ flex: 1, minWidth: 0 }}>{spec.long}</span>
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
export function FleetWorkerChip({
  compact = false,
  defaults = FALLBACK_COMPOSER_WORKER_DEFAULTS,
  workerModelLocked = false,
  saving = false,
  onRuntimeChange,
  onWorkerModelChange,
  onWorkerStartModeChange,
}: {
  compact?: boolean;
  defaults?: ComposerWorkerDefaults;
  workerModelLocked?: boolean;
  saving?: boolean;
  onRuntimeChange?: (runtime: OrchestratorRuntime) => void;
  onWorkerModelChange?: (model: string | null, runtime?: OrchestratorRuntime) => void;
  onWorkerStartModeChange?: (mode: WorkerStartMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<FleetPickerView>('runtimes');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selectRuntime = (runtime: OrchestratorRuntime) => {
    onRuntimeChange?.(runtime);
    if (runtime === 'opencode') setView('opencode-model');
    else if (runtime === '3code') setView('threecode-model');
    else setOpen(false);
  };
  const selectWorkerModel = (modelId: string | null) => {
    if (workerModelLocked) return;
    if (view === 'threecode-model') onWorkerModelChange?.(modelId, '3code');
    else onWorkerModelChange?.(modelId);
    setOpen(false);
  };
  const selectWorkerStartMode = (workerStartMode: WorkerStartMode) => {
    onWorkerStartModeChange?.(workerStartMode);
  };

  const runtime = defaults.defaultDispatchRuntime;
  const runtimeLabel = getRuntimeCapability(runtime).label;
  const model = workerModelForDisplay(runtime, defaults);
  const startOption = WORKER_START_OPTIONS.find((option) => option.value === defaults.workerStartMode)
    ?? WORKER_START_OPTIONS[0];
  const chipText = compact
    ? `${runtimeLabel} · ${startOption.short}`
    : `${model ? `${runtimeLabel} · ${shortWorkerModelLabel(model)}` : runtimeLabel} · ${startOption.short}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={`Fleet worker: ${runtimeLabel}${model ? ` — ${model}` : ''}. Starts: ${startOption.long}.`}
        aria-label={`Fleet worker: ${runtimeLabel}${model ? `, model ${model}` : ', runtime default'}. Starts: ${startOption.long}`}
        aria-expanded={open}
        onClick={() => {
          setView('runtimes');
          setOpen((current) => !current);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 20,
          paddingLeft: 7,
          paddingRight: 7,
          borderRadius: 6,
          borderWidth: 0,
          background: 'transparent',
          color: 'var(--t-text-faint)',
          cursor: 'pointer',
          // One visual step BELOW the orchestrator model chip (10.5/300): the
          // worker is subordinate — same size/weight read as if the fleet model
          // were driving the orchestrator (Q re-ruling 2026-08-05).
          fontSize: 9.5,
          fontWeight: 300,
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
        <LayersGlyph size={10} />
        {chipText}
      </button>

      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end">
        <div
          style={{
            width: 268,
            maxWidth: 'min(268px, calc(100vw - 32px))',
            borderRadius: 14,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-popover-surface)',
            boxShadow: 'var(--t-panel-shadow)',
            overflow: 'hidden',
            paddingTop: 6,
            paddingRight: 5,
            paddingBottom: 5,
            paddingLeft: 5,
          }}
        >
          {view === 'runtimes' ? (
            <>
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
                Worker starts
              </div>
              <div style={{ display: 'flex', gap: 3, paddingLeft: 4, paddingRight: 4, paddingBottom: 3 }}>
                {WORKER_START_OPTIONS.map((option) => {
                  const active = option.value === defaults.workerStartMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      title={option.detail}
                      aria-pressed={active}
                      onClick={() => { void selectWorkerStartMode(option.value); }}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: 25,
                        paddingLeft: 5,
                        paddingRight: 5,
                        borderRadius: 7,
                        borderWidth: 0,
                        background: active ? 'var(--t-hover)' : 'transparent',
                        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-sans-system)',
                        fontSize: 10.5,
                        fontWeight: active ? 500 : 400,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {option.long}
                    </button>
                  );
                })}
              </div>
              <div style={{
                minHeight: 24,
                paddingTop: 2,
                paddingRight: 8,
                paddingBottom: 6,
                paddingLeft: 8,
                fontSize: 10,
                lineHeight: 1.35,
                color: 'var(--t-text-faint)',
                fontFamily: 'var(--font-sans-system)',
              }}>
                {startOption.detail}
              </div>
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
                    <span style={{ flexShrink: 0 }}>{composerRuntimeLabel(id)}</span>
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
                      {rowModel ? shortWorkerModelLabel(rowModel) : ''}
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
                Multitask packets dispatch to this runtime. Choose OpenCode to set its worker model here.
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', minHeight: 28, paddingRight: 4, paddingLeft: 2 }}>
                <button
                  type="button"
                  aria-label="Back to fleet runtimes"
                  onClick={() => setView('runtimes')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 26,
                    height: 24,
                    borderWidth: 0,
                    borderRadius: 7,
                    background: 'transparent',
                    color: 'var(--t-text-secondary)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <BackGlyph />
                </button>
                <div style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-sans-system)', fontSize: 11.5, color: 'var(--t-text)' }}>
                  {view === 'threecode-model' ? '3code worker model' : 'OpenCode worker model'}
                </div>
                {(view === 'threecode-model' ? defaults.threecodeWorkerModel : defaults.opencodeWorkerModel) ? (
                  <button
                    type="button"
                    disabled={workerModelLocked || saving}
                    onClick={() => { void selectWorkerModel(null); }}
                    style={{
                      borderWidth: 0,
                      background: 'transparent',
                      color: workerModelLocked ? 'var(--t-text-faint)' : 'var(--t-accent)',
                      cursor: workerModelLocked ? 'default' : 'pointer',
                      fontFamily: 'var(--font-sans-system)',
                      fontSize: 10,
                      paddingTop: 3,
                      paddingRight: 5,
                      paddingBottom: 3,
                      paddingLeft: 5,
                    }}
                  >
                    Clear pin
                  </button>
                ) : null}
              </div>
              {workerModelLocked ? (
                <div style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 14, paddingLeft: 12, color: 'var(--t-text-faint)', fontFamily: 'var(--font-sans-system)', fontSize: 11 }}>
                  This worker model is set by the machine environment.
                </div>
              ) : (
                <AcpModelPicker
                  backend={view === 'threecode-model' ? '3code' : 'opencode'}
                  catalogueUrl={view === 'threecode-model' ? '/api/runtime/threecode-models' : undefined}
                  value={view === 'threecode-model' ? defaults.threecodeWorkerModel : defaults.opencodeWorkerModel}
                  width={258}
                  onSelect={(modelId) => { void selectWorkerModel(modelId); }}
                />
              )}
            </>
          )}
        </div>
      </ComposerPopover>
    </>
  );
}
