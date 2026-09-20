'use client';

import { useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { AcpModelPicker } from '../AcpModelPicker';
import {
  type ComposerModelGroup,
  type ComposerModelOption,
} from '../ModelThinkingChip';
import {
  workerModelForDisplay,
  type ComposerWorkerDefaults,
} from './worker-settings';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import {
  composerRuntimeLabel,
  isComposerEffortShortcut,
  providerMarkForLead,
  providerMarkForRuntime,
  stepComposerEffort,
  type ComposerProviderMark,
  type ResolvedComposerSelectorState,
} from './state';
import { LeadChip, WorkersChip } from './ComposerSelectorChips';
import { EffortSlider } from './EffortSlider';
import { ProviderMarkGlyph } from './provider-marks';
import { getRuntimeCapability, listDispatchableRuntimes, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { WORKER_START_OPTIONS, type WorkerStartMode } from '@/lib/operator/worker-start-mode';
import type { OrchestratorBackendSetting } from '../operator-defaults';

type VisiblePick =
  | { key: string; kind: 'lead-house'; group: ComposerModelGroup }
  | { key: string; kind: 'lead'; group: ComposerModelGroup; option: ComposerModelOption }
  | { key: string; kind: 'lead-searchable'; group: ComposerModelGroup }
  | { key: string; kind: 'worker'; runtime: OrchestratorRuntime };

type LeadPickerView =
  | { kind: 'providers' }
  | { kind: 'models'; groupKey: ComposerModelGroup['key'] }
  | { kind: 'effort'; groupKey: ComposerModelGroup['key'] };

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

function ChevronGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={expanded ? 'm6 15 6-6 6 6' : 'm9 18 6-6-6-6'} />
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
  defaults: ComposerWorkerDefaults;
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
  const [workersExpanded, setWorkersExpanded] = useState(false);
  const [leadView, setLeadView] = useState<LeadPickerView>({ kind: 'providers' });
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
  const selectedLeadGroup = useMemo(() => composerModelGroups.find((group) => (
    group.key === state.leadBackend
    || group.options.some((option) => option.backend === state.leadBackend && option.model === state.leadModelId)
  )) ?? composerModelGroups[0], [composerModelGroups, state.leadBackend, state.leadModelId]);
  const activeLeadGroup = leadView.kind === 'providers'
    ? null
    : composerModelGroups.find((group) => group.key === leadView.groupKey) ?? selectedLeadGroup;
  const providerRows = !normalizedQuery && leadView.kind === 'providers' ? composerModelGroups : [];
  const shownLeadRows = leadView.kind === 'effort'
    ? []
    : normalizedQuery ? leadRows : activeLeadGroup?.options.map((option) => ({ group: activeLeadGroup, option })) ?? [];
  const shownSearchableLeadRows = leadView.kind === 'effort'
    ? []
    : normalizedQuery ? searchableLeadRows : activeLeadGroup?.searchable ? [activeLeadGroup] : [];
  const workerRows = useMemo(() => listDispatchableRuntimes().filter((runtime) => {
    if (!normalizedQuery) return true;
    const capability = getRuntimeCapability(runtime);
    const model = workerModelForDisplay(runtime, defaults);
    return `${capability.label} ${runtime} ${model}`.toLowerCase().includes(normalizedQuery);
  }), [defaults, normalizedQuery]);
  const workersVisible = state.mode !== 'solo' && (workersExpanded || (normalizedQuery.length > 0 && workerRows.length > 0));
  const visiblePicks: VisiblePick[] = [
    ...providerRows.map((group) => ({ key: `lead-house:${group.key}`, kind: 'lead-house' as const, group })),
    ...shownLeadRows.map(({ group, option }) => ({ key: `lead:${option.value}`, kind: 'lead' as const, group, option })),
    ...shownSearchableLeadRows.map((group) => ({ key: `lead-searchable:${group.key}`, kind: 'lead-searchable' as const, group })),
    ...(workersVisible ? workerRows.map((runtime) => ({ key: `worker:${runtime}`, kind: 'worker' as const, runtime })) : []),
  ];
  const visibleActiveIndex = Math.min(activeIndex, Math.max(visiblePicks.length - 1, 0));
  const pickerOpen = open && !(state.mode === 'solo' && openTarget === 'workers');

  const setPopoverOpen = (next: boolean, target: PickerTarget = openTarget) => {
    setOpenTarget(target);
    setOpen(next);
    onOpenChange?.(next);
    if (next) {
      if (target === 'workers') setWorkersExpanded(true);
      if (target === 'lead') setLeadView({ kind: 'providers' });
      setActiveIndex(0);
      window.setTimeout(() => {
        if (target === 'lead') {
          searchRef.current?.focus();
          (selectedLeadRef.current?.parentElement ?? selectedLeadRef.current)
            ?.scrollIntoView?.({ block: 'nearest' });
        } else {
          workerSectionRef.current?.scrollIntoView?.({ block: 'nearest' });
          selectedWorkerRef.current?.scrollIntoView?.({ block: 'nearest' });
        }
      }, 0);
    }
    if (!next) {
      setQuery('');
      setAcpPicker(null);
      setWorkersExpanded(false);
      setLeadView({ kind: 'providers' });
    }
  };

  const togglePicker = (target: PickerTarget) => {
    if (open && openTarget !== target) {
      setQuery('');
      setAcpPicker(null);
    }
    setPopoverOpen(!(pickerOpen && openTarget === target), target);
  };

  const selectLead = (group: ComposerModelGroup, option: ComposerModelOption) => {
    if (option.backend === state.leadBackend) onModelChange?.(option.model ?? option.value);
    else onBackendChange?.(option.backend, option.model);
    setQuery('');
    setLeadView({ kind: 'effort', groupKey: group.key });
    setActiveIndex(0);
  };

  const selectLeadHouse = (group: ComposerModelGroup) => {
    if (group.searchable) setAcpPicker({ kind: 'lead', backend: group.key as OrchestratorBackendSetting });
    else setLeadView({ kind: 'models', groupKey: group.key });
    setActiveIndex(0);
  };

  const backFromLeadView = () => {
    setLeadView((view) => view.kind === 'effort'
      ? { kind: 'models', groupKey: view.groupKey }
      : { kind: 'providers' });
    setActiveIndex(0);
  };

  const selectWorker = (runtime: OrchestratorRuntime) => {
    onRuntimeChange(runtime);
    if (runtime === 'opencode') setAcpPicker({ kind: 'worker', backend: runtime });
    else setPopoverOpen(false);
  };

  const activateCurrent = () => {
    const item = visiblePicks[visibleActiveIndex];
    if (!item) return;
    if (item.kind === 'lead-house') selectLeadHouse(item.group);
    else if (item.kind === 'lead') selectLead(item.group, item.option);
    else if (item.kind === 'lead-searchable') setAcpPicker({ kind: 'lead', backend: item.group.key as OrchestratorBackendSetting });
    else selectWorker(item.runtime);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
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
      if (!normalizedQuery && leadView.kind !== 'providers') backFromLeadView();
      else {
        setPopoverOpen(false);
        onRequestTextareaFocus?.();
      }
    }
  };

  const runtime = defaults.defaultDispatchRuntime;
  const selectedWorkerSummary = composerRuntimeLabel(runtime);
  const leadHouseLabel = (group: ComposerModelGroup) => group.key === 'claude' ? 'Claude Code' : group.key === 'opencode' ? 'OpenCode' : group.label;
  const scrollStyle: CSSProperties = { overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none' };
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
            maxWidth: 'min(300px, calc(100vw * var(--zoom-inverse, 1) - 32px))',
            maxHeight: 'calc(100vh * var(--zoom-inverse, 1) - 56px)',
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
              <SectionLabel text={leadView.kind === 'models' ? `${leadHouseLabel(activeLeadGroup!)} models` : leadView.kind === 'effort' ? 'Effort' : 'Models'} />
              <div data-testid="composer-selector-lead-scroll" style={{ ...scrollStyle, flex: '0 1 auto', minHeight: 0, maxHeight: 184 }}>
                {!normalizedQuery && leadView.kind !== 'providers' ? (
                  <div style={{ display: 'flex', alignItems: 'center', minHeight: 26, paddingTop: 2, paddingRight: 8, paddingBottom: 2, paddingLeft: 8 }}>
                    <button data-testid="composer-selector-lead-back" type="button" onClick={backFromLeadView} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 22, paddingTop: 0, paddingRight: 4, paddingBottom: 0, paddingLeft: 0, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300 }}>
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 18-6-6 6-6" /></svg>
                      Back
                    </button>
                    {leadView.kind === 'effort' ? <span data-testid="composer-selector-lead-step" style={{ marginLeft: 4, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300 }}>{state.leadModelLabel}</span> : null}
                  </div>
                ) : null}
                {providerRows.map((group) => {
                  const selected = group.key === selectedLeadGroup.key;
                  const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead-house:${group.key}`);
                  const firstOption = group.options[0];
                  return (
                    <PickerRow
                      key={group.key}
                      testId={`lead-house-${group.key}`}
                      mark={providerMarkForLead(firstOption?.backend ?? group.key as OrchestratorBackendSetting, firstOption?.model ?? group.key)}
                      selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                      label={leadHouseLabel(group)}
                      meta=""
                      disabled={saving}
                      onClick={() => selectLeadHouse(group)}
                    />
                  );
                })}
                {leadView.kind !== 'effort' ? shownLeadRows.map(({ group, option }) => {
                  const selected = option.model === state.leadModelId && option.backend === state.leadBackend;
                  const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead:${option.value}`);
                  return (
                    <PickerRow
                      key={option.value}
                      rowRef={selected ? selectedLeadRef : undefined}
                      testId={`lead-row-${option.model ?? option.value}`}
                      mark={providerMarkForLead(option.backend, option.model ?? option.value)}
                      selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                      label={option.label}
                      meta={normalizedQuery ? group.label.toLowerCase() : ''}
                      disabled={saving}
                      onClick={() => selectLead(group, option)}
                    />
                  );
                }) : null}
                {leadView.kind !== 'effort' ? shownSearchableLeadRows.map((group) => {
                  const selected = group.key === state.leadBackend;
                  const pickIndex = visiblePicks.findIndex((entry) => entry.key === `lead-searchable:${group.key}`);
                  return (
                    <PickerRow
                      key={group.key}
                      rowRef={selected ? selectedLeadRef : undefined}
                      testId={`lead-row-${group.key}`}
                      mark={providerMarkForLead(group.key as OrchestratorBackendSetting, selected ? state.leadModelId : group.key)}
                      selected={selected}
                      highlighted={pickIndex === visibleActiveIndex}
                      label={leadHouseLabel(group)}
                      meta="live models"
                      disabled={saving}
                      onClick={() => setAcpPicker({ kind: 'lead', backend: group.key as OrchestratorBackendSetting })}
                    />
                  );
                }) : null}
                {!normalizedQuery && leadView.kind === 'effort' ? (
                  <EffortSlider state={state} onPick={onEffortChange} disabled={saving} />
                ) : null}
              </div>
              {state.mode !== 'solo' ? (
              <div ref={workerSectionRef} style={{ flexShrink: 0, marginTop: 4, borderTopWidth: 1, borderTopStyle: 'solid', borderTopColor: 'var(--t-border)', scrollMarginTop: 6 }}>
                <button
                  data-testid="composer-selector-workers-section"
                  type="button"
                  aria-expanded={workersVisible}
                  title={workersVisible ? 'Collapse workers' : `Workers: ${selectedWorkerSummary}`}
                  onClick={() => setWorkersExpanded((expanded) => !expanded)}
                  style={{ display: 'flex', alignItems: 'center', width: '100%', minHeight: 28, paddingTop: 5, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, borderWidth: 0, background: 'transparent', color: 'var(--t-text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textAlign: 'left', textTransform: 'uppercase' }}
                >
                  <span>Workers</span>
                  <span data-testid="composer-selector-workers-summary" style={{ marginLeft: 7, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, letterSpacing: '-0.05px', textTransform: 'none' }}>{selectedWorkerSummary}</span>
                  <span style={{ display: 'inline-flex', marginLeft: 'auto', color: 'var(--t-text-faint)' }}><ChevronGlyph expanded={workersVisible} /></span>
                </button>
                {workersVisible ? (
                  <div style={{ paddingRight: 2, paddingBottom: 3, paddingLeft: 6 }}>
                    <div data-testid="composer-selector-workers-scroll" style={{ ...scrollStyle, maxHeight: 112 }}>
                      {workerRows.map((workerRuntime) => {
                        const selected = workerRuntime === runtime;
                        const pickIndex = visiblePicks.findIndex((entry) => entry.key === `worker:${workerRuntime}`);
                        return (
                          <PickerRow
                            key={workerRuntime}
                            rowRef={selected ? selectedWorkerRef : undefined}
                            testId={`worker-row-${workerRuntime}`}
                            mark={providerMarkForRuntime(workerRuntime)}
                            selected={selected}
                            highlighted={pickIndex === visibleActiveIndex}
                            label={composerRuntimeLabel(workerRuntime)}
                            meta={getRuntimeCapability(workerRuntime).workerProvider}
                            disabled={saving}
                            onClick={() => selectWorker(workerRuntime)}
                          />
                        );
                      })}
                    </div>
                    <div style={{ paddingTop: 5, paddingRight: 8, paddingBottom: 3, paddingLeft: 8, color: 'var(--t-text-faint)', fontSize: 10, fontWeight: 300, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Start</div>
                    <div data-testid="composer-selector-worker-start" style={{ display: 'flex', gap: 2, paddingRight: 8, paddingLeft: 8 }}>
                      {WORKER_START_OPTIONS.map((option) => {
                        const selected = option.value === defaults.workerStartMode;
                        return (
                          <button key={option.value} type="button" aria-pressed={selected} title={option.detail} disabled={saving} onClick={() => onWorkerStartModeChange(option.value)} style={{ display: 'inline-flex', flex: 1, alignItems: 'center', justifyContent: 'center', height: 22, borderRadius: 6, borderWidth: 1, borderStyle: 'solid', borderColor: selected ? 'transparent' : 'var(--t-border)', background: selected ? 'var(--t-accent-soft)' : 'transparent', color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)', cursor: saving ? 'default' : 'pointer', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, opacity: saving ? 0.6 : 1, textAlign: 'center' }}>
                            {option.long}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
              ) : null}
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
