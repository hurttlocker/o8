'use client';

import { useMemo, useRef, useState } from 'react';
import { AcpModelPicker } from '../AcpModelPicker';
import {
  EffortSlider,
  MODEL_EFFORT_LABELS,
  useComposerModelCatalogue,
  type ComposerModelGroup,
  type ComposerModelOption,
  type EffortStop,
} from '../ModelThinkingChip';
import {
  WORKER_START_OPTIONS,
  shortWorkerModelLabel,
  workerModelForDisplay,
  type DispatchDefaults,
} from '../ComposerFleetChips';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import {
  isComposerEffortShortcut,
  stepComposerEffort,
  type ResolvedComposerSelectorState,
} from './state';
import { getRuntimeCapability, listDispatchableRuntimes, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import type { OrchestratorBackendSetting } from '../operator-defaults';

type VisiblePick =
  | { key: string; kind: 'lead'; option: ComposerModelOption }
  | { key: string; kind: 'lead-searchable'; group: ComposerModelGroup }
  | { key: string; kind: 'worker'; runtime: OrchestratorRuntime };

type AcpPickerTarget =
  | { kind: 'lead'; backend: OrchestratorBackendSetting }
  | { kind: 'worker'; backend: OrchestratorRuntime };

function CheckGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

const effortStops = (state: ResolvedComposerSelectorState): EffortStop[] => state.effortOptions.map((effort) => ({
  kind: 'effort',
  effort,
  label: `${MODEL_EFFORT_LABELS[effort][0].toUpperCase()}${MODEL_EFFORT_LABELS[effort].slice(1)} effort`,
  sub: `${state.leadModelLabel} · ${state.effortOptions.indexOf(effort) + 1}/${state.effortOptions.length}`,
}));

export function ComposerPicker({
  state,
  defaults,
  onModelChange,
  onBackendChange,
  onEffortChange,
  onRuntimeChange,
  onWorkerModelChange,
  onWorkerStartModeChange,
  onRequestTextareaFocus,
  onOpenChange,
  saving = false,
}: {
  state: ResolvedComposerSelectorState;
  defaults: DispatchDefaults;
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ResolvedComposerSelectorState['effort']) => void;
  onRuntimeChange: (runtime: OrchestratorRuntime) => void;
  onWorkerModelChange: (model: string | null) => void;
  onWorkerStartModeChange: (mode: WorkerStartMode) => void;
  onRequestTextareaFocus?: () => void;
  onOpenChange?: (open: boolean) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [acpPicker, setAcpPicker] = useState<AcpPickerTarget | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { groups: composerModelGroups } = useComposerModelCatalogue();
  const normalizedQuery = query.trim().toLowerCase();
  const leadRows = useMemo(() => composerModelGroups.flatMap((group) => group.options.map((option) => ({ group, option })))
    .filter(({ group, option }) => !normalizedQuery || `${group.label} ${option.label} ${option.sub ?? ''}`.toLowerCase().includes(normalizedQuery)), [composerModelGroups, normalizedQuery]);
  const searchableLeadRows = useMemo(() => composerModelGroups.filter((group) => group.searchable && (
    !normalizedQuery || `${group.label} ${state.leadBackend === group.key ? state.leadModelLabel : ''}`.toLowerCase().includes(normalizedQuery)
  )), [composerModelGroups, normalizedQuery, state.leadBackend, state.leadModelLabel]);
  const workerRows = useMemo(() => listDispatchableRuntimes().filter((runtime) => {
    if (!normalizedQuery) return true;
    const capability = getRuntimeCapability(runtime);
    const model = workerModelForDisplay(runtime, defaults);
    return `${capability.label} ${runtime} ${model}`.toLowerCase().includes(normalizedQuery);
  }), [defaults, normalizedQuery]);
  const visiblePicks = useMemo<VisiblePick[]>(() => [
    ...leadRows.map(({ option }) => ({ key: `lead:${option.value}`, kind: 'lead' as const, option })),
    ...searchableLeadRows.map((group) => ({ key: `lead-searchable:${group.key}`, kind: 'lead-searchable' as const, group })),
    ...workerRows.map((runtime) => ({ key: `worker:${runtime}`, kind: 'worker' as const, runtime })),
  ], [leadRows, searchableLeadRows, workerRows]);
  const visibleActiveIndex = Math.min(activeIndex, Math.max(visiblePicks.length - 1, 0));

  const setPopoverOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      setActiveIndex(0);
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
    if (!next) {
      setQuery('');
      setAcpPicker(null);
    }
  };

  const selectLead = (option: ComposerModelOption) => {
    if (option.backend === state.leadBackend) onModelChange?.(option.model ?? option.value);
    else onBackendChange?.(option.backend, option.model);
    setPopoverOpen(false);
  };

  const selectWorker = (runtime: OrchestratorRuntime) => {
    onRuntimeChange(runtime);
    if (runtime === 'opencode') setAcpPicker({ kind: 'worker', backend: runtime });
    else setPopoverOpen(false);
  };

  const activateCurrent = () => {
    const item = visiblePicks[visibleActiveIndex];
    if (!item) return;
    if (item.kind === 'lead') selectLead(item.option);
    else if (item.kind === 'lead-searchable') setAcpPicker({ kind: 'lead', backend: item.group.key as OrchestratorBackendSetting });
    else selectWorker(item.runtime);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (isComposerEffortShortcut(event.nativeEvent)) {
      event.preventDefault();
      onEffortChange(stepComposerEffort(state.effort, state.effortOptions, event.shiftKey ? -1 : 1));
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visiblePicks.length === 0) return;
      setActiveIndex((current) => (
        event.key === 'ArrowDown'
          ? (current + 1) % visiblePicks.length
          : (current - 1 + visiblePicks.length) % visiblePicks.length
      ));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateCurrent();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setPopoverOpen(false);
      onRequestTextareaFocus?.();
    }
  };

  const effortOptions = effortStops(state);
  const selectedEffortIndex = Math.max(0, state.effortOptions.indexOf(state.effort));
  const runtime = defaults.defaultDispatchRuntime;

  return (
    <>
      <button
        ref={triggerRef}
        data-testid="composer-selector-picker"
        type="button"
        title={state.chipTitle}
        aria-label={`Composer picker: ${state.atRestText}`}
        aria-expanded={open}
        disabled={saving}
        onClick={() => setPopoverOpen(!open)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 22,
          paddingTop: 0,
          paddingRight: 6,
          paddingBottom: 0,
          paddingLeft: 6,
          borderRadius: 7,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: open ? 'var(--t-border)' : 'transparent',
          background: open ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-faint)',
          cursor: saving ? 'default' : 'pointer',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11,
          fontWeight: 300,
          letterSpacing: '-0.1px',
          whiteSpace: 'nowrap',
          flexShrink: 1,
          minWidth: 0,
          opacity: saving ? 0.6 : 1,
        }}
      >
        <span style={{ color: 'var(--t-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{state.leadModelLabel}</span>
        <span>{`· ${state.effort} / workers`}</span>
        <span style={{ color: 'var(--t-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {state.workerRuntimeLabel}{state.workerModelLabel ? ` · ${state.workerModelLabel}` : ''}
        </span>
        <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <ComposerPopover anchorRef={triggerRef} open={open} onClose={() => setPopoverOpen(false)} align="end">
        <div
          role="dialog"
          aria-label="Composer model and workers"
          onKeyDown={handleKeyDown}
          style={{
            width: 300,
            maxWidth: 'min(300px, calc(100vw - 32px))',
            maxHeight: 'min(620px, calc(100vh - 56px))',
            overflowY: 'auto',
            borderRadius: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-panel-border)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: 'var(--t-panel-shadow)',
            paddingTop: 6,
            paddingRight: 6,
            paddingBottom: 6,
            paddingLeft: 6,
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          {acpPicker ? (
            saving ? <div style={{ paddingTop: 12, paddingRight: 10, paddingBottom: 12, paddingLeft: 10, color: 'var(--t-text-faint)', fontSize: 11 }}>Saving selection…</div> : (
              <AcpModelPicker
                backend={acpPicker.backend}
                value={acpPicker.kind === 'lead' ? state.leadModelId : defaults.opencodeWorkerModel}
                width={288}
                onSelect={(model) => {
                  if (acpPicker.kind === 'lead') {
                    if (acpPicker.backend === state.leadBackend) onModelChange?.(model);
                    else onBackendChange?.(acpPicker.backend, model);
                  } else onWorkerModelChange(model);
                  setPopoverOpen(false);
                }}
              />
            )
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingTop: 4, paddingRight: 8, paddingBottom: 6, paddingLeft: 8, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-border)', marginBottom: 4 }}>
                <span style={{ color: 'var(--t-text-faint)' }}><SearchGlyph /></span>
                <input
                  ref={searchRef}
                  data-testid="composer-selector-search"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                  placeholder="Model or runtime…"
                  autoComplete="off"
                  style={{ flex: 1, minWidth: 0, borderWidth: 0, outline: 'none', background: 'transparent', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12.5, fontWeight: 300 }}
                />
              </div>
              <SectionLabel text="Lead" hint="effort is remembered per model" />
              {leadRows.map(({ group, option }) => {
                const selected = option.model === state.leadModelId && option.backend === state.leadBackend;
                const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead:${option.value}`);
                return (
                  <div key={option.value}>
                    <PickerRow
                      testId={`lead-row-${option.model ?? option.value}`}
                      selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                      label={option.label}
                      meta={`${group.label.toLowerCase()}${option.sub ? ` · ${option.sub}` : ''}`}
                      disabled={saving}
                      onClick={() => selectLead(option)}
                    />
                    {selected && !normalizedQuery && effortOptions.length > 0 ? (
                      <div style={{ marginTop: 2, marginRight: 6, marginBottom: 6, marginLeft: 27, borderRadius: 10, background: 'var(--t-bg-card)' }}>
                        <EffortSlider stops={effortOptions} index={selectedEffortIndex} onPick={(index) => {
                          const next = state.effortOptions[index];
                          if (next) onEffortChange(next);
                        }} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {searchableLeadRows.map((group) => {
                const selected = group.key === state.leadBackend;
                const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead-searchable:${group.key}`);
                return (
                  <div key={group.key}>
                    <PickerRow
                      testId={`lead-row-${group.key}`}
                      selected={selected}
                    highlighted={pickIndex === visibleActiveIndex}
                      label={selected ? state.leadModelLabel : group.label}
                      meta={selected ? group.label.toLowerCase() : 'live models'}
                      disabled={saving}
                      onClick={() => setAcpPicker({ kind: 'lead', backend: group.key as OrchestratorBackendSetting })}
                    />
                    {selected && !normalizedQuery && effortOptions.length > 0 ? (
                      <div style={{ marginTop: 2, marginRight: 6, marginBottom: 6, marginLeft: 27, borderRadius: 10, background: 'var(--t-bg-card)' }}>
                        <EffortSlider stops={effortOptions} index={selectedEffortIndex} onPick={(index) => {
                          const next = state.effortOptions[index];
                          if (next) onEffortChange(next);
                        }} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <SectionLabel text="Workers" hint="runtime for dispatched packets" />
              {workerRows.map((workerRuntime) => {
                const selected = workerRuntime === runtime;
                const pickIndex = visiblePicks.findIndex((entry) => entry.key === `worker:${workerRuntime}`);
                const rowModel = workerModelForDisplay(workerRuntime, defaults);
                return (
                  <PickerRow
                    key={workerRuntime}
                    testId={`worker-row-${workerRuntime}`}
                    selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                    label={getRuntimeCapability(workerRuntime).label}
                    meta={rowModel ? shortWorkerModelLabel(rowModel) : ''}
                    disabled={saving}
                    onClick={() => selectWorker(workerRuntime)}
                  />
                );
              })}
              <SectionLabel text="Start" />
              <div style={{ display: 'flex', gap: 2, marginTop: 4, marginRight: 8, marginBottom: 4, marginLeft: 27 }}>
                {WORKER_START_OPTIONS.map((option) => {
                  const selected = option.value === defaults.workerStartMode;
                  return (
                    <button key={option.value} type="button" aria-pressed={selected} disabled={saving} onClick={() => onWorkerStartModeChange(option.value)} style={{ flex: 1, height: 22, borderRadius: 6, borderWidth: 1, borderStyle: 'solid', borderColor: selected ? 'transparent' : 'var(--t-border)', background: selected ? 'var(--t-accent-soft)' : 'transparent', color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                      {option.value === 'huddle' ? 'Plan first' : option.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 10, paddingTop: 6, paddingRight: 8, paddingBottom: 2, paddingLeft: 8, marginTop: 4, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-border)', fontSize: 10, color: 'var(--t-text-faint)' }}>
                <span>⌥T effort</span><span>⇧⇥ mode</span><span>↑↓ ↵ pick</span>
              </div>
            </>
          )}
        </div>
      </ComposerPopover>
    </>
  );
}

function SectionLabel({ text, hint }: { text: string; hint?: string }) {
  return <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 6, paddingRight: 8, paddingBottom: 3, paddingLeft: 8, fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}><span>{text}</span>{hint ? <span style={{ textTransform: 'none', letterSpacing: '-0.05px' }}>{hint}</span> : null}</div>;
}

function PickerRow({ testId, selected, highlighted, label, meta, disabled, onClick }: { testId: string; selected: boolean; highlighted: boolean; label: string; meta: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button data-testid={testId} type="button" disabled={disabled} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 26, paddingTop: 3, paddingRight: 8, paddingBottom: 3, paddingLeft: 8, borderRadius: 8, borderWidth: 0, background: selected || highlighted ? 'var(--t-hover)' : 'transparent', color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans-system)', fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ width: 13, flexShrink: 0, color: 'var(--t-accent)', visibility: selected ? 'visible' : 'hidden' }}><CheckGlyph /></span>
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)' }}>{meta}</span>
    </button>
  );
}
