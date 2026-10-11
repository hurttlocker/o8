// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY,
  COMPOSER_SELECTOR_MODES,
  VISIBLE_COMPOSER_SELECTOR_MODES,
  resolveEffectiveComposerLeadModelId,
  supportedEffortsForLead,
  type ComposerSelectorMode,
} from './state';
import { InputButtons } from '../InputButtons';
import { ComposerArea } from '../chat-panel/ComposerArea';
import { COMPOSER_MODEL_GROUPS } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { Plan } from '@/lib/entitlement/types';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import { MODEL_IDS } from '@/lib/models';
import { invalidateRuntimeInventory } from '../../onboarding/useRuntimeInventory';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

const entitlementState = vi.hoisted(() => ({ plan: 'free' as Plan }));

vi.mock('@/lib/entitlement/context', () => ({
  useEntitlement: () => ({ plan: entitlementState.plan }),
}));

vi.mock('../chat-panel/ComposerPopover', async () => {
  const React = await import('react');
  return {
    ComposerPopover: ({ open, children }: { open: boolean; children: import('react').ReactNode }) => (
      open ? React.createElement('div', null, children) : null
    ),
  };
});

const ACT_ENV = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
ACT_ENV.IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  initialModel = 'gpt-5.6-sol',
  initialBackend = 'codex',
  initialEffort = 'high',
  initialMode = 'solo',
  messages = 0,
  waiting = false,
  permissions = false,
  onSend,
  initialInput = 'Build it',
  onDraftSend,
  repoPath,
  effortTestId,
}: {
  initialModel?: string;
  initialBackend?: OrchestratorBackendSetting;
  initialEffort?: ThinkingEffort;
  initialMode?: ComposerSelectorMode;
  messages?: number;
  waiting?: boolean;
  permissions?: boolean;
  onSend?: (permission: 'full' | 'plan') => void;
  initialInput?: string;
  onDraftSend?: (input: string) => void;
  repoPath?: string;
  effortTestId?: string;
}) {
  const [input, setInput] = useState(initialInput);
  const [permission, setPermission] = useState<'full' | 'plan'>('full');
  const [mode, setMode] = useState<ComposerSelectorMode>(initialMode);
  const [effort, setEffort] = useState<ThinkingEffort>(initialEffort);
  const [model, setModel] = useState(initialModel);
  const [backend, setBackend] = useState<OrchestratorBackendSetting>(initialBackend);
  return (
    <>
      {effortTestId ? <span data-testid={effortTestId}>{effort}</span> : null}
      <ComposerArea
        activeComposer
        input={input}
        onInputChange={setInput}
        isOrchestratorMode
        displayWaiting={waiting}
        chatMessages={[]}
        activeTargetLabel="Orchestrator"
        targetAgentExists
        thoughtsBodyBackground="var(--t-chat-surface-bg)"
        enhancing={false}
        preEnhanceInput={null}
        onEnhance={() => {}}
        onUndoEnhance={() => {}}
        onSubmit={() => { onSend?.(permission); onDraftSend?.(input); }}
        onSlashCommand={() => {}}
        modelId={model}
        modelLabel={model === 'gpt-5.6-sol' ? 'Sol' : model}
        onModelChange={setModel}
        activeBackend={backend}
        onBackendChange={(next, nextModel) => { setBackend(next); if (nextModel !== undefined) setModel(nextModel); }}
        effort={effort}
        operatorDefaultEffort={initialEffort}
        onEffortChange={setEffort}
        adaptiveEnabled
        displayMessagesCount={messages}
        hasAssistantActivity={false}
        composerMode={mode}
        onComposerModeChange={setMode}
        sessionRulesThreadId="harness-thread"
        repoPath={repoPath}
        permissionMode={permissions ? permission : undefined}
        onPermissionModeChange={permissions ? setPermission : undefined}
      />
    </>
  );
}

function O8PlanHarness() {
  return <Harness initialModel="o8-free" initialBackend="o8" initialEffort="low" effortTestId="o8-plan-effort" />;
}

