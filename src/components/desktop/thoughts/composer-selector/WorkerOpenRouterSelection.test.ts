// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ClaudeCodeWorkerProfile } from '@/lib/claude-code/worker-profile-types';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';
import { ComposerPicker } from './ComposerPicker';
import { useComposerSelectorState } from './useComposerSelectorState';
import { invalidateRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { CLAUDE_CODE_PROFILE_CHANGED_EVENT } from '@/lib/claude-code/worker-profile-types';

vi.mock('@/lib/entitlement/context', () => ({ useEntitlement: () => ({ plan: 'pro' }) }));
vi.mock('../chat-panel/ComposerPopover', () => ({ ComposerPopover: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? createElement('div', null, children) : null }));
const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let profile: ClaudeCodeWorkerProfile;
let configured: boolean;
let failSave: boolean;
let failWorkerSave: boolean;
let ignoreWorkerSave: boolean;
let changeProviderDuringWorkerSave: boolean;
let loseProviderResponseBody: boolean;
let sources: Record<string, string>;
let defaults: Record<string, unknown>;
let writes: Array<{ url: string; body: Record<string, unknown> }>;

function Harness() {
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const controller = useComposerSelectorState({ enabled: true, mode: 'fast', backend: 'codex', modelId: 'gpt-6-astra', modelLabel: 'Astra', effort, operatorDefaultEffort: 'high', adaptiveEnabled: false, threadId: null, onEffortChange: setEffort });
  return createElement(ComposerPicker, { ...controller });
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));
const click = async (selector: string) => { await act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); await settle(); }); };
beforeEach(async () => {
  localStorage.clear(); invalidateRuntimeInventory(); invalidateOperatorDefaultsValuesSnapshot();
  profile = { source: 'native', model: 'retained/model', codexModel: 'gpt-6-sol', repoSkillAllowlist: ['local-skill'] };
  configured = true; failSave = false; failWorkerSave = false; ignoreWorkerSave = false; changeProviderDuringWorkerSave = false; loseProviderResponseBody = false; sources = {}; writes = [];
  defaults = { defaultDispatchRuntime: 'codex', defaultDispatchModel: 'gpt-6-sol', workerStartMode: 'huddle', opencodeWorkerModel: null };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push({ url, body });
      if (url.includes('claude-code-profile')) {
        if (failSave) return new Response(JSON.stringify({ error: 'Provider could not be saved.' }), { status: 500 });
        const expected = body.expectedProfile as ClaudeCodeWorkerProfile | undefined;
        if (expected && (expected.source !== profile.source || expected.model !== profile.model || expected.codexModel !== profile.codexModel)) {
          return Response.json({ error: 'Provider changed elsewhere.' }, { status: 409 });
        }
        profile = { ...profile, source: body.source, model: body.model, codexModel: body.codexModel } as ClaudeCodeWorkerProfile;
        if (loseProviderResponseBody) {
          const response = Response.json({});
          vi.spyOn(response, 'json').mockRejectedValue(new Error('Response body interrupted.'));
          return response;
        }
      } else {
        if (changeProviderDuringWorkerSave) profile = { ...profile, source: 'openrouter', model: 'anthropic/newer-choice' };
        if (failWorkerSave) return Response.json({ error: 'Worker could not be saved.' }, { status: 500 });
        if (!ignoreWorkerSave) defaults = { ...defaults, ...body };
      }
    }
    const payload = url.includes('claude-code-profile') ? { profile, openrouterConfigured: configured, effectiveModel: profile.source === 'openrouter' ? profile.model : null }
      : url.includes('claude-code-models') ? { available: true, groups: [{ provider: 'openrouter', models: [{ id: 'openai/test-model', label: 'Test model', provider: 'openrouter', efforts: [] }] }] }
      : { values: defaults, sources, dispatchableRuntimes: [ { id: 'codex', available: true }, { id: 'claude-code', available: true } ].map((runtime) => ({ ...runtime, label: runtime.id, installed: true, unavailableReason: null, detail: '', fix: '' })) };
    return new Response(JSON.stringify(payload), { status: 200 });
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); await settle(); });
  await click('[data-testid="composer-selector-workers"]');
  await click('[data-testid="worker-house-claude-code"]');
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('browses OpenRouter without writing, then applies the provider and worker together', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  expect(writes).toEqual([]);
  expect(container.textContent).toContain('Billed to your OpenRouter key');
  expect(container.textContent).toContain('shared by Claude Code leads and workers');
  await click('[title="openai/test-model"]');
  expect(profile.source).toBe('openrouter');
  expect(profile.model).toBe('openai/test-model');
  expect(profile.codexModel).toBe('gpt-6-sol');
  expect(profile.repoSkillAllowlist).toEqual(['local-skill']);
  expect(defaults).toMatchObject({ defaultDispatchRuntime: 'claude-code', defaultDispatchModel: '', workerStartMode: 'autonomous' });
  expect(writes).toHaveLength(2);
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
  expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Astra');
  expect(container.querySelector('[data-testid="composer-selector-workers"]')?.getAttribute('aria-label')).toContain('openai/test-model');
});

