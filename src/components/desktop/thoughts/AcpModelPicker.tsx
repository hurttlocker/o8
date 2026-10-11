'use client';

/**
 * Searchable model picker for model-agnostic ACP backends.
 *
 * Lives outside ModelThinkingChip on purpose: that file is already near the
 * 800-line ceiling, and this is a different interaction anyway. The other
 * composer houses are 2-3 fixed options and belong in a drawer; opencode
 * reports 523 base models across 4 providers, which is a search box.
 *
 * Model ids come from the live agent (`/api/orchestrator/backend-models`),
 * never from a literal in this repo. That is not just tidiness — opencode's
 * `session/set_model` accepts unknown ids silently and then produces an empty
 * turn, so anything not in the agent's own list is a silent failure waiting to
 * happen. There is deliberately no free-text entry here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  filterCatalogue,
  catalogueSize,
  findCatalogueModel,
  shortModelLabel,
  stripRedundantProviderPrefix,
  type CatalogueGroup,
  type CatalogueModel,
} from '@/lib/orchestrator/acp-model-catalogue';

import { useModelVisibility, openRouterModelKey } from './composer-selector/model-visibility';
import { ModelPickerRow } from './composer-selector/ModelPickerRow';
import { useModelFavorites, type ModelFavorite } from './composer-selector/model-favorites';

/**
 * Recently picked model ids, newest first, per backend.
 *
 * 391 models is a search box, but the model you drive daily should be one
 * click — searching for the same id every session is the difference between a
 * picker that works and one that is pleasant. Kept in localStorage rather than
 * operator defaults because this is per-surface muscle memory, not
 * configuration worth syncing or validating.
 */
const RECENTS_LIMIT = 5;

function recentsKey(backend: string): string {
  return `o8:acp-model-recents:${backend}`;
}

