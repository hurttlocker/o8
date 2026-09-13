'use client';

import { useMemo, useRef, useState, type Ref } from 'react';
import { AcpModelPicker } from '../AcpModelPicker';
import {
  type ComposerModelGroup,
  type ComposerModelOption,
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
  providerMarkForLead,
  providerMarkForRuntime,
  stepComposerEffort,
  type ComposerProviderMark,
  type ResolvedComposerSelectorState,
} from './state';
import { LeadChip, WorkersChip } from './ComposerSelectorChips';
import { EffortSegments } from './EffortSegments';
import { ProviderMarkGlyph } from './provider-marks';
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

type PickerTarget = 'lead' | 'workers';

export function ComposerPicker({
  state,
  defaults,
  composerModelGroups,
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
  composerModelGroups: ComposerModelGroup[];
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
  const [openTarget, setOpenTarget] = useState<PickerTarget>('lead');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [acpPicker, setAcpPicker] = useState<AcpPickerTarget | null>(null);
  const leadTriggerRef = useRef<HTMLButtonElement | null>(null);
  const workerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const selectedLeadRef = useRef<HTMLButtonElement | null>(null);
  const workerSectionRef = useRef<HTMLDivElement | null>(null);
  const selectedWorkerRef = useRef<HTMLButtonElement | null>(null);
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
  const pickerOpen = open && !(state.mode === 'solo' && openTarget === 'workers');

  const setPopoverOpen = (next: boolean, target: PickerTarget = openTarget) => {
    setOpenTarget(target);
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      setActiveIndex(0);
      window.setTimeout(() => {
        if (target === 'lead') {
          searchRef.current?.focus();
          selectedLeadRef.current?.scrollIntoView?.({ block: 'nearest' });
        } else {
          workerSectionRef.current?.scrollIntoView?.({ block: 'nearest' });
          selectedWorkerRef.current?.scrollIntoView?.({ block: 'nearest' });
        }
      }, 0);
    }
    if (!next) {
      setQuery('');
      setAcpPicker(null);
    }
  };

  const togglePicker = (target: PickerTarget) => {
    if (open && openTarget !== target) {
      setQuery('');
      setAcpPicker(null);
    }
    setPopoverOpen(!(pickerOpen && openTarget === target), target);
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
      const nextEffort = stepComposerEffort(state.effort, state.effortOptions, event.shiftKey ? -1 : 1);
      if (nextEffort !== state.effort) onEffortChange(nextEffort);
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

  const runtime = defaults.defaultDispatchRuntime;
  const anchorRef = openTarget === 'workers' ? workerTriggerRef : leadTriggerRef;

  return (
    <>
      <LeadChip
        state={state}
        open={pickerOpen && openTarget === 'lead'}
        saving={saving}
        buttonRef={leadTriggerRef}
        onClick={() => togglePicker('lead')}
      />
      {state.mode !== 'solo' ? (
        <WorkersChip
          mode={state.mode}
          runtime={runtime}
          open={pickerOpen && openTarget === 'workers'}
          saving={saving}
          buttonRef={workerTriggerRef}
          onClick={() => togglePicker('workers')}
        />
      ) : null}
      <ComposerPopover anchorRef={anchorRef} open={pickerOpen} onClose={() => setPopoverOpen(false)} align="end">
        <div
          data-testid="composer-selector-popover"
          role="dialog"
          aria-label="Composer model and workers"
          onKeyDown={handleKeyDown}
          style={{
            width: 300,
            maxWidth: 'min(300px, calc(100vw - 32px))',
            height: 460,
            maxHeight: 'calc(100vh - 56px)',
            display: 'flex',
            flexDirection: 'column',
            overflowY: 'hidden',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingTop: 4, paddingRight: 8, paddingBottom: 6, paddingLeft: 8, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-border)', marginBottom: 4 }}>
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
              <div data-testid="composer-selector-lead-scroll" style={{ flex: '1 1 auto', minHeight: 78, overflowY: 'auto', overscrollBehavior: 'contain' }}>
                {leadRows.map(({ group, option }) => {
                  const selected = option.model === state.leadModelId && option.backend === state.leadBackend;
                  const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead:${option.value}`);
                  return (
                    <div key={option.value}>
                      <PickerRow
                        rowRef={selected ? selectedLeadRef : undefined}
                        testId={`lead-row-${option.model ?? option.value}`}
                        mark={providerMarkForLead(option.backend, option.model ?? option.value)}
                        selected={selected}
                        highlighted={pickIndex === visibleActiveIndex}
                        label={option.label}
                        meta={`${group.label.toLowerCase()}${option.sub ? ` · ${option.sub}` : ''}`}
                        disabled={saving}
                        onClick={() => selectLead(option)}
                      />
                      {selected && !normalizedQuery && (
                        state.effortOptions.length > 0 || state.lockedEffortOptions.length > 0
                      ) ? (
                        <EffortSegments state={state} onPick={onEffortChange} disabled={saving} />
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
                        rowRef={selected ? selectedLeadRef : undefined}
                        testId={`lead-row-${group.key}`}
                        mark={providerMarkForLead(
                          group.key as OrchestratorBackendSetting,
                          selected ? state.leadModelId : group.key,
                        )}
                        selected={selected}
                        highlighted={pickIndex === visibleActiveIndex}
                        label={selected ? state.leadModelLabel : group.label}
                        meta={selected ? group.label.toLowerCase() : 'live models'}
                        disabled={saving}
                        onClick={() => setAcpPicker({ kind: 'lead', backend: group.key as OrchestratorBackendSetting })}
                      />
                      {selected && !normalizedQuery && (
                        state.effortOptions.length > 0 || state.lockedEffortOptions.length > 0
                      ) ? (
                        <EffortSegments state={state} onPick={onEffortChange} disabled={saving} />
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <SectionLabel text="Workers" hint="runtime for dispatched packets" />
              <div ref={workerSectionRef} data-testid="composer-selector-workers-scroll" style={{ height: 130, maxHeight: 130, flexShrink: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollMarginTop: 6 }}>
                {workerRows.map((workerRuntime) => {
                  const selected = workerRuntime === runtime;
                  const pickIndex = visiblePicks.findIndex((entry) => entry.key === `worker:${workerRuntime}`);
                  const rowModel = workerModelForDisplay(workerRuntime, defaults);
                  return (
                    <PickerRow
                      key={workerRuntime}
                      rowRef={selected ? selectedWorkerRef : undefined}
                      testId={`worker-row-${workerRuntime}`}
                      mark={providerMarkForRuntime(workerRuntime)}
                      selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                      label={getRuntimeCapability(workerRuntime).label}
                      meta={rowModel ? shortWorkerModelLabel(rowModel) : ''}
                      disabled={saving}
                      onClick={() => selectWorker(workerRuntime)}
                    />
                  );
                })}
              </div>
              <SectionLabel text="Start" />
              <div style={{ display: 'flex', gap: 2, flexShrink: 0, marginTop: 4, marginRight: 8, marginBottom: 4, marginLeft: 27 }}>
                {WORKER_START_OPTIONS.map((option) => {
                  const selected = option.value === defaults.workerStartMode;
                  return (
                    <button key={option.value} type="button" aria-pressed={selected} disabled={saving} onClick={() => onWorkerStartModeChange(option.value)} style={{ flex: 1, height: 22, borderRadius: 6, borderWidth: 1, borderStyle: 'solid', borderColor: selected ? 'transparent' : 'var(--t-border)', background: selected ? 'var(--t-accent-soft)' : 'transparent', color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
                      {option.value === 'huddle' ? 'Plan first' : option.label}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', gap: 10, flexShrink: 0, paddingTop: 6, paddingRight: 8, paddingBottom: 2, paddingLeft: 8, marginTop: 4, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-border)', fontSize: 10, color: 'var(--t-text-faint)' }}>
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
  return <div style={{ display: 'flex', justifyContent: 'space-between', flexShrink: 0, paddingTop: 6, paddingRight: 8, paddingBottom: 3, paddingLeft: 8, fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-text-faint)' }}><span>{text}</span>{hint ? <span style={{ textTransform: 'none', letterSpacing: '-0.05px' }}>{hint}</span> : null}</div>;
}

function PickerRow({ rowRef, testId, mark, selected, highlighted, label, meta, disabled, onClick }: { rowRef?: Ref<HTMLButtonElement>; testId: string; mark: ComposerProviderMark; selected: boolean; highlighted: boolean; label: string; meta: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button ref={rowRef} data-testid={testId} aria-pressed={selected} type="button" disabled={disabled} onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 26, paddingTop: 3, paddingRight: 8, paddingBottom: 3, paddingLeft: 8, borderRadius: 8, borderWidth: 0, background: selected || highlighted ? 'var(--t-hover)' : 'transparent', color: selected ? 'var(--t-text)' : 'var(--t-text-secondary)', cursor: disabled ? 'default' : 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans-system)', fontSize: 12.5, fontWeight: 300, letterSpacing: '-0.1px', opacity: disabled ? 0.6 : 1 }}>
      <span style={{ display: 'inline-flex', width: 13, flexShrink: 0, color: 'currentColor' }}><ProviderMarkGlyph mark={mark} /></span>
      <span>{label}</span>
      <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.2px', color: 'var(--t-text-faint)' }}>{meta}</span>
      <span style={{ display: 'inline-flex', width: 13, flexShrink: 0, color: 'var(--t-accent)', visibility: selected ? 'visible' : 'hidden' }}><CheckGlyph /></span>
    </button>
  );
}
