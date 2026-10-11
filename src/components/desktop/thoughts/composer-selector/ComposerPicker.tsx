'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AcpModelPicker } from '../AcpModelPicker';
import { useRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import { RuntimeToolsPanel } from '../../onboarding/RuntimeToolsPanel';
import { FloatingSurface } from '../../FloatingSurface';
import { runtimeForLead, visibleRuntimeInventory } from '@/lib/setup/runtime-recommendation';
import { findCatalogueModel, type CatalogueGroup } from '@/lib/orchestrator/acp-model-catalogue';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { WorkerStartMode } from '@/lib/operator/worker-start-mode';
import { COMPOSER_MODEL_GROUPS, type ComposerModelGroup, type ComposerModelOption } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { ComposerPopover } from '../chat-panel/ComposerPopover';
import { workerModelForDisplay, type ComposerWorkerDefaults } from './worker-settings';
import { composerRuntimeLabel, providerMarkForLead, providerMarkForRuntime, type ResolvedComposerSelectorState } from './state';
import { LeadChip, WorkersChip } from './ComposerSelectorChips';
import { ThinkingChip } from './ThinkingChip';
import { WorkerPickerOptions } from './WorkerPickerOptions';
import { ProviderMarkGlyph } from './provider-marks';
import { FavoriteGlyph, ModelPickerRow } from './ModelPickerRow';
import { useModelVisibility, openRouterModelKey } from './model-visibility';
import { modelFavoriteKey, readModelFavorites, useModelFavorites, type ModelFavorite } from './model-favorites';
import { CLAUDE_OPENROUTER_HOUSE, ClaudeWorkerModels, useClaudeWorkerProvider } from './ClaudeWorkerModels';
import type { WorkerModelChange } from './worker-settings';

type PickerTarget = 'lead' | 'workers';
interface House { id: string; label: string; ready: boolean; group?: ComposerModelGroup; runtime?: OrchestratorRuntime }
interface Pick { favorite: ModelFavorite; option?: ComposerModelOption; group?: ComposerModelGroup; runtime?: OrchestratorRuntime }
const WORKER_HOUSE_ORDER = ['codex', 'claude-code', 'antigravity', 'grok', 'opencode', '3code'];

export function ComposerPicker({ state, defaults, composerModelGroups, onModelChange, onBackendChange, onEffortChange, onWorkerModelChange, onWorkerEffortChange, onWorkerStartModeChange, onRequestTextareaFocus, onOpenChange, workerLocks, saving = false }: {
  state: ResolvedComposerSelectorState;
  defaults: ComposerWorkerDefaults;
  composerModelGroups: ComposerModelGroup[];
  onModelChange?: (model: string) => void;
  onBackendChange?: (backend: OrchestratorBackendSetting, model?: string) => void;
  onEffortChange: (effort: ThinkingEffort) => void;
  onRuntimeChange: (runtime: OrchestratorRuntime) => void;
  onWorkerModelChange: WorkerModelChange;
  onWorkerEffortChange?: (effort: ThinkingEffort, runtime: OrchestratorRuntime) => void;
  onWorkerStartModeChange: (mode: WorkerStartMode) => void;
  onRequestTextareaFocus?: () => void;
  onOpenChange?: (open: boolean) => void;
  workerLocks?: { runtime?: boolean; defaultModel: boolean; opencode: boolean; threecode: boolean; codexEffort: boolean; claudeEffort: boolean };
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [acpAvailable, setAcpAvailable] = useState(false);
  const { hidden: hiddenModels } = useModelVisibility();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch('/api/setup/orchestrator-backends').then(response => response.ok ? response.json() : null)
      .then(data => { if (alive) setAcpAvailable(data?.acp === true); }).catch(() => {});
    return () => { alive = false; };
  }, [open]);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [target, setTarget] = useState<PickerTarget>('lead');
  const [houseId, setHouseId] = useState<string>('codex');
  const [query, setQuery] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leadRef = useRef<HTMLButtonElement>(null);
  const workerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  const tools = useRuntimeInventory(open);
  const claude = useClaudeWorkerProvider(open && target === 'workers');
  const { favorites, toggleFavorite } = useModelFavorites(target);
  const installed = useMemo(() => visibleRuntimeInventory(tools.inventory ?? [], [defaults.defaultDispatchRuntime])
    .filter((item) => item.id !== 'pi' || item.available || item.installed || item.piSetup?.detected), [tools.inventory, defaults.defaultDispatchRuntime]);
  const ready = (runtime: string | null) => tools.inventory?.some((item) => item.id === runtime && item.available) === true;
  const claudeInstalled = tools.inventory?.some((item) => item.id === 'claude-code' && (item.available || item.installed || item.unavailableReason === 'needs_auth')) === true;
  const leadGroup = composerModelGroups.find((group) => group.key === state.leadBackend || group.options.some((option) => option.backend === state.leadBackend && option.model === state.leadModelId));
  const houses: House[] = target === 'lead'
    ? composerModelGroups.filter((group) => group === leadGroup || group.key === 'o8' || (group.key === 'acp' && acpAvailable) || installed.some((item) => item.id === runtimeForLead(group.key)))
      .map((group) => ({ id: group.key, label: group.key === 'claude' ? 'Claude Code' : group.label, ready: group.key === 'o8' || (group.key === 'acp' ? acpAvailable : ready(runtimeForLead(group.key))), group }))
    : installed.map((item) => ({ id: item.id, label: composerRuntimeLabel(item.id), ready: ready(item.id), runtime: item.id }))
      .sort((a, b) => (WORKER_HOUSE_ORDER.indexOf(a.id) < 0 ? WORKER_HOUSE_ORDER.length : WORKER_HOUSE_ORDER.indexOf(a.id)) - (WORKER_HOUSE_ORDER.indexOf(b.id) < 0 ? WORKER_HOUSE_ORDER.length : WORKER_HOUSE_ORDER.indexOf(b.id)));
  const house = houses.find((item) => item.id === houseId);
  const searchable = house?.group?.searchable || house?.runtime === 'opencode' || house?.runtime === '3code';
  const normalizedQuery = query.trim().toLowerCase();
  const modelLocked = (runtime: OrchestratorRuntime) => (workerLocks?.runtime && runtime !== defaults.defaultDispatchRuntime) || (runtime === 'opencode' ? workerLocks?.opencode : runtime === '3code' ? workerLocks?.threecode : workerLocks?.defaultModel);
  const nativePicks: Pick[] = houses.flatMap((item): Pick[] => {
    if (item.group) return item.group.options.map((option) => ({ option, group: item.group, favorite: { house: option.backend, id: option.model ?? option.value, label: option.label } }));
    const runtime = item.runtime!;
    if (runtime === 'opencode' || runtime === '3code') return [];
    // Lead groups can contain a paid carrier model. Native worker choices retain
    // their own identity even while Claude Code uses another provider.
    const group = (runtime === 'claude-code' ? COMPOSER_MODEL_GROUPS : composerModelGroups).find((entry) => entry.key === (runtime === 'claude-code' ? 'claude' : runtime));
    const options = group?.options.filter((option) => option.backend === (runtime === 'claude-code' ? 'claude' : runtime) && (!getRuntimeCapability(runtime).modelIdPattern || getRuntimeCapability(runtime).modelIdPattern!.test(option.model ?? option.value))) ?? [];
    return options.length ? options.map((option) => ({ option, runtime, favorite: { house: runtime, id: option.model ?? option.value, label: option.label } }))
      : [{ runtime, favorite: { house: runtime, id: getRuntimeCapability(runtime).defaultModel ?? '', label: runtime === 'pi' || runtime === 'pi-builtin' ? composerRuntimeLabel(runtime) : 'Runtime default' } }];
  });
  const favoriteKeys = new Set(favorites.map(modelFavoriteKey));
  const picks: Pick[] = houseId === 'favorites'
    ? favorites.flatMap((favorite): Pick[] => {
      const native = nativePicks.find((pick) => modelFavoriteKey(pick.favorite) === modelFavoriteKey(favorite));
      if (native) return [native];
      if (favorite.house === CLAUDE_OPENROUTER_HOUSE && houses.some((item) => item.runtime === 'claude-code')) return [{ favorite, runtime: 'claude-code' }];
      const source = houses.find((item) => item.id === favorite.house && (item.group?.searchable || item.runtime === 'opencode' || item.runtime === '3code'));
      return source ? [{ favorite, group: source.group, runtime: source.runtime }] : [];
    })
    : nativePicks.filter((pick) => normalizedQuery || (target === 'lead' ? pick.group?.key === houseId : pick.runtime === houseId));
  const shownPicks = picks.filter(pick => !((pick.favorite.house === CLAUDE_OPENROUTER_HOUSE || pick.favorite.id.startsWith('openrouter/')) && hiddenModels.includes(openRouterModelKey(pick.favorite.id))) || pick.favorite.id === state.leadModelId || pick.favorite.id === workerModelForDisplay(defaults.defaultDispatchRuntime, defaults)).filter((pick) => !normalizedQuery || `${pick.favorite.label} ${pick.favorite.id} ${pick.favorite.house}`.toLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(favoriteKeys.has(modelFavoriteKey(b.favorite))) - Number(favoriteKeys.has(modelFavoriteKey(a.favorite))));
  const isSelected = (pick: Pick) => target === 'lead' ? pick.favorite.house === state.leadBackend && pick.favorite.id === state.leadModelId
    : pick.runtime === defaults.defaultDispatchRuntime && (pick.favorite.house === CLAUDE_OPENROUTER_HOUSE
      ? claude.snapshot?.profile.source === 'openrouter' && pick.favorite.id === claude.snapshot.effectiveModel
      : (pick.runtime !== 'claude-code' || claude.snapshot?.profile.source === 'native') && pick.favorite.id === workerModelForDisplay(pick.runtime!, defaults));

  const close = () => { generation.current += 1; setOpen(false); setPending(null); setError(null); setQuery(''); onOpenChange?.(false); };
  const toggle = (nextTarget: PickerTarget) => {
    if (open && target === nextTarget) { close(); return; }
    generation.current += 1;
    setTarget(nextTarget);
    const savedFavorites = readModelFavorites(nextTarget);
    setThinkingOpen(false);
    setHouseId(savedFavorites.length > 0 ? 'favorites' : nextTarget === 'lead' ? leadGroup?.key ?? 'codex' : defaults.defaultDispatchRuntime);
    setQuery(''); setPending(null); setError(null); setToolsOpen(false); setOpen(true); onOpenChange?.(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };
  const commit = async (pick: Pick) => {
    const version = generation.current;
    if (target === 'lead') {
      if (pick.favorite.house === state.leadBackend && onModelChange) onModelChange(pick.favorite.id);
      else onBackendChange?.(pick.favorite.house as OrchestratorBackendSetting, pick.favorite.id);
    } else {
      const result = await onWorkerModelChange(pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? null : pick.favorite.id || null, pick.runtime, pick.runtime === 'claude-code'
        ? () => claude.applyModel(pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? 'openrouter' : 'native', pick.favorite.id)
        : undefined);
      if (result === false) throw new Error('The worker selection could not be saved. Reopen its house to check the current settings.');
    }
    if (generation.current === version) { close(); onRequestTextareaFocus?.(); }
  };
  const selectClaude = async (source: 'native' | 'openrouter', model: string) => {
    if (saving || pending || modelLocked('claude-code') || !claudeInstalled || (source === 'native' && !ready('claude-code'))) return;
    const version = generation.current;
    setPending(model); setError(null);
    try { await commit({ runtime: 'claude-code', favorite: { house: source === 'openrouter' ? CLAUDE_OPENROUTER_HOUSE : 'claude-code', id: model, label: model } }); }
    catch (failure) { if (generation.current === version) setError(failure instanceof Error ? failure.message : 'Could not save this selection.'); }
    finally { if (generation.current === version) setPending(null); }
  };
  const select = async (pick: Pick) => {
    const source = houses.find((item) => item.id === (target === 'lead' ? pick.group?.key : pick.runtime));
    const sourceReady = pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? claudeInstalled && claude.snapshot?.openrouterConfigured : source?.ready;
    if (saving || pending || !sourceReady || (pick.runtime && modelLocked(pick.runtime))) return;
    // A saved favorite must be checked against the runtime before reuse.
    const version = ++generation.current;
    setPending(modelFavoriteKey(pick.favorite)); setError(null);
    try {
      if ((!pick.option && (!pick.runtime || pick.runtime === 'opencode' || pick.runtime === '3code')) || pick.favorite.house === CLAUDE_OPENROUTER_HOUSE) {
        const url = pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? '/api/runtime/claude-code-models' : pick.runtime === '3code' ? '/api/runtime/threecode-models' : `/api/orchestrator/backend-models?backend=${encodeURIComponent(pick.favorite.house)}`;
        const response = await fetch(url, { cache: 'no-store' });
        const data = await response.json() as { groups?: CatalogueGroup[]; available?: boolean; error?: string };
        if (generation.current !== version) return;
        if (!response.ok || data.available === false || data.error || !findCatalogueModel(data.groups ?? [], pick.favorite.id)) {
          setError('This favorite is unavailable. Open its house to choose a current model.'); return;
        }
      }
      await commit(pick);
    } catch (failure) {
      if (generation.current === version) setError(failure instanceof Error ? failure.message : 'Could not check this model. Try its house again.');
    } finally { if (generation.current === version) setPending(null); }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (!event.defaultPrevented && event.key === 'Escape') {
      event.preventDefault(); close(); onRequestTextareaFocus?.(); return;
    }
    if (event.defaultPrevented || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;
    const rows = [...(contentRef.current?.querySelectorAll<HTMLButtonElement>('[data-model-choice]:not(:disabled)') ?? [])];
    if (!rows.length) return;
    if (event.key === 'Enter') {
      if (event.target instanceof HTMLInputElement) { event.preventDefault(); rows[0]?.click(); }
      return;
    }
    event.preventDefault();
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  const pickerOpen = open && (target === 'lead' || state.mode !== 'solo');
  return <>
    <LeadChip state={state} open={pickerOpen && target === 'lead'} saving={saving} buttonRef={leadRef} onClick={() => toggle('lead')} />
    <ThinkingChip state={state} saving={saving} onPick={onEffortChange} open={thinkingOpen} onOpenChange={(next) => { if (next) close(); setThinkingOpen(next); }} />
    {state.mode !== 'solo' ? <WorkersChip mode={state.mode} availableRuntimes={tools.inventory?.filter((item) => item.available).map((item) => item.id)} runtime={defaults.defaultDispatchRuntime} model={workerModelForDisplay(defaults.defaultDispatchRuntime, defaults)} open={pickerOpen && target === 'workers'} saving={saving} buttonRef={workerRef} onClick={() => toggle('workers')} /> : null}
    <ComposerPopover anchorRef={target === 'lead' ? leadRef : workerRef} open={pickerOpen} onClose={close} align="end">
      <FloatingSurface data-testid="composer-selector-popover" role="dialog" aria-label={target === 'lead' ? 'Orchestrator models' : 'Worker models'} style={{ width: 366, maxWidth: 'calc(100vw * var(--zoom-inverse, 1) - 32px)', borderRadius: 18, overflowY: 'hidden' }} contentStyle={{ display: 'flex', maxHeight: 'min(470px, calc(100vh * var(--zoom-inverse, 1) - 72px))', overflow: 'hidden' }}>
        <div role="toolbar" aria-label={target === 'lead' ? 'Orchestrator houses' : 'Worker houses'} aria-orientation="vertical" style={{ width: 44, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 8, paddingRight: 5, paddingBottom: 8, paddingLeft: 5, borderRight: '1px solid var(--t-border)', overflowY: 'auto', scrollbarWidth: 'none' }}>
          <HouseButton label="Favorites" selected={houseId === 'favorites'} onClick={() => { generation.current += 1; setHouseId('favorites'); setQuery(''); setError(null); setPending(null); }} onRight={() => contentRef.current?.querySelector('input')?.focus()}><FavoriteGlyph filled={houseId === 'favorites'} /></HouseButton>
          {houses.map((item) => <HouseButton key={item.id} label={item.label} testId={`${target === 'lead' ? 'lead' : 'worker'}-house-${item.id}`} selected={houseId === item.id} onClick={() => { generation.current += 1; setHouseId(item.id); setQuery(''); setError(null); setPending(null); }} onRight={() => contentRef.current?.querySelector('input')?.focus()}>
            <ProviderMarkGlyph mark={item.runtime ? providerMarkForRuntime(item.runtime) : providerMarkForLead(item.group!.options[0]?.backend ?? item.id as OrchestratorBackendSetting, item.group!.options[0]?.model ?? item.id)} size={17} />
          </HouseButton>)}
        </div>
        <div ref={contentRef} onKeyDown={keyDown} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', paddingTop: 8, paddingRight: 6, paddingBottom: 6, paddingLeft: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, paddingRight: 8, paddingLeft: 8, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}><span>{target === 'lead' ? 'Orchestrator' : 'Workers'}</span><span>{houseId === 'favorites' ? 'Favorites' : house?.label}</span></div>
          {target === 'lead' && house?.id === 'acp' ? <ModelPickerRow label="Use agent default" testId="lead-acp-default" selected={state.leadBackend === 'acp' && !state.leadModelId} disabled={!house.ready || saving || Boolean(pending)} onSelect={() => { void commit({ group: house.group, favorite: { house: 'acp', id: '', label: 'Agent default' } }); }} /> : null}
          {target === 'workers' && house?.runtime === 'claude-code' ? <ClaudeWorkerModels controller={claude} favorites={favorites} onToggleFavorite={toggleFavorite} nativeModel={workerModelForDisplay('claude-code', defaults)} nativeReady={ready('claude-code')} disabled={saving || Boolean(pending) || Boolean(modelLocked('claude-code')) || !claudeInstalled} onSelect={(source, model) => { void selectClaude(source, model); }} /> : searchable && house ? <AcpModelPicker key={`${target}:${house.id}`} backend={house.id} catalogueUrl={house.runtime === '3code' ? '/api/runtime/threecode-models' : undefined} width={310} embedded defaultProvider="openrouter" allowEffortVariants={target === 'lead'} favorites={favorites.filter((favorite) => favorite.house === house.id)} onToggleFavorite={toggleFavorite} value={target === 'lead' ? state.leadModelId : workerModelForDisplay(house.runtime!, defaults)} disabled={saving || Boolean(pending) || (house.runtime ? Boolean(modelLocked(house.runtime)) : !house.ready)}
            onSelect={(id) => { void select({ favorite: { house: house.id, id, label: id }, runtime: house.runtime, group: house.group }); }} /> : <>
            <input ref={searchRef} data-testid="composer-selector-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={houseId === 'favorites' ? 'Search favorites' : 'Search models'} aria-label="Search models" autoComplete="off" style={{ boxSizing: 'border-box', width: '100%', minHeight: 30, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, marginBottom: 4, borderWidth: 0, borderBottom: '1px solid var(--t-border)', background: 'transparent', outline: 'none', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300 }} />
            <div data-testid={target === 'lead' ? 'composer-selector-lead-scroll' : 'composer-selector-workers-scroll'} style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', maxHeight: 320 }}>
              {shownPicks.map((pick) => <ModelPickerRow key={modelFavoriteKey(pick.favorite)} testId={`${target === 'lead' ? 'lead' : 'worker'}-row-${pick.favorite.id || pick.runtime}`} label={pick.favorite.label} detail={pick.group?.key === 'o8' ? pick.option?.sub : pick.runtime === 'pi-builtin' ? 'Managed model · o8 allowance' : pick.runtime === 'pi' ? 'Your Pi CLI · runtime default' : houseId === 'favorites' || normalizedQuery ? target === 'lead' ? pick.group?.label : `${composerRuntimeLabel(pick.runtime!)}${pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? ' · OpenRouter' : ''}` : undefined} selected={isSelected(pick)} disabled={saving || Boolean(pending) || (pick.runtime ? (pick.favorite.house === CLAUDE_OPENROUTER_HOUSE ? !claudeInstalled || !claude.snapshot?.openrouterConfigured : !ready(pick.runtime)) || Boolean(modelLocked(pick.runtime)) : pick.group?.key !== 'o8' && !ready(runtimeForLead(pick.group!.key)))} favorite={favoriteKeys.has(modelFavoriteKey(pick.favorite))} onFavorite={pick.favorite.id ? () => toggleFavorite(pick.favorite) : undefined} onSelect={() => { void select(pick); }} />)}
              {!shownPicks.length ? <div style={{ padding: 12, fontSize: 11, color: 'var(--t-text-muted)' }}>{houseId === 'favorites' && !query ? 'Star a model to keep it here.' : 'No models match this search.'}</div> : null}
            </div>
          </>}
          {pending ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>Applying selection…</div> : null}
          {error ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{error}</div> : null}
          {house?.runtime && modelLocked(house.runtime) ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{workerLocks?.runtime && house.runtime !== defaults.defaultDispatchRuntime ? 'Worker runtime is fixed by your runtime settings.' : 'Worker model is set by the environment.'}</div> : null}
          {target === 'workers' && house?.runtime ? <WorkerPickerOptions key={house.id} runtime={house.runtime} defaults={defaults} saving={saving || Boolean(pending)} providerDefault={house.runtime === 'claude-code' && claude.provider === 'openrouter'} onEffortChange={onWorkerEffortChange} effortLocked={house.runtime === 'codex' ? workerLocks?.codexEffort : workerLocks?.claudeEffort} onStartChange={onWorkerStartModeChange} /> : null}
          {target === 'workers' && house?.runtime === '3code' ? <div style={{ padding: 8, fontSize: 10.5, lineHeight: '15px', color: 'var(--t-text-faint)' }}>Models come from your 3code providers. Configure OpenRouter in 3code to include it here.</div> : null}
          <button type="button" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', minHeight: 27, flexShrink: 0, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, marginTop: 4, borderWidth: 0, borderTop: '1px solid var(--t-border)', background: 'transparent', color: 'var(--t-text-muted)', fontFamily: 'var(--font-sans-system)', fontSize: 10.5, fontWeight: 300, cursor: 'pointer' }}><span>Coding tools</span><span>{toolsOpen ? '−' : '+'}</span></button>
          {toolsOpen ? <div style={{ overflowY: 'auto', scrollbarWidth: 'none', maxHeight: 130 }}><RuntimeToolsPanel inventory={tools.inventory} loading={tools.loading} error={tools.error} onRefresh={tools.refresh} /></div> : null}
        </div>
      </FloatingSurface>
    </ComposerPopover>
  </>;
}

function HouseButton({ label, testId, selected, onClick, onRight, children }: { label: string; testId?: string; selected: boolean; onClick: () => void; onRight: () => void; children: React.ReactNode }) {
  return <button data-testid={testId} type="button" title={label} aria-label={label} aria-pressed={selected} onClick={onClick}
    onKeyDown={(event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); onRight(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const index = buttons.indexOf(event.currentTarget);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, flexShrink: 0, padding: 0, borderWidth: 0, borderRadius: 9, background: selected ? 'var(--t-accent-soft)' : 'transparent', color: selected ? 'var(--t-accent)' : 'var(--t-text-muted)', cursor: 'pointer' }}>{children}</button>;
}
