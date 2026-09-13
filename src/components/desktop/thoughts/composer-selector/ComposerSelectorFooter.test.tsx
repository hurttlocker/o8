// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY,
  COMPOSER_SELECTOR_MODES,
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
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import { WORKER_START_OPTIONS } from '@/lib/operator/worker-start-mode';
import { MODEL_IDS } from '@/lib/models';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

const entitlementState = vi.hoisted(() => ({ plan: 'free' as 'free' | 'founder' }));

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
  effortTestId,
}: {
  initialModel?: string;
  initialBackend?: OrchestratorBackendSetting;
  initialEffort?: ThinkingEffort;
  effortTestId?: string;
} = {}) {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
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
        modelId={model}
        modelLabel={model === 'gpt-5.6-sol' ? 'Sol' : model}
        onModelChange={setModel}
        activeBackend={backend}
        onBackendChange={(next, nextModel) => { setBackend(next); if (nextModel) setModel(nextModel); }}
        effort={effort}
        operatorDefaultEffort={initialEffort}
        onEffortChange={setEffort}
        adaptiveEnabled
        displayMessagesCount={0}
        hasAssistantActivity={false}
        composerMode={mode}
        onComposerModeChange={setMode}
        sessionRulesThreadId="harness-thread"
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
        onBackendChange={(next, nextModel) => { setBackend(next); if (nextModel) setModel(nextModel); }}
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
    entitlementState.plan = 'free';
    invalidateOperatorDefaultsValuesSnapshot();
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
      return new Response(JSON.stringify({
        values: {
          defaultDispatchRuntime: body.defaultDispatchRuntime ?? 'codex',
          defaultDispatchModel: '',
          opencodeWorkerModel: null,
          workerStartMode: body.workerStartMode ?? 'autonomous',
        },
        sources: {},
      }), { status: 200 });
    }));
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
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

  it('orders mode, attach, lead, mic, and send with mic immediately before send', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const footer = container.querySelector('[data-testid="composer-selector-footer"]');
    expect([...footer!.children].map((node) => node.getAttribute('data-testid'))).toEqual([
      'composer-selector-mode',
      'composer-selector-attach',
      'composer-selector-leading-controls',
      'composer-selector-spacer',
      'composer-selector-lead',
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
    expect(lead.querySelectorAll('[data-testid="composer-selector-meter-bar"]')).toHaveLength(expectedEfforts.length);
    expect(lead.querySelectorAll('[data-testid="composer-selector-meter-bar"][data-lit="true"]')).toHaveLength(expectedEfforts.indexOf('high') + 1);
    expect(lead.textContent).toContain('high');
    expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();

    act(() => lead.click());
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(slider).not.toBeNull();
    const stops = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')];
    expect(stops).toHaveLength(expectedEfforts.length);
    act(() => stops.find((stop) => stop.textContent === 'Extra')!.click());
    expect(lead.getAttribute('data-accent')).toBe('swarm');
    const extraBar = lead.querySelectorAll<HTMLElement>('[data-testid="composer-selector-meter-bar"]')
      [expectedEfforts.indexOf('xhigh')];
    const effortWord = lead.querySelector<HTMLElement>('[data-testid="composer-selector-effort-word"]')!;
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
      .find((button) => button.textContent?.includes('Fusion'))!.click());
    const fusionWorkers = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(fusionWorkers.querySelectorAll('[data-provider-mark]')).toHaveLength(3);
    expect(fusionWorkers.textContent).toContain(`${listDispatchableRuntimes().length} runtimes`);

    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Solo'))!.click());
    expect(container.querySelector('[data-testid="composer-selector-workers"]')).toBeNull();
  });

  it('renders composer setting text from the shared label tables', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const lead = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    act(() => lead.click());
    const pickerText = container.textContent ?? '';
    for (const effort of supportedEffortsForLead('codex', 'gpt-5.6-sol', true)) {
      expect(pickerText).toContain(THINKING_EFFORT_LABELS[effort].long);
    }
    for (const option of WORKER_START_OPTIONS) expect(pickerText).toContain(option.long);

    act(() => lead.click());
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    const modeText = container.textContent ?? '';
    for (const option of COMPOSER_SELECTOR_MODES) expect(modeText).toContain(option.long);
    const comparePlans = COMPOSER_SELECTOR_MODES.find((option) => option.id === 'moa')!;
    expect(modeText).toContain(comparePlans.long);
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes(comparePlans.long))!.click());
    expect(mode.textContent).toContain(comparePlans.short);
    expect(mode.getAttribute('aria-label')).toBe(`Mode: ${comparePlans.long}`);
    expect(mode.title).toContain(comparePlans.long);
  });

  it('persists Extra through the real flag-on composer path', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const lead = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    act(() => lead.click());
    const extra = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')]
      .find((stop) => stop.textContent === 'Extra')!;
    act(() => extra.click());

    expect(JSON.parse(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY) ?? '{}'))
      .toEqual({ 'gpt-5.6-sol': 'xhigh' });
    expect(lead.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('extra');
    expect(lead.getAttribute('data-accent')).toBe('swarm');
    expect(lead.querySelector<HTMLElement>('[data-testid="composer-selector-effort-word"]')?.style.color)
      .toBe('var(--t-brand-orange)');
  });

  it('resolves thread storage through the real ComposerArea path before the operator default', async () => {
    localStorage.setItem(`${COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY}:thread:thread-real`, JSON.stringify({ 'gpt-5.6-sol': 'high' }));
    await act(async () => { root.render(createElement(RealComposerHarness, { threadId: 'thread-real', operatorDefaultEffort: 'low' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe('high');
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
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
      } : {},
    ), { status: 200 }));
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Multitask'))!.click());

    const workers = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!;
    expect(workers.textContent).toContain('OpenCode 2');
    expect(workers.textContent).not.toContain('OC2');
    expect(workers.style.maxWidth).not.toBe('');
    expect(workers.querySelector<HTMLElement>('[data-testid="composer-selector-workers-label"]')?.style.textOverflow)
      .toBe('ellipsis');
  });

  it('marks every picker row and shows model-specific effort consequences', async () => {
    entitlementState.plan = 'founder';
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(container.querySelector('[data-testid="composer-selector-search"]'));

    const leadRows = [...container.querySelectorAll<HTMLElement>('[data-testid^="lead-row-"]')];
    const workerRows = [...container.querySelectorAll<HTMLElement>('[data-testid^="worker-row-"]')];
    expect(leadRows.every((row) => row.querySelector('[data-provider-mark]'))).toBe(true);
    expect(workerRows.every((row) => row.querySelector('[data-provider-mark]'))).toBe(true);
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('High · default for real work');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="lead-row-o8-free"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const o8Stops = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')];
    expect(o8Stops).toHaveLength(2);
    expect(o8Stops[0]?.textContent).toBe('Low');
    act(() => o8Stops[0]!.click());
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('Low · free');
    act(() => o8Stops[1]!.click());
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('High · founders');
  });

  it('shows but refuses the locked founders effort on the free o8 plan', async () => {
    await act(async () => { root.render(createElement(O8PlanHarness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const high = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')]
      .find((stop) => stop.textContent === 'High')!;

    expect(high).not.toBeUndefined();
    expect(high.getAttribute('aria-disabled')).toBe('true');
    expect(high.style.color).toBe('var(--t-text-faint)');
    expect(high.style.cursor).toBe('default');
    expect(high.style.background).toBe('transparent');
    act(() => high.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('High · founders');
    expect(high.style.background).toBe('transparent');
    act(() => high.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('Low · free');
    act(() => high.focus());
    expect(container.querySelector('[data-testid="composer-selector-effort-consequence"]')?.textContent)
      .toContain('High · founders');
    act(() => high.click());
    act(() => high.dispatchEvent(new KeyboardEvent('keydown', {
      key: '†',
      code: 'KeyT',
      altKey: true,
      bubbles: true,
    })));

    expect(container.querySelector('[data-testid="o8-plan-effort"]')?.textContent).toBe('low');
    expect(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY)).toBeNull();
  });

  it('selects and persists the founders effort on the paid o8 plan', async () => {
    entitlementState.plan = 'founder';
    localStorage.setItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY, JSON.stringify({ 'o8-free': 'low' }));
    await act(async () => { root.render(createElement(O8PlanHarness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const high = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="composer-selector-effort-stop"]')]
      .find((stop) => stop.textContent === 'High')!;

    expect(high.getAttribute('aria-disabled')).toBeNull();
    act(() => high.click());

    expect(container.querySelector('[data-testid="o8-plan-effort"]')?.textContent).toBe('high');
    expect(JSON.parse(localStorage.getItem(COMPOSER_EFFORT_BY_MODEL_STORAGE_KEY) ?? '{}'))
      .toEqual({ 'o8-free': 'high' });
  });

  it('cycles all four modes with Shift+Tab and keeps textarea focus', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.focus();
    for (const label of ['Multitask', 'MoA', 'Fusion', 'Solo']) {
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
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('extra');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    search.focus();
    expect(document.activeElement).toBe(search);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('extra');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('high');
  });

  it('selecting Fusion leaves effort unchanged', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    const fusion = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Fusion'))!;
    act(() => fusion.click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('high');
  });

  it('updates the at-rest string after picking a model', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const terra = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('GPT-5.6 Terra'))!;
    act(() => terra.click());
    expect(container.querySelector('[data-testid="composer-selector-lead"]')?.textContent).toContain('Terra');
  });

  it('search narrows both lead and worker rows', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'codex');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="lead-row-gpt-5.6-sol"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="lead-row-claude-sonnet-5"]')).toBeNull();
    expect(container.querySelector('[data-testid="worker-row-codex"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="worker-row-claude-code"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Plan first')).toBe(true);
  });

  it('includes live searchable lead houses from the shared model catalogue', async () => {
    const searchable = COMPOSER_MODEL_GROUPS.find((group) => group.searchable)!;
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    expect(container.querySelector(`[data-testid="lead-row-${searchable.key}"]`)).not.toBeNull();

    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, searchable.label);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector(`[data-testid="lead-row-${searchable.key}"]`)).not.toBeNull();
  });

  it('uses arrow navigation and Enter across the lead and worker sections', async () => {
    const lastRuntime = listDispatchableRuntimes().at(-1)!;
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetch).toHaveBeenCalledWith('/api/panel/operator-defaults', expect.objectContaining({
      body: JSON.stringify({ defaultDispatchRuntime: lastRuntime }),
    }));
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
    expect(container.querySelector('button[title="Chat target"]')?.textContent).toContain('Test repo');
    expect(container.querySelector('[data-testid="composer-selector-session-rules"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="test-context-meter"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label^="Voice mode off"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Fleet worker: Codex. Starts: Run now"]')).toBeNull();

    localStorage.setItem('o8:composer-selector-v1', '0');
    act(() => { root.render(createElement(RealComposerHarness, { key: 'classic' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="composer-selector-footer"]')).toBeNull();
    expect(container.querySelector('button[aria-label^="Mode:"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .some((button) => button.title.startsWith('Sol ·'))).toBe(true);
  });

  it('keeps classic mode labels aligned when the top effort and Fusion are picked', async () => {
    localStorage.setItem('o8:composer-selector-v1', '0');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const modeTrigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Mode:"]')!;
    const modelTrigger = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title.startsWith('Sol ·'))!;
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
    const fusion = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Fusion')!;
    act(() => fusion.click());
    expect(container.querySelector('[data-testid="real-composer-effort"]')?.textContent).toBe(topEffort);
    expect(modelTrigger.title).toContain('Fusion');
    expect(modeTrigger.getAttribute('aria-label')).toBe('Mode: Fusion');
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

  it('moves the focused slider with arrows and digit keys', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    act(() => slider.focus());
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('extra');
    await act(async () => {
      slider.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-effort-word"]')?.textContent).toBe('low');
  });

  it('drops the Ultra stop when the thinking preference event disables it', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    localStorage.setItem('o8:orchestrator:ultra-effort', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!.click());
    expect(container.querySelectorAll('[data-testid="composer-selector-effort-stop"]')).toHaveLength(7);

    localStorage.setItem('o8:orchestrator:ultra-effort', '0');
    await act(async () => {
      window.dispatchEvent(new CustomEvent('cortex:orchestrator-thinking-preferences'));
    });
    expect(container.querySelectorAll('[data-testid="composer-selector-effort-stop"]')).toHaveLength(6);
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
    expect(picker.textContent).toContain('extra');

    act(() => picker.click());
    const selectedLeadRows = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="lead-row-"][aria-pressed="true"]')];
    expect(selectedLeadRows).toHaveLength(1);
    expect(selectedLeadRows[0]?.dataset.testid).toBe(`lead-row-${MODEL_IDS.codexDefault}`);
    expect(container.querySelector('[data-testid="composer-selector-lead-effort"]')).not.toBeNull();
  });

  it('bounds worker scrolling without removing runtimes or the fixed controls', async () => {
    const scrollIntoView = vi.fn();
    const lastRuntime = listDispatchableRuntimes().at(-1)!;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    vi.mocked(fetch).mockImplementation(async (input) => new Response(JSON.stringify(
      String(input).includes('include=values') ? {
        values: {
          defaultDispatchRuntime: lastRuntime,
          defaultDispatchModel: '',
          opencodeWorkerModel: null,
          workerStartMode: 'autonomous',
        },
        sources: {},
      } : {},
    ), { status: 200 }));
    await act(async () => { root.render(createElement(Harness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Multitask'))!.click());
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-workers"]')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const popover = container.querySelector<HTMLElement>('[data-testid="composer-selector-popover"]')!;
    const workerScroll = container.querySelector<HTMLElement>('[data-testid="composer-selector-workers-scroll"]')!;
    expect(popover.style.height).toContain('460px');
    expect(popover.style.overflowY).toBe('hidden');
    expect(workerScroll.style.overflowY).toBe('auto');
    expect(workerScroll.querySelectorAll('[data-testid^="worker-row-"]')).toHaveLength(listDispatchableRuntimes().length);
    expect(workerScroll.querySelector(`[data-testid="worker-row-${lastRuntime}"]`)?.getAttribute('aria-pressed')).toBe('true');
    expect(workerScroll.textContent).not.toContain('Plan first');
    expect(popover.textContent).toContain('Plan first');
    expect(popover.textContent).toContain('pick');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.instances).toContain(workerScroll.querySelector(`[data-testid="worker-row-${lastRuntime}"]`));
  });

  it('shows a configured local Codex default as the selected lead', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(NoPinCodexHarness, { codexDefaultDispatchModel: 'ollama:local-code:32b' })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-lead"]')!;
    expect(picker.textContent).toContain('local-code:32b');
    act(() => picker.click());
    const selectedLeadRows = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="lead-row-"][aria-pressed="true"]')];
    expect(selectedLeadRows).toHaveLength(1);
    expect(selectedLeadRows[0]?.dataset.testid).toBe('lead-row-ollama:local-code:32b');
  });
});