it('keeps the old worker choice when its provider save fails', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  failSave = true;
  await click('[title="openai/test-model"]');
  expect(writes).toHaveLength(1);
  expect(defaults.defaultDispatchRuntime).toBe('codex');
  expect(profile.source).toBe('native');
  expect(container.textContent).toContain('Provider could not be saved.');
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).not.toBeNull();
});

it('offers no OpenRouter model choice when the key is missing', async () => {
  configured = false;
  await click('[data-testid="composer-selector-workers"]');
  await click('[data-testid="composer-selector-workers"]');
  await click('[data-testid="worker-house-claude-code"]');
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Claude Code through OpenRouter"]')!.disabled).toBe(true);
  expect(writes).toEqual([]);
});

it('restores the prior shared provider when the worker save fails', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  failWorkerSave = true;
  await click('[title="openai/test-model"]');
  expect(writes).toHaveLength(3);
  expect(profile).toEqual({ source: 'native', model: 'retained/model', codexModel: 'gpt-6-sol', repoSkillAllowlist: ['local-skill'] });
  expect(defaults.defaultDispatchRuntime).toBe('codex');
  expect(container.textContent).toContain('previous Claude Code provider was restored');
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).not.toBeNull();
});

it('does not overwrite a newer provider choice while recovering a failed worker save', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  failWorkerSave = true; changeProviderDuringWorkerSave = true;
  await click('[title="openai/test-model"]');
  expect(profile.source).toBe('openrouter');
  expect(profile.model).toBe('anthropic/newer-choice');
  expect(container.textContent).toContain('previous Claude Code provider could not be restored');
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).not.toBeNull();
});

it.each(['env', 'profile'])('checks a fresh %s runtime lock before changing the shared provider', async (source) => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  sources.defaultDispatchRuntime = source;
  await click('[title="openai/test-model"]');
  expect(writes).toEqual([]);
  expect(profile.source).toBe('native');
  expect(defaults.defaultDispatchRuntime).toBe('codex');
  expect(container.textContent).toContain('Worker runtime is fixed by your runtime settings');
});

it('requires the effective worker selection to match even when the server returns success', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  ignoreWorkerSave = true;
  await click('[title="openai/test-model"]');
  expect(defaults.defaultDispatchRuntime).toBe('codex');
  expect(profile.source).toBe('native');
  expect(container.textContent).toContain('previous Claude Code provider was restored');
});

it('keeps native Claude favorites and excludes carrier models from native worker search', async () => {
  await click('[aria-label="Favorite Opus 5.5"]');
  await click('[data-testid="composer-selector-workers"]');
  profile = { ...profile, source: 'openrouter', model: 'anthropic/carrier-model' };
  await act(async () => { window.dispatchEvent(new Event(CLAUDE_CODE_PROFILE_CHANGED_EVENT)); await settle(); });
  await click('[data-testid="composer-selector-workers"]');
  expect(container.querySelector('[data-testid="worker-row-claude-opus-5-5"]')).not.toBeNull();
  await click('[data-testid="worker-house-codex"]');
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'anthropic/');
    input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  });
  expect(container.querySelector('[data-testid="worker-row-anthropic/carrier-model"]')).toBeNull();
  expect(writes).toEqual([]);
  expect(profile.source).toBe('openrouter');
});

it('reconciles a persisted provider when its response body is interrupted', async () => {
  await click('[aria-label="Claude Code through OpenRouter"]');
  loseProviderResponseBody = true;
  await click('[title="openai/test-model"]');
  expect(profile.source).toBe('openrouter');
  expect(profile.model).toBe('openai/test-model');
  expect(defaults).toMatchObject({ defaultDispatchRuntime: 'claude-code', defaultDispatchModel: '' });
  expect(writes).toHaveLength(2);
  expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
});