function RealComposerHarness({ initialEffort = 'high', threadId = 'thread-test', operatorDefaultEffort = 'high' }: { initialEffort?: ThinkingEffort; threadId?: string; operatorDefaultEffort?: ThinkingEffort }) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
  const [effort, setEffort] = useState<ThinkingEffort>(initialEffort);
  const [model, setModel] = useState('gpt-5.6-sol');
  const [backend, setBackend] = useState<OrchestratorBackendSetting>('codex');
  return (
    <>
      <span data-testid="real-composer-mode">{mode}</span>
      <span data-testid="real-composer-effort">{effort}</span>
      <ComposerArea
        activeComposer
        input={input}
        onInputChange={setInput}
        isOrchestratorMode
        displayWaiting={false}
        chatMessages={[]}
        activeTargetLabel="Orchestrator"
        targetAgentExists
        thoughtsBodyBackground="var(--t-chat-surface-bg)"
        enhancing={false}
        preEnhanceInput={null}
        onEnhance={() => {}}
        onUndoEnhance={() => {}}
        onSubmit={() => {}}
        onSlashCommand={() => {}}
        modelLabel={model === 'gpt-5.6-sol' ? 'Sol' : model}
        modelId={model}
        onModelChange={setModel}
        activeBackend={backend}
        onBackendChange={(next, nextModel) => { setBackend(next); if (nextModel !== undefined) setModel(nextModel); }}
        effort={effort}
        operatorDefaultEffort={operatorDefaultEffort}
        onEffortChange={setEffort}
        adaptiveEnabled
        displayMessagesCount={0}
        hasAssistantActivity={false}
        repoLabel="Test repo"
        composerLeadingExtras={<span data-testid="test-leading-extra">Extra control</span>}
        footerMeterSlot={<span data-testid="test-context-meter">Context meter</span>}
        voiceModeEnabled={false}
        onVoiceModeChange={() => {}}
        composerMode={mode}
        onComposerModeChange={setMode}
        sessionRulesThreadId={threadId}
      />
    </>
  );
}

function NoPinCodexHarness({ codexDefaultDispatchModel }: { codexDefaultDispatchModel?: string }) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
  const [effort, setEffort] = useState<ThinkingEffort>('xhigh');
  return (
    <ComposerArea
      activeComposer
      input={input}
      onInputChange={setInput}
      isOrchestratorMode
      displayWaiting={false}
      chatMessages={[]}
      activeTargetLabel="Orchestrator"
      targetAgentExists
      thoughtsBodyBackground="var(--t-chat-surface-bg)"
      enhancing={false}
      preEnhanceInput={null}
      onEnhance={() => {}}
      onUndoEnhance={() => {}}
      onSubmit={() => {}}
      onSlashCommand={() => {}}
      modelLabel="Codex"
      activeBackend="codex"
      effort={effort}
      operatorDefaultEffort="xhigh"
      codexDefaultDispatchModel={codexDefaultDispatchModel}
      onEffortChange={setEffort}
      adaptiveEnabled
      displayMessagesCount={0}
      hasAssistantActivity={false}
      composerMode={mode}
      onComposerModeChange={setMode}
      sessionRulesThreadId="thread-no-pin"
    />
  );
}

