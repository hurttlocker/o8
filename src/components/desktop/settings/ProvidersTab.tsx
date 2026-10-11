'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ProviderMarkGlyph, type ProviderMark } from '../thoughts/composer-selector/provider-marks';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { APP_FONT_STACK, RamsButton, TabHeading, type SettingsTab } from './shared';
import { ApiKeysProviderList, NativeKeysList } from './APIKeysTab';
import { ChatGPTPlanConnection } from './ChatGPTPlanConnection';
import { useModelSettings } from './useModelSettings';
import { CliUpdatePrompt } from './CliUpdatePrompt';
import { LocalAcpSection } from './LocalAcpSection';
import { LocalModelsContent } from './LocalModelsTab';
import { ModelDefaultsContent } from './ModelsTab';
import { OpenRouterModelsSection } from './OpenRouterModelsSection';
import { ProviderRuntimeDetails, providerToolStatus, type ProviderTool } from './ProviderRuntimeDetails';

function itemMark(item: ProviderItem): ProviderMark {
  const key = item.runtimeId ?? item.keyId ?? item.id;
  const marks: Record<string, ProviderMark> = { codex: 'openai', 'claude-code': 'anthropic', '3code': 'threecode', grok: 'x', chatgpt: 'openai', 'local-models': 'ollama', anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', antigravity: 'antigravity', gemini: 'gemini', opencode: 'opencode', cursor: 'cursor', defaults: 'o8' };
  return marks[key] ?? 'terminal';
}

interface ProviderKey { id: string; label: string; configured: boolean }
interface ProviderItem { id: string; label: string; group: string; status: string; runtimeId?: keyof typeof ORCHESTRATOR_RUNTIMES; keyId?: string }

function sectionProvider(section?: string, keys: ProviderKey[] = []): string | null {
  if (!section) return null;
  if (section === 'ChatGPT / Codex account usage') return 'runtime:codex';
  if (section === 'Cursor account usage') return 'runtime:cursor';
  if (section.startsWith('Claude') || section === 'Model source') return 'runtime:claude-code';
  if (section === 'Codex connection' || section === 'Codex' || section === 'Codex worker effort' || section === 'Connected tools') return 'runtime:codex';
  if (section === 'Claude worker effort') return 'runtime:claude-code';
  if (section === 'Antigravity') return 'runtime:antigravity';
  if (section === 'OpenCode 2 runtime') return 'runtime:opencode';
  if (section === 'ChatGPT plan') return 'chatgpt';
  if (section === 'Provider keys' || section === 'OpenRouter models' || section === 'Key storage') return 'key:openrouter';
  if (section === 'Symon & voice keys') return 'voice';
  if (section === 'Local models') return 'local-models';
  if (section === 'Local ACP') return 'local-acp';
  const runtime = Object.entries(ORCHESTRATOR_RUNTIMES).find(([, value]) => ['connection', 'runtime', 'models', 'environment', 'account usage'].some(suffix => `${value.label} ${suffix}` === section));
  if (runtime) return `runtime:${runtime[0]}`;
  const key = keys.find(value => [value.label, `${value.label} key`, `${value.label} key storage`].includes(section));
  if (key) return `key:${key.id}`;
  return 'defaults';
}

export function ProvidersTab({ initialTab = 'models', section, navigationId, onNavigateTab }: {
  initialTab?: SettingsTab;
  section?: string;
  navigationId?: number;
  onNavigateTab?: (tab: SettingsTab) => void;
}) {
  const id = useId();
  const settings = useModelSettings();
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const initialProvider = sectionProvider(section, keys) ?? (initialTab === 'api-keys' ? 'key:openrouter' : initialTab === 'local-models' ? 'local-models' : 'runtime:codex');
  const [selected, setSelected] = useState(initialProvider);
  const [visited, setVisited] = useState(() => new Set([initialProvider]));
  const [tools, setTools] = useState<Record<string, ProviderTool>>({});
  const [checking, setChecking] = useState(true);
  const [detectionError, setDetectionError] = useState(false);
  const [keyError, setKeyError] = useState(false);
  const [showAvailable, setShowAvailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const rail = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = panel.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = (width: number) => { if (width > 0) setCompact(width < 650); };
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(entries => measure(entries[0]?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (compact) rail.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected, compact]);
  const [entry, setEntry] = useState({ tab: initialTab, section, navigationId, provider: initialProvider });
  if (entry.tab !== initialTab || entry.section !== section || entry.navigationId !== navigationId || entry.provider !== initialProvider) {
    setEntry({ tab: initialTab, section, navigationId, provider: initialProvider });
    setSelected(initialProvider);
    setVisited(previous => new Set([...previous, initialProvider]));
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/setup/detect', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Detection unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload.tools)) throw new Error('Detection unavailable');
      if (!controller.signal.aborted) setTools(Object.fromEntries(payload.tools.map((tool: ProviderTool) => [tool.id, tool])));
    }).catch(() => { if (!controller.signal.aborted) setDetectionError(true); }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    void fetch('/api/v2/keys', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Key inventory unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload.providers)) throw new Error('Key inventory unavailable');
      if (!controller.signal.aborted) setKeys(payload.providers);
    }).catch(() => { if (!controller.signal.aborted) setKeyError(true); });
    return () => controller.abort();
  }, [revision]);

  const allItems = useMemo<ProviderItem[]>(() => [
    ...Object.entries(ORCHESTRATOR_RUNTIMES).filter(([, runtime]) => runtime.dispatchable).map(([runtimeId, runtime]) => ({
      id: `runtime:${runtimeId}`, runtimeId: runtimeId as keyof typeof ORCHESTRATOR_RUNTIMES, label: runtime.label, group: 'Connections',
      status: runtimeId === 'pi-builtin' ? (settings.loading ? 'Checking…' : settings.data?.dispatchableRuntimes?.find(item => item.id === runtimeId)?.available ? 'Ready · managed' : 'Check setup') : checking ? 'Checking…' : detectionError ? 'Check unavailable' : providerToolStatus(tools[runtimeId]),
    })),
    { id: 'chatgpt', label: 'ChatGPT plan', group: 'Connections', status: 'Subscription connection' },
    ...[...keys].sort((a, b) => Number(b.id === 'openrouter') - Number(a.id === 'openrouter')).map(key => ({ id: `key:${key.id}`, keyId: key.id, label: key.label, group: 'API providers', status: 'API key' })),
    ...(!keys.some(key => key.id === 'openrouter') ? [{ id: 'key:openrouter', keyId: 'openrouter', label: 'OpenRouter', group: 'API providers', status: keyError ? 'Inventory unavailable' : 'Checking…' }] : []),
    { id: 'local-models', label: 'Local models', group: 'Setup', status: 'Endpoint & models' },
    { id: 'local-acp', label: 'Local ACP', group: 'Setup', status: 'Launch configuration' },
    { id: 'voice', label: 'Voice keys', group: 'Setup', status: 'Desktop services' },
    { id: 'defaults', label: 'Model defaults', group: 'Setup', status: 'App routing & Brain' },
  ], [keys, tools, checking, detectionError, keyError, settings.loading, settings.data]);


  const isPrimary = (item: ProviderItem) => !item.runtimeId || ['codex', 'claude-code', 'pi-builtin'].includes(item.runtimeId) || tools[item.runtimeId]?.detected || visited.has(item.id);
  const available = allItems.filter(item => !isPrimary(item));
  const items = allItems.filter(item => showAvailable || isPrimary(item));

  const select = (providerId: string) => {
    setSelected(providerId);
    setVisited(previous => new Set([...previous, providerId]));
  };

  return <div style={{ paddingTop: 8, paddingBottom: 40, fontFamily: APP_FONT_STACK, minWidth: 0 }}>
    <TabHeading title="providers" subtitle="Connections, keys, models, and account usage in one place." />
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
      <RamsButton disabled={checking} onClick={() => { setChecking(true); setDetectionError(false); setKeyError(false); setRevision(value => value + 1); }}>{checking ? 'Checking connections…' : 'Refresh connections'}</RamsButton>
    </div>
    {keyError ? <p role="alert" style={{ fontSize: 13, color: 'var(--t-text-secondary)' }}>Could not load API provider inventory. Refresh connections to retry.</p> : null}
    <div ref={panel} style={{ display: 'flex', flexDirection: compact ? 'column' : 'row', alignItems: 'flex-start', border: '1px solid var(--t-panel-border)', borderRadius: 14, overflow: 'hidden', background: 'var(--t-glass-muted)' }}>
      <div style={{ flex: compact ? 'none' : '1 1 210px', width: compact ? '100%' : undefined, minWidth: 0, padding: 10, boxSizing: 'border-box' }}>
        <div ref={rail} role="tablist" aria-label="Providers" aria-orientation={compact ? 'horizontal' : 'vertical'} style={{ display: compact ? 'flex' : 'block', gap: 6, overflowX: compact ? 'auto' : undefined, scrollbarWidth: 'none' }}>
        {items.map((item, index) => <div key={item.id} style={{ flexShrink: 0, minWidth: compact ? 150 : undefined }}>
          {!compact && (index === 0 || items[index - 1].group !== item.group) ? <div style={{ paddingTop: index ? 20 : 6, paddingBottom: 8, paddingLeft: 10, fontSize: 11, color: 'var(--t-text-muted)' }}>{item.group}</div> : null}
          <button type="button" role="tab" id={`${id}-tab-${item.id}`} aria-label={item.label} aria-controls={`${id}-panel-${item.id}`} aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1}
            onClick={() => select(item.id)} onKeyDown={event => {
              const offset = event.key === (compact ? 'ArrowRight' : 'ArrowDown') ? 1 : event.key === (compact ? 'ArrowLeft' : 'ArrowUp') ? -1 : 0;
              if (!offset && !['Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + offset + items.length) % items.length;
              select(items[target].id);
              rail.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
            }} style={{ width: '100%', border: 0, borderRadius: 8, padding: 12, fontFamily: APP_FONT_STACK, textAlign: 'left', background: selected === item.id ? 'var(--t-hover)' : 'transparent', color: 'var(--t-text)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 300 }}>
              <span aria-hidden="true" style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><ProviderMarkGlyph mark={itemMark(item)} size={14} /></span>{item.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--t-text-muted)', paddingLeft: 20 }}>{item.status}</span>
          </button>
        </div>)}
        </div>
        {available.length > 0 || showAvailable ? <button type="button" aria-expanded={showAvailable} onClick={() => setShowAvailable(value => !value)} style={{ width: '100%', minHeight: 32, marginTop: 12, padding: 8, border: '1px solid var(--t-panel-border)', borderRadius: 8, background: 'transparent', color: 'var(--t-text-secondary)', fontFamily: APP_FONT_STACK, fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, cursor: 'pointer' }}>
          {showAvailable ? 'Hide available agents' : 'Show available agents'}
        </button> : null}
      </div>
      <div style={{ flex: compact ? 'none' : '3 1 420px', width: compact ? '100%' : undefined, minWidth: 0, padding: 20, borderLeft: compact ? undefined : '1px solid var(--t-panel-border)', borderTop: compact ? '1px solid var(--t-panel-border)' : undefined, boxSizing: 'border-box' }}>
        {allItems.filter(item => visited.has(item.id)).map(item => <section key={item.id} role="tabpanel" id={`${id}-panel-${item.id}`} aria-labelledby={`${id}-tab-${item.id}`} hidden={selected !== item.id} style={{ display: selected === item.id ? 'block' : 'none', minWidth: 0 }}>
          <h2 data-settings-section={item.id === selected && section === 'Connected tools' ? section : item.runtimeId ? `${item.label} connection` : item.label === 'Voice keys' ? 'Symon & voice keys' : item.label} style={{ marginTop: 0, marginBottom: 24, fontSize: 17, fontWeight: 300, color: 'var(--t-text)' }}>{item.label}</h2>
          {item.runtimeId ? <ProviderRuntimeDetails runtimeId={item.runtimeId} tool={tools[item.runtimeId]} checking={checking} detectionError={detectionError} settings={settings} /> : null}
          {item.keyId ? <>
            <h3 data-settings-section={item.id === selected && section === 'Provider keys' ? section : `${item.label} key`} style={{ fontSize: 13, fontWeight: 300, color: 'var(--t-text-secondary)' }}>Environment & API key</h3>
            <ApiKeysProviderList providerId={item.keyId} />
            {item.keyId === 'openrouter' ? <OpenRouterModelsSection /> : null}
            <p data-settings-section={item.id === selected && section === 'Key storage' ? section : `${item.label} key storage`} style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.6 }}>Keys use the app’s encrypted store. Runtime environment variables remain managed by each CLI.</p>
          </> : null}
          {item.id === 'chatgpt' ? <ChatGPTPlanConnection /> : null}
          {item.id === 'local-models' ? <LocalModelsContent settings={settings} /> : null}
          {item.id === 'local-acp' ? <LocalAcpSection /> : null}
          {item.id === 'voice' ? <NativeKeysList /> : null}
          {item.id === 'defaults' ? <ModelDefaultsContent onNavigateTab={onNavigateTab} settings={settings} /> : null}
        </section>)}
      </div>
    </div>
    <div style={{ marginTop: 24 }}><CliUpdatePrompt /></div>
  </div>;
}