function readRecents(backend: string): string[] {
  try {
    const raw = window.localStorage.getItem(recentsKey(backend));
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string').slice(0, RECENTS_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberRecent(backend: string, modelId: string): void {
  try {
    const next = [modelId, ...readRecents(backend).filter((v) => v !== modelId)].slice(0, RECENTS_LIMIT);
    window.localStorage.setItem(recentsKey(backend), JSON.stringify(next));
  } catch {
    // A picker that cannot remember is still a working picker.
  }
}

interface AcpModelPickerProps {
  backend: string;
  value: string | null;
  onSelect: (modelId: string) => void;
  repoPath?: string | null;
  width?: number;
  catalogueUrl?: string;
  embedded?: boolean;
  defaultProvider?: string;
  allowEffortVariants?: boolean;
  disabled?: boolean;
  manageVisibility?: boolean;
  favorites?: ModelFavorite[];
  onToggleFavorite?: (favorite: ModelFavorite) => void;
}

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';
type CatalogueSort = 'most-popular' | 'newest';
const ROW_TEXT = { fontFamily: 'var(--font-sans-system)', fontWeight: 300 } as const;
const PAGE_SIZE = 16;

function providerLabel(provider: string): string {
  return ({ openrouter: 'OpenRouter', opencode: 'OpenCode', xai: 'xAI' } as Record<string, string>)[provider]
    ?? provider.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function filterButtonStyle(selected: boolean) {
  return { ...ROW_TEXT, minHeight: 24, paddingTop: 2, paddingRight: 6, paddingBottom: 2, paddingLeft: 6, borderWidth: 0, borderRadius: 6, background: selected ? 'var(--t-hover)' : 'transparent', color: selected ? 'var(--t-text)' : 'var(--t-text-muted)', cursor: 'pointer', fontSize: 10 } as const;
}

function modelDetail(model: CatalogueModel): string {
  const meta = model.metadata;
  const details: string[] = [];
  if (meta?.contextLength) details.push(`${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(meta.contextLength)} context`);
  if (meta?.inputPricePerMillion !== undefined && meta.outputPricePerMillion !== undefined) {
    const price = (amount: number) => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', maximumFractionDigits: amount < 1 ? 3 : 2 }).format(amount);
    details.push(`${price(meta.inputPricePerMillion)} / ${price(meta.outputPricePerMillion)} per 1M`);
  }
  return details.join(' · ') || (model.id.startsWith(`${model.provider}/`) ? model.id.slice(model.provider.length + 1) : model.id);
}

function isStealth(model: CatalogueModel): boolean {
  return model.metadata?.stealth === true || model.id.startsWith('openrouter/stealth/');
}

export function AcpModelPicker({ backend, value, onSelect, repoPath, width = 320, catalogueUrl, embedded = false, defaultProvider, allowEffortVariants = true, disabled = false, favorites: suppliedFavorites, onToggleFavorite, manageVisibility = false }: AcpModelPickerProps) {
  const visibility = useModelVisibility();
  const hiddenIds = new Set(visibility.hidden);
  const [groups, setGroups] = useState<CatalogueGroup[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<CatalogueSort>('most-popular');
  const [rankingAvailable, setRankingAvailable] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [freeOnly, setFreeOnly] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadedCatalogueKey, setLoadedCatalogueKey] = useState<string | null>(null);
  const [catalogueTime, setCatalogueTime] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogueKey = `${backend}\u0000${catalogueUrl ?? ''}\u0000${repoPath ?? ''}`;
  const previousCatalogueKey = useRef(catalogueKey);
  const valueRef = useRef(value);
  useEffect(() => { valueRef.current = value; }, [value]);
  const ownFavorites = useModelFavorites(`catalogue:${backend}`);
  const favorites = suppliedFavorites ?? ownFavorites.favorites;
  const favoriteIds = new Set(favorites.filter((favorite) => favorite.house === backend).map((favorite) => favorite.id));
  const toggleFavorite = onToggleFavorite ?? ownFavorites.toggleFavorite;

  useEffect(() => { setRecents(readRecents(backend)); }, [backend]);
  useEffect(() => {
    let cancelled = false;
    const changed = previousCatalogueKey.current !== catalogueKey;
    previousCatalogueKey.current = catalogueKey;
    setState('loading'); setGroups([]); setError(null); setLimit(PAGE_SIZE);
    if (changed) { setSelectedProvider(null); setFreeOnly(false); setShowAll(false); }
    const params = new URLSearchParams(catalogueUrl ? { sort } : { backend, sort });
    if (repoPath) params.set('repoPath', repoPath);
    if (reloadKey > 0) params.set('refresh', '1');
    fetch(`${catalogueUrl ?? '/api/orchestrator/backend-models'}${params.size ? `?${params}` : ''}`, { cache: 'no-store' })
      .then(async (res) => { if (!res.ok) throw new Error('Could not read the model list.'); return res.json(); })
      .then((data) => {
        if (cancelled) return;
        if (data?.available === false) { setState('unavailable'); return; }
        if (data?.error) { setError(String(data.error)); setState('error'); return; }
        const next: CatalogueGroup[] = Array.isArray(data?.groups) ? data.groups : [];
        setGroups(next); setRankingAvailable(data?.rankingAvailable === true); setLoadedCatalogueKey(catalogueKey); setCatalogueTime(Date.now() / 1000); setState('ready');
        if (defaultProvider) setSelectedProvider((current) => !changed && current && next.some((group) => group.provider === current) ? current
          : next.find((group) => group.provider === valueRef.current?.split('/')[0])?.provider ?? next.find((group) => group.provider === defaultProvider)?.provider ?? null);
      })
      .catch((err: unknown) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setState('error'); } });
    return () => { cancelled = true; };
    // Selection changes do not require another runtime probe.
  }, [backend, catalogueKey, catalogueUrl, defaultProvider, repoPath, reloadKey, sort]);
  const reload = useCallback(() => { setState('loading'); setReloadKey((key) => key + 1); }, []);
  useEffect(() => { if (state === 'ready') searchRef.current?.focus(); }, [state]);
  const choose = (id: string) => {
    if (disabled) return;
    rememberRecent(backend, id); onSelect(id);
  };
  const active = useMemo(() => findCatalogueModel(groups, value), [groups, value]);
  const filtered = useMemo(() => filterCatalogue(groups, query), [groups, query]);
  const searching = Boolean(query.trim());
  const scoped = searching || !selectedProvider ? filtered : filtered.filter((group) => group.provider === selectedProvider);
  const visibleGroups = scoped.map((group) => ({ ...group, models: group.models.filter((model) => {
    if (!manageVisibility && group.provider === 'openrouter' && hiddenIds.has(openRouterModelKey(model.id)) && model.id !== active?.model.id) return false;
    if (freeOnly && model.metadata?.free !== true) return false;
    // Default suggestions are curated; a search always reaches the whole catalogue.
    if (!searching && rankingAvailable && !showAll && group.provider === 'openrouter' && model.metadata?.compatible !== true && model.id !== active?.model.id && !favoriteIds.has(model.id) && !isStealth(model)) return false;
    return true;
  }) })).filter((group) => group.models.length > 0);
  const showDirectory = !searching && selectedProvider === null;
  const ready = state === 'ready' && loadedCatalogueKey === catalogueKey;
  const total = catalogueSize(groups);
  const recentModels = recents.map((id) => findCatalogueModel(groups, id)).filter((entry): entry is NonNullable<typeof entry> => entry !== null && (entry.model.provider !== 'openrouter' || !hiddenIds.has(openRouterModelKey(entry.model.id)) || entry.model.id === active?.model.id));
  const knownFree = groups.some((group) => group.models.some((model) => model.metadata?.free === true));
  const badge = (model: CatalogueModel) => {
    const age = model.metadata?.created ? catalogueTime - model.metadata.created : Infinity;
    return <>{age >= 0 && age < 14 * 86_400 ? <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--t-accent)' }}>NEW</span> : null}{model.metadata?.free ? <span style={{ flexShrink: 0, fontSize: 8, color: 'var(--t-text-muted)' }}>FREE</span> : null}</>;
  };
  const row = (model: CatalogueModel) => <div key={model.id} style={{ paddingRight: 4, paddingLeft: 4 }}>
    {manageVisibility ? <button type="button" aria-pressed={!hiddenIds.has(openRouterModelKey(model.id))} aria-label={`${hiddenIds.has(openRouterModelKey(model.id)) ? 'Show' : 'Hide'} ${model.label}`} onClick={() => visibility.toggle(model.id)} style={{ ...filterButtonStyle(false), display: 'flex', width: '100%', justifyContent: 'space-between', gap: 12, textAlign: 'left', minHeight: 36 }}><span style={{ overflowWrap: 'anywhere' }}>{model.label}</span><span style={{ color: 'var(--t-text-muted)' }}>{hiddenIds.has(openRouterModelKey(model.id)) ? 'Hidden' : 'Shown'}</span></button> : <ModelPickerRow label={stripRedundantProviderPrefix(model.label, model.provider)} detail={modelDetail(model)} title={model.id} selected={active?.model.id === model.id} disabled={disabled} favorite={favoriteIds.has(model.id)} onFavorite={() => toggleFavorite({ house: backend, id: model.id, label: model.label })} onSelect={() => choose(model.id)} badge={badge(model)} />}
    {allowEffortVariants && model.efforts.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingTop: 2, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}>
      {model.efforts.map((variant) => <button key={variant.id} type="button" title={variant.id} disabled={disabled} onClick={() => choose(variant.id)} style={filterButtonStyle(value === variant.id)}>{variant.effort}</button>)}
    </div> : null}
  </div>;
  return <div style={{ width: embedded ? '100%' : `min(${width}px, calc(100vw * var(--zoom-inverse, 1) - 24px))`, display: 'flex', flexDirection: 'column', flex: '1 1 auto', maxHeight: 390, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
    <div style={{ paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}>
      <input ref={searchRef} type="text" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE_SIZE); }} placeholder={ready ? `Search all ${total} models` : 'Search models'} aria-label="Search models" style={{ ...ROW_TEXT, boxSizing: 'border-box', width: '100%', minHeight: 28, paddingTop: 4, paddingRight: 0, paddingBottom: 4, paddingLeft: 0, borderWidth: 0, borderBottom: '1px solid var(--t-border)', background: 'transparent', color: 'var(--t-text)', fontSize: 12, outline: 'none' }} />
    </div>
    {ready && selectedProvider && !searching ? <button type="button" aria-label="Change model provider" onClick={() => { setSelectedProvider(null); setLimit(PAGE_SIZE); }} style={{ ...ROW_TEXT, display: 'flex', justifyContent: 'space-between', minHeight: 24, paddingTop: 2, paddingRight: 8, paddingBottom: 2, paddingLeft: 8, borderWidth: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 10.5, cursor: 'pointer' }}><span>{providerLabel(selectedProvider)}</span><span>⌄</span></button> : null}
    {ready && rankingAvailable && selectedProvider === 'openrouter' ? <div aria-label="Catalogue filters" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2, paddingRight: 6, paddingBottom: 4, paddingLeft: 6 }}>
      <button type="button" title="Ranked by tokens processed this week" aria-pressed={sort === 'most-popular'} onClick={() => setSort('most-popular')} style={filterButtonStyle(sort === 'most-popular')}>Popular</button>
      <button type="button" aria-pressed={sort === 'newest'} onClick={() => setSort('newest')} style={filterButtonStyle(sort === 'newest')}>Newest</button>
      <span style={{ flex: 1 }} />
      <button type="button" aria-pressed={!showAll} onClick={() => { setShowAll(false); setLimit(PAGE_SIZE); }} style={filterButtonStyle(!showAll)}>Coding</button>
      <button type="button" aria-pressed={showAll} onClick={() => { setShowAll(true); setLimit(PAGE_SIZE); }} style={filterButtonStyle(showAll)}>All</button>
      {knownFree ? <button type="button" aria-pressed={freeOnly} onClick={() => { setFreeOnly(!freeOnly); setLimit(PAGE_SIZE); }} style={filterButtonStyle(freeOnly)}>Free</button> : null}
    </div> : null}
    {ready && selectedProvider === 'openrouter' && !showDirectory ? <div style={{ fontSize: 9.5, color: 'var(--t-text-muted)', paddingRight: 8, paddingBottom: 3, paddingLeft: 8 }}>Prices per 1M tokens · input / output</div> : null}
    {visibility.error ? <StatusLine text={visibility.error} /> : null}
    {!ready && state !== 'error' && state !== 'unavailable' ? <StatusLine text="Reading the agent’s model list…" /> : null}
    {state === 'unavailable' ? <StatusLine text={`${backend} is not installed on this machine.`} /> : null}
    {state === 'error' ? <StatusLine text={error ?? 'Could not read the model list.'} onRetry={reload} /> : null}
    {ready && total === 0 ? <StatusLine text={backend === 'acp' ? 'This agent does not expose a model list. Use its default model.' : 'The agent reported no models. Check its provider auth.'} onRetry={reload} /> : null}
    {ready && total > 0 && !showDirectory && !visibleGroups.length ? <StatusLine text={searching ? `No model matches “${query}”.` : 'No models match these filters.'} /> : null}
    {ready && !searching && showDirectory && recentModels.length > 0 ? <div style={{ paddingRight: 8, paddingBottom: 4, paddingLeft: 8 }}><SectionLabel label="Recent" />
      {recentModels.map(({ model, effort }) => <button key={model.id} type="button" disabled={disabled} title={model.id} onClick={() => choose(allowEffortVariants && effort ? model.efforts.find((variant) => variant.effort === effort)?.id ?? model.id : model.id)} style={{ ...filterButtonStyle(value === model.id), marginRight: 4 }}>{shortModelLabel(model.id)}</button>)}
    </div> : null}
    {ready && showDirectory ? <div role="list" aria-label="Providers" style={{ minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', paddingRight: 6, paddingBottom: 6, paddingLeft: 6 }}>
      {groups.map((group) => <div key={group.provider} role="listitem"><button type="button" aria-label={`Provider ${providerLabel(group.provider)}`} onClick={() => { setSelectedProvider(group.provider); setLimit(PAGE_SIZE); }} style={{ ...ROW_TEXT, display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', minHeight: 32, paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8, borderWidth: 0, borderRadius: 8, background: 'transparent', color: 'var(--t-text)', cursor: 'pointer', textAlign: 'left', fontSize: 12 }}><span>{providerLabel(group.provider)}</span><span style={{ color: 'var(--t-text-muted)', fontSize: 10 }}>{group.models.length}</span></button></div>)}
    </div> : null}
    {ready && !showDirectory ? <div role="list" aria-label="Models" style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', scrollbarWidth: 'none', overscrollBehavior: 'contain', paddingBottom: 4 }}>
      {visibleGroups.map((group) => {
        const pinned = searching ? [] : group.models.filter((model) => favoriteIds.has(model.id));
        const stealth = searching ? [] : group.models.filter((model) => isStealth(model) && !favoriteIds.has(model.id));
        const rest = group.models.filter((model) => !pinned.includes(model) && !stealth.includes(model));
        const shown = searching ? rest : rest.slice(0, limit);
        const selected = rest.find((model) => model.id === active?.model.id && !shown.includes(model));
        return <div key={group.provider}>
          {searching ? <SectionLabel label={providerLabel(group.provider)} /> : null}
          {pinned.length ? <><SectionLabel label="Favorites" />{pinned.map(row)}</> : null}
          {stealth.length ? <><SectionLabel label="Stealth" />{stealth.map(row)}</> : null}
          {selected ? <><SectionLabel label="Selected" />{row(selected)}</> : null}
          {!searching && group.provider === 'openrouter' && rankingAvailable ? <SectionLabel label={sort === 'most-popular' ? 'Popular this week' : 'Recently added'} /> : null}
          {shown.map(row)}
          {!searching && rest.length > limit ? <button type="button" onClick={() => setLimit((current) => current + PAGE_SIZE)} style={{ ...filterButtonStyle(false), width: '100%', marginTop: 4 }}>Show {Math.min(PAGE_SIZE, rest.length - limit)} more · {rest.length} models</button> : null}
        </div>;
      })}
    </div> : null}
  </div>;
}

function SectionLabel({ label }: { label: string }) {
  return <div style={{ ...ROW_TEXT, fontSize: 9.5, color: 'var(--t-text-muted)', paddingTop: 7, paddingRight: 8, paddingBottom: 3, paddingLeft: 8 }}>{label}</div>;
}

function StatusLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return <div role="status" style={{ ...ROW_TEXT, fontSize: 11, color: 'var(--t-text-muted)', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}><span>{text}</span>{onRetry ? <button type="button" onClick={onRetry} style={{ ...filterButtonStyle(false), marginLeft: 6 }}>Retry</button> : null}</div>;
}
