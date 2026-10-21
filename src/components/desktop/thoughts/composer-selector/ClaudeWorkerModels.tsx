'use client';

import { useEffect, useState } from 'react';
import { CLAUDE_CODE_PROFILE_CHANGED_EVENT, type ClaudeCodeWorkerProfile } from '@/lib/claude-code/worker-profile-types';
import { AcpModelPicker } from '../AcpModelPicker';
import { COMPOSER_MODEL_GROUPS } from '../ModelThinkingChip';
import { ModelPickerRow } from './ModelPickerRow';
import { modelFavoriteKey, type ModelFavorite } from './model-favorites';

export const CLAUDE_OPENROUTER_HOUSE = 'claude-code:openrouter';
type Provider = 'native' | 'openrouter';
interface Snapshot { profile: ClaudeCodeWorkerProfile; openrouterConfigured: boolean; effectiveModel: string | null }
type Selection = Pick<ClaudeCodeWorkerProfile, 'source' | 'model' | 'codexModel'>;
const sameSelection = (a: Selection, b: Selection) => a.source === b.source && a.model === b.model && a.codexModel === b.codexModel;

async function readProfile(): Promise<Snapshot> {
  const response = await fetch('/api/runtime/claude-code-profile', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read the Claude Code provider.');
  return response.json() as Promise<Snapshot>;
}

async function saveProfile(selection: Selection, expectedProfile: Selection): Promise<Snapshot> {
  let response: Response;
  let result: Snapshot & { error?: string };
  try {
    response = await fetch('/api/runtime/claude-code-profile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: selection.source, model: selection.model, codexModel: selection.codexModel,
        expectedProfile: { source: expectedProfile.source, model: expectedProfile.model, codexModel: expectedProfile.codexModel } }),
    });
    result = await response.json() as Snapshot & { error?: string };
  } catch {
    // A lost response is not proof that the provider stayed unchanged.
    const current = await readProfile().catch(() => null);
    if (current && sameSelection(current.profile, selection)) return current;
    throw new Error('The Claude Code provider save could not be confirmed. Reopen its house before starting work.');
  }
  if (!response.ok) throw new Error(result.error || 'Could not save the Claude Code provider.');
  if (!sameSelection(result.profile, selection)) throw new Error('The Claude Code provider changed elsewhere. Reopen its house to check the current provider.');
  return result;
}

