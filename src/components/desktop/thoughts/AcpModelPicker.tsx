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
} from '@/lib/orchestrator/acp-model-catalogue';

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
  /** Currently selected model id (base or effort-variant). */
  value: string | null;
  onSelect: (modelId: string) => void;
  repoPath?: string | null;
  /** Rendered width — matches the composer menu it opens from. */
  width?: number;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';

const ROW_TEXT = { fontFamily: 'var(--font-sans-system)', fontWeight: 300, letterSpacing: '0' } as const;

export function AcpModelPicker({ backend, value, onSelect, repoPath, width = 320 }: AcpModelPickerProps) {
  const [groups, setGroups] = useState<CatalogueGroup[]>([]);
  // Starts at 'loading' rather than 'idle' so the fetch effect never has to
  // setState synchronously on mount (which would cascade a render).
  const [state, setState] = useState<LoadState>('loading');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Bumped by Retry. The effect keys off it, so a refresh is a re-run rather
  // than an imperative fetch that has to manage its own loading state.
  const [reloadKey, setReloadKey] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  // localStorage is client-only; read after mount, never during render.
  useEffect(() => { setRecents(readRecents(backend)); }, [backend]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ backend });
    if (repoPath) params.set('repoPath', repoPath);
    if (reloadKey > 0) params.set('refresh', '1');
    fetch(`/api/orchestrator/backend-models?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.available === false) { setState('unavailable'); return; }
        if (data?.error) { setError(String(data.error)); setState('error'); return; }
        setGroups(Array.isArray(data?.groups) ? data.groups : []);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState('error');
      });
    return () => { cancelled = true; };
  }, [backend, repoPath, reloadKey]);

  const reload = useCallback(() => {
    setState('loading');
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => { if (state === 'ready') searchRef.current?.focus(); }, [state]);

  const choose = useCallback((modelId: string) => {
    rememberRecent(backend, modelId);
    onSelect(modelId);
  }, [backend, onSelect]);

  const filtered = useMemo(() => filterCatalogue(groups, query), [groups, query]);
  const total = useMemo(() => catalogueSize(groups), [groups]);
  const shown = useMemo(() => catalogueSize(filtered), [filtered]);
  const active = useMemo(() => findCatalogueModel(groups, value), [groups, value]);

  return (
    <div style={{ width, display: 'flex', flexDirection: 'column', maxHeight: 420, minWidth: 0 }}>
      <div style={{ paddingTop: 6, paddingRight: 8, paddingBottom: 6, paddingLeft: 8 }}>
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          placeholder={state === 'ready' ? `Search ${total} models` : 'Search models'}
          aria-label="Search models"
          style={{
            ...ROW_TEXT,
            width: '100%',
            boxSizing: 'border-box',
            fontSize: 12,
            minHeight: 28,
            paddingTop: 5,
            paddingRight: 8,
            paddingBottom: 5,
            paddingLeft: 8,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            borderRadius: 8,
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            outline: 'none',
          }}
        />
      </div>

      {state === 'loading' ? (
        <StatusLine text="Reading the agent’s model list…" />
      ) : null}
      {state === 'unavailable' ? (
        <StatusLine text={`${backend} is not installed on this machine.`} />
      ) : null}
      {state === 'error' ? (
        <StatusLine text={error ?? 'Could not read the model list.'} onRetry={reload} />
      ) : null}
      {state === 'ready' && total === 0 ? (
        <StatusLine text="The agent reported no models. Check its provider auth." onRetry={reload} />
      ) : null}
      {state === 'ready' && total > 0 && shown === 0 ? (
        <StatusLine text={`No model matches “${query}”.`} />
      ) : null}

      {/* Recents only when idle: while searching, the query IS the intent and a
          pinned strip on top just eats rows. */}
      {state === 'ready' && !query.trim() && recents.length > 0 ? (
        <div style={{ paddingRight: 6, paddingLeft: 6, paddingBottom: 4 }}>
          <div style={{ ...ROW_TEXT, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t-text-faint)', paddingTop: 4, paddingBottom: 3, paddingLeft: 4 }}>
            Recent
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {recents.map((id) => {
              const isActive = value === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => { choose(id); }}
                  title={id}
                  style={{
                    ...ROW_TEXT,
                    fontSize: 11,
                    maxWidth: '100%',
                    minHeight: 22,
                    paddingTop: 3,
                    paddingRight: 8,
                    paddingBottom: 3,
                    paddingLeft: 8,
                    borderWidth: 1,
                    borderStyle: 'solid',
                    borderColor: isActive ? 'var(--t-accent)' : 'var(--t-border)',
                    borderRadius: 999,
                    background: isActive ? 'var(--t-accent-soft)' : 'transparent',
                    color: isActive ? 'var(--t-accent)' : 'var(--t-text)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {shortModelLabel(id) ?? id}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {state === 'ready' && shown > 0 ? (
        <div role="listbox" aria-label="Models" style={{ overflowY: 'auto', overflowX: 'hidden', paddingBottom: 6 }}>
          {filtered.map((group) => (
            <div key={group.provider}>
              <div
                style={{
                  ...ROW_TEXT,
                  fontSize: 9,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--t-text-faint)',
                  paddingTop: 8,
                  paddingRight: 10,
                  paddingBottom: 3,
                  paddingLeft: 10,
                }}
              >
                {group.provider}
              </div>
              {group.models.map((model) => {
                const isActive = active?.model.id === model.id;
                return (
                  <div key={model.id} style={{ paddingRight: 6, paddingLeft: 6 }}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isActive && !active?.effort}
                      onClick={() => { choose(model.id); }}
                      title={model.id}
                      style={{
                        ...ROW_TEXT,
                        display: 'block',
                        width: '100%',
                        minHeight: 26,
                        paddingTop: 3,
                        paddingRight: 8,
                        paddingBottom: 3,
                        paddingLeft: 10,
                        borderWidth: 0,
                        borderRadius: 8,
                        background: isActive ? 'var(--t-accent-soft)' : 'transparent',
                        color: isActive ? 'var(--t-accent)' : 'var(--t-text)',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      onMouseEnter={(event) => { if (!isActive) event.currentTarget.style.background = 'var(--t-hover)'; }}
                      onMouseLeave={(event) => { if (!isActive) event.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* The group header already names the provider, so both
                          lines drop their leading provider segment — at menu
                          width that prefix is what pushed the Flash/Pro
                          discriminator past the ellipsis. Display only: title
                          and set_model keep the full id. */}
                      <span style={{ display: 'block', fontSize: 13, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {stripRedundantProviderPrefix(model.label, group.provider)}
                      </span>
                      <span style={{ display: 'block', fontSize: 9, lineHeight: 1.2, color: isActive ? 'var(--t-accent)' : 'var(--t-text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {model.id.startsWith(`${group.provider}/`) ? model.id.slice(group.provider.length + 1) : model.id}
                      </span>
                    </button>
                    {/* Effort variants exist only when the agent reported suffix
                        siblings — never synthesized, so a model without them
                        simply shows no row. */}
                    {model.efforts.length ? (
                      <div style={{ display: 'flex', gap: 4, paddingTop: 3, paddingBottom: 4, paddingLeft: 10 }}>
                        {model.efforts.map((variant) => {
                          const variantActive = value === variant.id;
                          return (
                            <button
                              key={variant.id}
                              type="button"
                              onClick={() => { choose(variant.id); }}
                              title={variant.id}
                              style={{
                                ...ROW_TEXT,
                                fontSize: 9,
                                minHeight: 18,
                                paddingTop: 2,
                                paddingRight: 7,
                                paddingBottom: 2,
                                paddingLeft: 7,
                                borderWidth: 1,
                                borderStyle: 'solid',
                                borderColor: variantActive ? 'var(--t-accent)' : 'var(--t-border)',
                                borderRadius: 999,
                                background: variantActive ? 'var(--t-accent-soft)' : 'transparent',
                                color: variantActive ? 'var(--t-accent)' : 'var(--t-text-faint)',
                                cursor: 'pointer',
                              }}
                            >
                              {variant.effort}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StatusLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div style={{ ...ROW_TEXT, fontSize: 11, color: 'var(--t-text-faint)', paddingTop: 10, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span>{text}</span>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          style={{
            ...ROW_TEXT,
            alignSelf: 'flex-start',
            fontSize: 11,
            minHeight: 22,
            paddingTop: 3,
            paddingRight: 9,
            paddingBottom: 3,
            paddingLeft: 9,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-border)',
            borderRadius: 999,
            background: 'transparent',
            color: 'var(--t-text)',
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