describe('ComposerSelectorFooter', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    invalidateRuntimeInventory();
    entitlementState.plan = 'free';
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).includes('/api/setup/orchestrator-backends')) return new Response(JSON.stringify({ acp: true }), { status: 200 });
      if (String(_input).includes('/api/orchestrator/backend-models?backend=acp')) return new Response(JSON.stringify({ available: true, groups: [], total: 0 }), { status: 200 });
      if (String(_input).includes('/api/runtime/claude-code-profile')) return new Response(JSON.stringify({ profile: { source: 'native', model: null, codexModel: null }, effectiveModel: null, openrouterConfigured: false }), { status: 200 });
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      return new Response(JSON.stringify({
        values: {
          defaultDispatchRuntime: body.defaultDispatchRuntime ?? 'codex',
          defaultDispatchModel: '',
          opencodeWorkerModel: null,
          workerStartMode: body.workerStartMode ?? 'autonomous',
        },
        sources: {},
        dispatchableRuntimes: listDispatchableRuntimes().map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: '', fix: '' })),
      }), { status: 200 });
    }));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    invalidateOperatorDefaultsValuesSnapshot();
    vi.unstubAllGlobals();
  });

  async function openLeadHouse(house: string) {
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click(); });
    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="lead-house-${house}"]`)!.click());
  }

  async function openLeadEffort(house: string, model: string) {
    await openLeadHouse(house);
    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="lead-row-${model}"]`)!.click());
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-thinking"]')!.click());
  }

  function selectMode(label: string) {
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(label))!.click());
  }

  it('selects a file as a tag, opens its workspace path, keeps the reference on send, and removes it', async () => {
    const draft = vi.fn(); const opened = vi.fn();
    window.addEventListener('o8:open-file', opened);
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).startsWith('/api/v2/context/files')
      ? Response.json({ files: [{ path: 'assets/choose-before-you-send.gif' }] }) : originalFetch(input, init));
    const inputValue = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    try {
      await act(async () => root.render(<Harness initialInput="Inspect this" repoPath="/repo" onDraftSend={draft} />));
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Attach files"]')!.click());
      expect(container.querySelector('[aria-label="Add attachments"]')).not.toBeNull();
      act(() => inputValue(container.querySelector<HTMLInputElement>('input[placeholder="Search repo files"]')!, 'choose'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)); });
      act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('choose-before-you-send.gif'))!.click());
      expect(container.querySelector('[aria-label="Add attachments"]')).toBeNull();
      const tag = container.querySelector<HTMLButtonElement>('[aria-label="Open assets/choose-before-you-send.gif"]')!;
      expect(tag.textContent).toContain('choose-before-you-send.gif');
      expect(container.querySelector('textarea')!.value).toBe('Inspect this');
      act(() => tag.click());
      expect(opened.mock.calls[0]?.[0].detail).toEqual({ path: '/repo/assets/choose-before-you-send.gif' });
      act(() => inputValue(container.querySelector('textarea')!, 'Review this file'));
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-send"] button')!.click());
      expect(draft).toHaveBeenLastCalledWith('@assets/choose-before-you-send.gif\nReview this file');
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove reference assets/choose-before-you-send.gif"]')!.click());
      expect(container.querySelector('[aria-label="Referenced files"]')).toBeNull();
      expect(container.querySelector('textarea')!.value).toBe('Review this file');
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-send"] button')!.click());
      expect(draft).toHaveBeenLastCalledWith('Review this file');
    } finally { window.removeEventListener('o8:open-file', opened); }
  });

  it('keeps permissions inside the composer and removes project selection when the chat starts', async () => {
    const observers = new Map<Element, ResizeObserverCallback>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) { observers.set(element, this.callback); }
      unobserve(element: Element) { observers.delete(element); } disconnect() {}
    });
    const onSend = vi.fn();
    await act(async () => root.render(createElement(Harness, { permissions: true, onSend })));
    const footer = container.querySelector('[data-testid="composer-selector-footer"]')!;
    const permission = footer.querySelector<HTMLButtonElement>('[aria-label="Permissions: Full access"]')!;
    expect(permission.textContent).toContain('Full access');
    expect(container.querySelector('[data-o8-composer-context-row] [aria-haspopup="listbox"]')).not.toBeNull();
    act(() => permission.click());
    act(() => container.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="false"]')!.click());
    expect(footer.querySelector('[aria-label="Permissions: Plan only"]')).not.toBeNull();
    act(() => footer.querySelector<HTMLButtonElement>('[data-testid="composer-selector-send"] button')!.click());
    expect(onSend).toHaveBeenCalledWith('plan');
    await act(async () => root.render(createElement(Harness, { permissions: true, messages: 1, onSend })));
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
    expect(container.querySelector('[data-o8-composer-context-row]')).toBeNull();
    const resize = [...observers].find(([element]) => element.contains(footer))?.[1];
    expect(resize).toBeDefined();
    act(() => resize?.([{ contentRect: { width: 360 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(footer.querySelector('[aria-label="Permissions: Plan only"]')?.textContent).toBe('');
    act(() => resize?.([{ contentRect: { width: 640 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(footer.querySelector('[aria-label="Permissions: Plan only"]')?.textContent).toBe('Plan only');
    await act(async () => root.render(createElement(Harness, { permissions: true, messages: 0, waiting: true })));
    expect(container.querySelector('[aria-haspopup="listbox"]')).toBeNull();
  });

  it('orders mode, attach, lead, mic, and send with mic immediately before send', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const footer = container.querySelector('[data-testid="composer-selector-footer"]');
    expect([...footer!.children].map((node) => node.getAttribute('data-testid'))).toEqual([
      'composer-selector-mode',
      'composer-selector-attach',
      'composer-selector-leading-controls',
      'composer-selector-spacer',
      'composer-selector-lead',
      'composer-selector-thinking',
      'composer-selector-mic',
      'composer-selector-send',
    ]);
    expect(footer?.querySelector('[data-testid="composer-selector-send"]')?.previousElementSibling)
      .toBe(footer?.querySelector('[data-testid="composer-selector-mic"]'));
  });

  it('renders the Marks lead meter and only mounts workers outside Solo', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const expectedEfforts = supportedEffortsForLead('codex', 'gpt-5.6-sol', true);
    const lead = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    expect(lead.querySelectorAll('[data-provider-mark]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="composer-selector-thinking"] [data-testid="composer-selector-meter-bar"]')).toHaveLength(expectedEfforts.length);
    expect(container.querySelectorAll('[data-testid="composer-selector-thinking"] [data-testid="composer-selector-meter-bar"][data-lit="true"]')).toHaveLength(expectedEfforts.indexOf('high') + 1);
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('high');
    expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();

    await openLeadEffort('codex', 'gpt-5.6-sol');
    expect(container.querySelector('[data-testid="composer-selector-workers-section"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')?.textContent).toContain('GPT-5.6 Sol');
    const stops = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')];
    expect(stops).toHaveLength(expectedEfforts.length);
    act(() => stops.find((stop) => stop.textContent === 'Extra')!.click());
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.getAttribute('data-accent')).toBe('swarm');
    const extraBar = container.querySelectorAll<HTMLElement>('[data-testid="composer-selector-thinking"] [data-testid="composer-selector-meter-bar"]')
      [expectedEfforts.indexOf('xhigh')];
    const effortWord = container.querySelector<HTMLElement>('[data-testid="composer-selector-effort-word"]')!;
    expect(extraBar.getAttribute('data-accent')).toBe('swarm');
    expect(effortWord.style.color).toBe(extraBar.style.background);

    act(() => lead.click());
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Multitask'))!.click());
    const workers = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workers.querySelectorAll('[data-provider-mark]')).toHaveLength(1);
    expect(workers.textContent).toContain('Codex');

    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Solo'))!.click());
    expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();
  });

  it('restores advanced worker settings without adding them to the mode menu', async () => {
    await act(async () => root.render(createElement(Harness, { initialMode: 'fusion' })));
    const workers = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workers.querySelectorAll('[data-provider-mark]')).toHaveLength(3);
    expect(workers.textContent).toContain('Workers');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!.click());
    expect(container.querySelector('[role="menu"]')?.textContent).not.toMatch(/Fusion|Compare plans/);
  });

  it('browses a house without changing the lead and closes immediately on model choice', async () => {
    await act(async () => root.render(createElement(Harness)));
    await openLeadHouse('claude');
    expect(container.querySelector('[data-testid="lead-house-claude"]')?.getAttribute('aria-label')).toBe('Claude Code');
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Sol');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-house-codex"]')!.click());
    expect(container.querySelector('[data-testid="lead-row-gpt-6-astra"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lead-row-claude-opus-5"]')).toBeNull();
    expect(container.textContent).not.toContain('Fable-class');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-gpt-6-astra"]')!.click());
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Astra');
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('high');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-thinking"]')!.click());
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('High');
  });

  it('lets the operator select GPT-6 Sol as the lead', async () => {
    await act(async () => { root.render(<Harness initialEffort="medium" />); });
    await openLeadEffort('codex', 'gpt-6-sol');
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')?.textContent).toContain('GPT-6 Sol');
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('Medium');
  });

  it('lets the operator select GPT-6 Luna as the lead', async () => {
    await act(async () => { root.render(<Harness initialEffort="medium" />); });
    await openLeadEffort('codex', 'gpt-6-luna');
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')?.textContent).toContain('GPT-6 Luna');
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('Medium');
  });

  it('renders effort labels from the shared label table', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const lead = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    await openLeadEffort('codex', 'gpt-5.6-sol');
    const pickerText = container.textContent ?? '';
    for (const effort of supportedEffortsForLead('codex', 'gpt-5.6-sol', true)) {
      expect(pickerText).toContain(THINKING_EFFORT_LABELS[effort].long);
    }
    act(() => lead.click());
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    const modeText = container.textContent ?? '';
    for (const id of VISIBLE_COMPOSER_SELECTOR_MODES) expect(modeText).toContain(COMPOSER_SELECTOR_MODES.find(option => option.id === id)!.long);
    const shared = COMPOSER_SELECTOR_MODES.find(option => option.id === 'fast')!;
    expect(modeText).not.toMatch(/Compare plans|Fusion/);
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find(button => button.textContent?.includes(shared.long))!.click());
    expect(mode.textContent).toContain(shared.short);
    expect(mode.getAttribute('aria-label')).toBe(`Mode: ${shared.long}`);
    expect(mode.title).toContain(shared.long);
  });

  it('persists Extra through the real flag-on composer path', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await openLeadEffort('codex', 'gpt-5.6-sol');
    const extra = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')]
      .find((stop) => stop.textContent === 'Extra')!;
    act(() => extra.click());

    expect(JSON.parse(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY) ?? '{}'))
      .toEqual({ 'gpt-5.6-sol': 'xhigh' });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('extra');
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.getAttribute('data-accent')).toBe('swarm');
    expect(container.querySelector<HTMLElement>('[data-testid="composer-selector-effort-word"]')?.style.color)
      .toBe('var(--t-brand-orange)');
  });

  it('resolves thread storage through the real ComposerArea path before the operator default', async () => {
    localStorage.setItem(`${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:thread:thread-real`, JSON.stringify({ 'gpt-5.6-sol': 'high' }));
    await act(async () => { root.render(createElement(RealComposerHarness, { threadId: 'thread-real', operatorDefaultEffort: 'low' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('high');
    await openLeadEffort('codex', 'gpt-5.6-sol');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')]
      .find((stop) => stop.textContent === 'Extra')!.click());
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('xhigh');
    localStorage.removeItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY);

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { root.render(createElement(RealComposerHarness, { threadId: 'thread-fresh', operatorDefaultEffort: 'medium' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('medium');

    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => { root.render(createElement(RealComposerHarness, { threadId: 'thread-real', operatorDefaultEffort: 'low' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('xhigh');
  });

  it('uses the full runtime label in the bounded workers chip', async () => {
    vi.mocked(fetch).mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).includes('include=values') ? {
        values: {
          defaultDispatchRuntime: 'opencode',
          defaultDispatchModel: '',
          opencodeWorkerModel: null,
          workerStartMode: 'autonomous',
        },
        sources: {},
      } : { dispatchableRuntimes: listDispatchableRuntimes().map((id) => ({ id, label: id, available: true, unavailableReason: null, detail: '', fix: '' })) },
    ), { status: 200 }));
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Multitask'))!.click());

    const workers = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workers.textContent).toContain('OpenCode');
    expect(workers.textContent).not.toContain('OpenCode 2');
    expect(workers.style.maxWidth).not.toBe('');
    expect(workers.querySelector<HTMLElement>('[data-testid="composer-selector-workers-label"]')?.style.textOverflow)
      .toBe('ellipsis');
  });

  it('keeps Solo focused on models and shows concise effort consequences', async () => {
    entitlementState.plan = 'founder';
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="composer-selector-search"]'));

    const leadRows = [...container.querySelectorAll<HTMLElement>('[data-testid^="lead-house-"]')];
    expect(leadRows.every((row) => row.querySelector('[data-provider-mark]'))).toBe(true);
    expect(container.querySelector('[data-testid="composer-selector-workers-section"]')).toBeNull();
    expect(container.querySelector('[data-testid^="worker-row-"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-house-o8"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-o8-free"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-thinking"]')!.click());
    const o8Stops = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')];
    expect(o8Stops).toHaveLength(1);
    expect(o8Stops[0]?.textContent).toBe('Low');
    act(() => o8Stops[0]!.click());
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('Low');
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"] > span > span:not([aria-hidden])')?.textContent).toBe('managed model');
    expect(container.querySelector('[data-testid="composer-selector-lead-effort"]')?.textContent).not.toContain('of 2');
  });

  it.each(
    (['free', 'pro', 'team', 'founder'] as const).flatMap((plan) => (
      [false, true].map((savedHigh) => ({ plan, savedHigh }))
    )),
  )('offers only Low on the $plan o8 plan (saved High: $savedHigh)', async ({ plan, savedHigh }) => {
    entitlementState.plan = plan;
    if (savedHigh) {
      localStorage.setItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, JSON.stringify({ 'o8-free': 'high' }));
    }
    await act(async () => { root.render(createElement(O8PlanHarness)); });
    await openLeadEffort('o8', 'o8-free');
    const stops = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')];

    expect(stops.map((stop) => stop.textContent)).toEqual(['Low']);
    expect(stops.some((stop) => stop.getAttribute('aria-disabled') === 'true')).toBe(false);
    expect(container.textContent).not.toMatch(/upgrade|founders|reset to high/i);
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider.getAttribute('aria-valuemax')).toBe('0');
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(slider.getAttribute('aria-valuetext')).toBe('Low');
    expect(container.querySelector('[data-testid="o8-plan-effort"]')?.textContent).toBe('low');
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('low');
    if (savedHigh) {
      expect(JSON.parse(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY) ?? '{}'))
        .toEqual({ 'o8-free': 'low' });
    }
  });

  it('cycles Solo, Shared and Multitask with Shift+Tab and keeps textarea focus', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.focus();
    for (const label of ['Shared', 'Multitask', 'Solo']) {
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true, bubbles: true, cancelable: true }));
      });
      expect(container.querySelector('[data-testid="composer-selector-mode"]')?.textContent).toContain(label);
      expect(document.activeElement).toBe(textarea);
    }
  });

  it('steps effort only while the textarea is focused, including the macOS dead-key character', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.focus();
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: '†', code: 'KeyT', altKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('extra');

    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click(); });
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    search.focus();
    expect(document.activeElement).toBe(search);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('extra');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('high');
  });

  it('selecting Shared leaves effort unchanged and hides advanced choices', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(choices.map(button => button.textContent)).toEqual([expect.stringContaining('Solo'), expect.stringContaining('Shared'), expect.stringContaining('Multitask')]);
    expect(choices.some(button => /Fusion|Compare plans/.test(button.textContent ?? ''))).toBe(false);
    act(() => choices.find(button => button.textContent?.includes('Shared'))!.click());
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('high');
  });

  it('updates the at-rest string after picking a model', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    await openLeadHouse('codex');
    const terra = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('GPT-5.6 Terra'))!;
    act(() => terra.click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Terra');
  });

  it('keeps worker models out of the orchestrator search', async () => {
    await act(async () => root.render(createElement(Harness)));
    selectMode('Multitask');
    await openLeadHouse('codex');
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'qwen');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid^="worker-row-"]')).toBeNull();
    expect(container.querySelector('[data-testid^="lead-row-"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click());
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Worker models');
    expect(container.querySelector('[data-testid^="lead-row-"]')).toBeNull();
  });

  it('selects an orchestrator search result with Enter', async () => {
    await act(async () => root.render(createElement(Harness)));
    selectMode('Multitask');
    await openLeadHouse('codex');
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'astra');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="lead-row-gpt-6-astra"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-workers-scroll"]')).toBeNull();
    act(() => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Astra');
  });

  it('clears search after model selection without opening thinking', async () => {
    await act(async () => root.render(createElement(Harness)));
    await openLeadHouse('codex');
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, 'opus 4.8');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-claude-opus-4-8"]')!.click());
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')).toBeNull();
    await openLeadHouse('claude');
    expect(container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!.value).toBe('');
  });

  it('uses the dedicated effort slider without routing its keyboard input into hidden rows', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    await openLeadEffort('codex', 'gpt-5.6-sol');
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('extra');
  });

  it('selects a connected local agent without requiring a model catalogue', async () => {
    await act(async () => root.render(createElement(Harness)));
    await openLeadHouse('acp');
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="lead-acp-default"]')!.click(); });
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).not.toContain('Sol');
  });

  it('shows connected searchable houses directly in the rail', async () => {
    await act(async () => root.render(createElement(Harness)));
    await openLeadHouse('codex');
    const searchable = COMPOSER_MODEL_GROUPS.find((group) => group.searchable)!;
    expect(container.querySelector(`[data-testid="lead-house-${searchable.key}"]`)).not.toBeNull();
  });

  it('moves keyboard focus through model choices without entering worker settings', async () => {
    await act(async () => root.render(createElement(Harness)));
    selectMode('Multitask');
    await openLeadHouse('codex');
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    act(() => { search.focus(); search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="lead-row-gpt-6-astra"]'));
    act(() => (document.activeElement as HTMLButtonElement).click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Astra');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps the classic footer and exposes no selector ids while the flag is off', async () => {
    localStorage.setItem('o8:composer-selector-v1', '0');
    await act(async () => {
      root.render(createElement(InputButtons, {
        input: 'Build it',
        enhancing: false,
        preEnhanceInput: null,
        onEnhance: () => {},
        onUndoEnhance: () => {},
        onSubmit: () => {},
        modelLabel: 'Sol',
        modelId: 'gpt-5.6-sol',
        activeBackend: 'codex',
        effort: 'high',
        adaptiveEnabled: true,
        onEffortChange: () => {},
        composerMode: 'solo',
        onComposerModeChange: () => {},
        composerSelectorV1Enabled: false,
      }));
    });

    expect(container.querySelector('[data-testid="composer-selector-footer"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send (Enter)"]')).not.toBeNull();
    expect(container.querySelector('button[title="Attach files"]')).not.toBeNull();
  });

  it('defaults to the selector footer and keeps the classic footer behind opt-out', async () => {
    expect(renderToStaticMarkup(createElement(RealComposerHarness)))
      .toContain('data-testid="composer-selector-footer"');
    act(() => { root.render(createElement(RealComposerHarness, { key: 'default' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="composer-selector-footer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-lead"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="test-leading-extra"]')).not.toBeNull();
    expect(container.querySelector('button[title^="Project target"]')?.textContent).toContain('Test repo');
    expect(container.querySelector('[data-testid="composer-selector-session-rules"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="test-context-meter"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="Voice mode off"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Fleet worker: Codex. Starts: Run now"]')).toBeNull();

    localStorage.setItem('o8:composer-selector-v1', '0');
    act(() => { root.render(createElement(RealComposerHarness, { key: 'classic' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="composer-selector-footer"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Mode:"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.title.startsWith('5.6 Sol ·'))).toBe(true);
  });

  it('keeps classic mode labels aligned when the top effort and Shared are picked', async () => {
    localStorage.setItem('o8:composer-selector-v1', '0');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const modeTrigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!;
    const modelTrigger = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title.startsWith('5.6 Sol ·'))!;
    expect(modelTrigger.title).toContain(modeTrigger.getAttribute('aria-label')!.replace('Mode: ', ''));

    const effortTrigger = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title.startsWith('Reasoning:'))!;
    act(() => effortTrigger.click());
    const effortSlider = container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(effortSlider.getAttribute('aria-valuemax')).toBe(String(
      supportedEffortsForLead('codex', 'gpt-5.6-sol', true).length - 1,
    ));
    for (let index = 0; index < 7; index += 1) {
      act(() => effortSlider.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        cancelable: true,
      })));
    }
    expect(container.querySelector('[data-testid="real-composer-mode"]')?.textContent).toBe('solo');
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('max');
    expect(effortTrigger.textContent).toBe('Max');
    expect(modelTrigger.title).toContain(modeTrigger.getAttribute('aria-label')!.replace('Mode: ', ''));

    const topEffort = container.querySelector('[data-testid="real-composer-effort"]')?.textContent;
    act(() => modeTrigger.click());
    const choices = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(choices.map(button => button.textContent)).toEqual(['Solo', 'Shared', 'Multitask']);
    act(() => choices.find(button => button.textContent === 'Shared')!.click());
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe(topEffort);
    expect(modelTrigger.title).toContain('Shared');
    expect(modeTrigger.getAttribute('aria-label')).toBe('Mode: Shared');
  });

  it('uses the effective default lead for classic Codex Ultra capability', async () => {
    localStorage.setItem('o8:composer-selector-v1', '0');
    localStorage.setItem('o8:orchestrator:ultra-effort', '1');
    act(() => { root.render(createElement(NoPinCodexHarness, {})); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const effortTrigger = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title.startsWith('Reasoning:'))!;
    act(() => effortTrigger.click());

    const effectiveModel = resolveEffectiveComposerLeadModelId('codex', undefined)!;
    const expectedStops = supportedEffortsForLead('codex', effectiveModel, true, false, true);
    expect(container.querySelector('[role="slider"]')?.getAttribute('aria-valuemax'))
      .toBe(String(expectedStops.length - 1));
  });

  it('uses the dedicated effort slider after choosing a lead model', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    await openLeadEffort('codex', 'gpt-5.6-sol');
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('extra');
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('low');
  });

  it('drops the Ultra stop when the thinking preference event disables it', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    localStorage.setItem('o8:orchestrator:ultra-effort', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await openLeadEffort('codex', 'gpt-5.6-sol');
    expect(container.querySelectorAll('[data-testid="composer-selector-effort-stop"]')).toHaveLength(6);

    localStorage.setItem('o8:orchestrator:ultra-effort', '0');
    await act(async () => {
      window.dispatchEvent(new CustomEvent('cortex:orchestrator-thinking-preferences'));
    });
    expect(container.querySelectorAll('[data-testid="composer-selector-effort-stop"]')).toHaveLength(5);
  });

  it('clamps and persists Ultra to Max when the preference turns off', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    localStorage.setItem('o8:orchestrator:ultra-effort', '1');
    localStorage.setItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, JSON.stringify({ 'gpt-5.6-sol': 'ultra' }));
    act(() => { root.render(createElement(RealComposerHarness, { initialEffort: 'ultra' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('ultra');

    localStorage.setItem('o8:orchestrator:ultra-effort', '0');
    await act(async () => {
      window.dispatchEvent(new CustomEvent('cortex:orchestrator-thinking-preferences'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('max');
    expect(JSON.parse(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY) ?? '{}'))
      .toEqual({ 'gpt-5.6-sol': 'max' });
  });

  it('resolves a no-pin Codex lead to the effective catalogue default', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(NoPinCodexHarness, {})); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const catalogueDefault = COMPOSER_MODEL_GROUPS
      .flatMap((group) => group.options)
      .find((option) => option.backend === 'codex' && option.model === MODEL_IDS.codexDefault)!;
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    expect(picker.textContent).toContain(catalogueDefault.label);
    expect(container.querySelector('[data-testid="composer-selector-thinking"]')?.textContent).toContain('extra');

    await act(async () => picker.click());
    const selectedLeadHouses = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="lead-house-"][aria-pressed="true"]')];
    expect(selectedLeadHouses).toHaveLength(1);
    expect(selectedLeadHouses[0]?.dataset.testid).toBe('lead-house-codex');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-house-codex"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>(`[data-testid="lead-row-${MODEL_IDS.codexDefault}"]`)!.click());
    expect(container.querySelector('[data-testid="composer-selector-lead-effort"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-thinking"]')!.click());
    expect(container.querySelector('[data-testid="composer-selector-lead-effort"]')).not.toBeNull();
  });

  it('bounds worker houses and models without additional startup choices', async () => {
    await act(async () => root.render(createElement(Harness)));
    selectMode('Multitask');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click());
    const popover = container.querySelector<HTMLElement>('[data-testid="composer-selector-popover"]')!;
    const workerScroll = container.querySelector<HTMLElement>('[data-testid="composer-selector-workers-scroll"]')!;
    expect(popover.style.overflowY).toBe('hidden');
    expect(workerScroll.style.overflowY).toBe('auto');
    expect(workerScroll.style.scrollbarWidth).toBe('none');
    expect(container.querySelectorAll('[data-testid^="worker-house-"]')).toHaveLength(listDispatchableRuntimes().length);
    expect(workerScroll.querySelectorAll('[data-testid^="worker-row-"]').length).toBeGreaterThan(1);
    expect(container.querySelector('[data-testid="composer-selector-worker-start"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-selector-worker-options"]')).toBeNull();
  });

  it('shows a configured local Codex default as the selected lead', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(NoPinCodexHarness, { codexDefaultDispatchModel: 'ollama:local-code:32b' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    expect(picker.textContent).toContain('local-code:32b');
    await act(async () => picker.click());
    const selectedLeadHouses = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="lead-house-"][aria-pressed="true"]')];
    expect(selectedLeadHouses).toHaveLength(1);
    expect(selectedLeadHouses[0]?.dataset.testid).toBe('lead-house-codex');
  });
  it('shows only installed worker choices and refreshes without changing the selected worker', async () => {
    let claudeReady = false;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({
      values: { defaultDispatchRuntime: 'codex', defaultDispatchModel: '', opencodeWorkerModel: null, workerStartMode: 'autonomous' },
      sources: {}, dispatchableRuntimes: [
        { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: 'Ready', fix: '' },
        { id: 'claude-code', label: 'Claude Code', available: claudeReady, unavailableReason: claudeReady ? null : 'not_installed', detail: '', fix: 'Install Claude Code' },
        { id: 'gemini', label: 'Gemini', available: false, unavailableReason: 'needs_auth', detail: '', fix: 'Sign in' },
      ],
    })));
    await act(async () => root.render(createElement(Harness)));
    selectMode('Multitask');
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click());
    expect(container.querySelector('[data-testid="worker-row-claude-code"]')).toBeNull();
    expect(container.querySelector('[data-testid="worker-house-gemini"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="worker-house-codex"]')?.getAttribute('aria-pressed')).toBe('true');
    claudeReady = true;
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Coding tools+')!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Refresh tools')!.click());
    expect(container.querySelector('[data-testid="worker-house-claude-code"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="worker-house-codex"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('persists favorites without changing the lead and selects them in one click after reopening', async () => {
    await act(async () => root.render(createElement(Harness)));
    await openLeadHouse('codex');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Favorite GPT-6 Astra"]')!.click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Sol');
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('o8:model-favorites:lead') ?? '[]')).toEqual([{ house: 'codex', id: 'gpt-6-astra', label: 'GPT-6 Astra' }]);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    expect(container.querySelector('[aria-label="Favorites"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelectorAll('[data-model-choice]')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-gpt-6-astra"]')!.click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Astra');
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-thinking-popover"]')).toBeNull();
  });

  it('checks a saved catalogue favorite before selection and rejects a stale id', async () => {
    localStorage.setItem('o8:model-favorites:lead', JSON.stringify([{ house: 'opencode', id: 'openrouter/stale/model', label: 'Saved model' }]));
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).startsWith('/api/orchestrator/backend-models') ? Response.json({ groups: [] }) : original(input, init));
    await act(async () => root.render(createElement(Harness)));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-openrouter/stale/model"]')!.click());
    expect(container.textContent).toContain('This favorite is unavailable');
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Sol');
    expect(container.querySelector('[data-testid="composer-selector-popover"]')).not.toBeNull();
  });

});
