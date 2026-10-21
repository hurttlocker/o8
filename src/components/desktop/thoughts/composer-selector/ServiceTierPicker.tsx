'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { isOrchestratorServiceTier, type OrchestratorServiceTier, type ServiceTierOption } from '@/lib/orchestrator/service-tier';
import { COMPOSER_SERVICE_TIER_EVENT, readComposerServiceTier, writeComposerServiceTier } from './service-tier-store';

function subscribe(listener: () => void) {
  window.addEventListener(COMPOSER_SERVICE_TIER_EVENT, listener); window.addEventListener('storage', listener);
  return () => { window.removeEventListener(COMPOSER_SERVICE_TIER_EVENT, listener); window.removeEventListener('storage', listener); };
}
export function ServiceTierPicker({ backend, model, disabled }: { backend: string; model: string; disabled: boolean }) {
  const requested = useSyncExternalStore(subscribe, () => readComposerServiceTier(backend, model), () => undefined);
  const [snapshot, setSnapshot] = useState<{ key: string; options: ServiceTierOption[]; configured: OrchestratorServiceTier; error?: string } | null>(null);
  const [saveError, setSaveError] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = `${backend}:${model}`;
  useEffect(() => {
    if (backend !== 'codex' && backend !== 'claude') return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
      setSnapshot({ key, options: [], configured: 'default', error: 'Service tiers unavailable' });
    }, 12_000);
    void fetch(`/api/runtime/service-tiers?${new URLSearchParams({ backend, model })}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((data) => {
        if (controller.signal.aborted) return;
        const options = Array.isArray(data.options) ? data.options.filter((option: ServiceTierOption | null) => option && isOrchestratorServiceTier(option.id) && typeof option.label === 'string') : [];
        setSnapshot({ key, options, configured: isOrchestratorServiceTier(data.configuredTier) ? data.configuredTier : 'default' });
      }).catch(() => { if (!controller.signal.aborted) setSnapshot({ key, options: [], configured: 'default', error: 'Service tiers unavailable' }); }).finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [backend, model, key, retry]);
  if (backend !== 'codex' && backend !== 'claude') return null;
  const current = snapshot?.key === key ? snapshot : null;
  const selected = requested ?? current?.configured ?? 'default';
  const availableSelection = current?.options.some((option) => option.id === selected);
  const pick = (id: OrchestratorServiceTier) => setSaveError(!writeComposerServiceTier(backend, model, id));
  return <div data-service-tier-picker="" style={{ paddingTop: 10, paddingRight: 10, paddingBottom: 2, paddingLeft: 10, marginTop: 8, borderTop: '1px solid var(--t-divider-subtle)' }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7, fontSize: 11, color: 'var(--t-text-muted)' }}>Service tier <span style={{ fontSize: 10 }}>{!current ? 'Checking…' : current.options.find((option) => option.id === selected)?.label ?? (requested ? 'Selection unavailable' : '')}</span></div>
    <div role="radiogroup" aria-label="Orchestrator service tier" style={{ display: 'flex', gap: 4 }}>
      {current?.options.map((option, index) => <button key={option.id} type="button" role="radio" aria-checked={selected === option.id} tabIndex={selected === option.id || !availableSelection && index === 0 ? 0 : -1} disabled={disabled} title={option.description} onClick={() => pick(option.id)} onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? current.options.length - 1 : step ? (index + step + current.options.length) % current.options.length : null;
        if (next === null) return; event.preventDefault(); pick(current.options[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }} style={{ flex: 1, minWidth: 0, height: 28, padding: 0, border: '1px solid var(--t-divider-subtle)', borderRadius: 8, background: selected === option.id ? 'var(--t-accent-soft)' : 'transparent', color: selected === option.id ? 'var(--t-accent)' : 'var(--t-text-secondary)', fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300, cursor: disabled ? 'default' : 'pointer' }}>{option.label}</button>)}
    </div>
    {current?.error ? <button type="button" onClick={() => setRetry((value) => value + 1)} style={{ background: 'transparent', border: 0, padding: 0, color: 'var(--t-accent)', fontSize: 10.5, cursor: 'pointer' }}>{current.error} · Retry</button> : null}
    {saveError ? <div role="alert" style={{ marginTop: 6, fontSize: 10.5, color: 'var(--t-text-muted)' }}>Could not save this choice.</div> : null}
    {current && !current.error ? <div style={{ marginTop: 7, fontSize: 10, lineHeight: '14px', color: 'var(--t-text-muted)' }}>{!availableSelection ? 'This tier is no longer available. Choose Standard before sending.' : current.options.find((option) => option.id === selected)?.description || (current.options.length > 1 ? 'Applies to the next turn. Faster tiers can use more allowance or paid credits.' : 'Standard speed for this model.')}</div> : null}
  </div>;
}