/** Browse without writing. A model choice explicitly applies the existing shared profile. */
export function useClaudeWorkerProvider(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [provider, setProvider] = useState<Provider>('native');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      void readProfile().then((value) => {
        if (cancelled) return;
        setSnapshot(value); setProvider(value.profile.source === 'openrouter' ? 'openrouter' : 'native'); setError(null);
      }).catch(() => { if (!cancelled) setError('Could not read the provider. Reopen this picker to retry.'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    load();
    window.addEventListener(CLAUDE_CODE_PROFILE_CHANGED_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(CLAUDE_CODE_PROFILE_CHANGED_EVENT, load); };
  }, [enabled]);

  const applyModel = async (source: Provider, model: string) => {
    // Re-read before writing so unrelated settings and saved alternate models survive.
    const current = await readProfile();
    if (source === 'openrouter' && !current.openrouterConfigured) throw new Error('Add an OpenRouter key in Settings → Models → API keys.');
    if (current.profile.source === source && (source === 'native' || current.effectiveModel === model)) return;
    const selection = { source, model: source === 'openrouter' ? model : current.profile.model, codexModel: current.profile.codexModel };
    const result = await saveProfile(selection, current.profile);
    setSnapshot(result); setProvider(source);
    window.dispatchEvent(new Event(CLAUDE_CODE_PROFILE_CHANGED_EVENT));
    return async () => {
      try {
        const restored = await saveProfile(current.profile, selection);
        setSnapshot(restored); setProvider(restored.profile.source === 'openrouter' ? 'openrouter' : 'native');
      } catch {
        throw new Error('The worker selection was not applied, and its previous Claude Code provider could not be restored. Reopen Claude Code to check the shared provider before starting work.');
      } finally {
        window.dispatchEvent(new Event(CLAUDE_CODE_PROFILE_CHANGED_EVENT));
      }
    };
  };
  return { snapshot, provider, setProvider, loading, error, applyModel };
}

export function ClaudeWorkerModels({ controller, favorites, onToggleFavorite, nativeModel, disabled, nativeReady, onSelect }: {
  controller: ReturnType<typeof useClaudeWorkerProvider>;
  favorites: ModelFavorite[];
  onToggleFavorite: (favorite: ModelFavorite) => void;
  nativeModel: string | null;
  disabled: boolean;
  nativeReady: boolean;
  onSelect: (source: Provider, model: string) => void;
}) {
  const { snapshot, provider, setProvider, loading, error } = controller;
  const [query, setQuery] = useState('');
  const nativeModels = COMPOSER_MODEL_GROUPS.find((group) => group.key === 'claude')?.options.filter((option) => option.backend === 'claude') ?? [];
  return <>
    <div role="group" aria-label="Claude Code provider" style={{ display: 'flex', gap: 3, paddingTop: 4, paddingRight: 8, paddingBottom: 6, paddingLeft: 8 }}>
      {(['native', 'openrouter'] as const).map((source) => <button key={source} type="button" aria-label={source === 'native' ? 'Claude Code subscription' : 'Claude Code through OpenRouter'} aria-pressed={provider === source} disabled={disabled || loading || !snapshot || (source === 'openrouter' && !snapshot.openrouterConfigured)} onClick={() => { setProvider(source); setQuery(''); }} style={{ flex: 1, minHeight: 26, borderWidth: 0, borderRadius: 7, background: provider === source ? 'var(--t-hover)' : 'transparent', color: provider === source ? 'var(--t-text)' : 'var(--t-text-muted)', opacity: source === 'openrouter' && !snapshot?.openrouterConfigured ? 0.5 : 1, fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, cursor: disabled || loading || !snapshot ? 'default' : 'pointer' }}>{source === 'native' ? 'Subscription' : 'OpenRouter'}</button>)}
    </div>
    {error ? <div role="status" style={{ padding: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{error}</div> : null}
    {provider === 'openrouter' ? <AcpModelPicker backend={CLAUDE_OPENROUTER_HOUSE} catalogueUrl="/api/runtime/claude-code-models" embedded defaultProvider="openrouter" allowEffortVariants={false} value={snapshot?.profile.source === 'openrouter' ? snapshot.effectiveModel : null} favorites={favorites.filter((item) => item.house === CLAUDE_OPENROUTER_HOUSE)} onToggleFavorite={onToggleFavorite} disabled={disabled || loading || !snapshot?.openrouterConfigured} onSelect={(model) => onSelect('openrouter', model)} /> : <>
      <input aria-label="Search models" placeholder="Search Claude models" value={query} onChange={(event) => setQuery(event.target.value)} style={{ boxSizing: 'border-box', width: '100%', height: 30, padding: 8, borderWidth: 0, borderBottom: '1px solid var(--t-border)', background: 'transparent', color: 'var(--t-text)', outline: 'none', fontFamily: 'var(--font-sans-system)', fontSize: 12 }} />
      <div style={{ overflowY: 'auto', scrollbarWidth: 'none', minHeight: 0 }}>
        {nativeModels.filter((option) => `${option.label} ${option.model}`.toLowerCase().includes(query.toLowerCase().trim())).map((option) => {
          const id = option.model ?? option.value;
          const favorite = { house: 'claude-code', id, label: option.label };
          return <ModelPickerRow key={id} testId={`worker-row-${id}`} label={option.label} selected={snapshot?.profile.source === 'native' && nativeModel === id} disabled={disabled || loading || !snapshot || !nativeReady} favorite={favorites.some((item) => modelFavoriteKey(item) === modelFavoriteKey(favorite))} onFavorite={() => onToggleFavorite(favorite)} onSelect={() => onSelect('native', id)} />;
        })}
      </div>
    </>}
    <div style={{ paddingTop: 7, paddingRight: 8, paddingBottom: 7, paddingLeft: 8, fontSize: 10.5, lineHeight: '15px', color: 'var(--t-text-faint)' }}>{provider === 'openrouter' ? 'Billed to your OpenRouter key. The provider is shared by Claude Code leads and workers.' : 'Uses your Claude Code account. Provider changes apply to Claude Code leads and workers.'}{snapshot && !snapshot.openrouterConfigured ? ' Add an OpenRouter key in Settings → Models → API keys.' : ''}</div>
  </>;
}
