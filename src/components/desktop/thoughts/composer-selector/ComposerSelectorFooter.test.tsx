// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposerSelectorFooter } from './ComposerSelectorFooter';
import { cycleComposerSelectorMode, type ComposerSelectorMode } from './state';
import { InputButtons } from '../InputButtons';
import { ComposerArea } from '../chat-panel/ComposerArea';
import { COMPOSER_MODEL_GROUPS } from '../ModelThinkingChip';
import type { OrchestratorBackendSetting } from '../operator-defaults';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { MODEL_IDS } from '@/lib/models';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

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

function Harness() {
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-5.6-sol');
  return (
    <div>
      <textarea
        data-testid="composer-textarea"
        onKeyDown={(event) => {
          if (event.key === 'Tab' && event.shiftKey) {
            event.preventDefault();
            setMode((current) => cycleComposerSelectorMode(current));
          }
        }}
      />
      <ComposerSelectorFooter
        input="Build it"
        mode={mode}
        onModeChange={setMode}
        modelId={model}
        modelLabel={model === 'gpt-5.6-sol' ? 'Sol' : 'Terra'}
        activeBackend="codex"
        onModelChange={setModel}
        effort={effort}
        onEffortChange={setEffort}
        adaptiveEnabled
        attachControl={<button type="button">Attach</button>}
        micControl={<button type="button">Mic</button>}
        sendControl={<button type="button">Send</button>}
      />
    </div>
  );
}

function RealComposerHarness() {
  const [input, setInput] = useState('Build it');
  const [mode, setMode] = useState<ComposerSelectorMode>('solo');
  const [effort, setEffort] = useState<ThinkingEffort>('high');
  const [model, setModel] = useState('gpt-5.6-sol');
  const [backend, setBackend] = useState<OrchestratorBackendSetting>('codex');
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
      modelLabel={model === 'gpt-5.6-sol' ? 'Sol' : model}
      modelId={model}
      onModelChange={setModel}
      activeBackend={backend}
      onBackendChange={(next, nextModel) => { setBackend(next); if (nextModel) setModel(nextModel); }}
      effort={effort}
      operatorDefaultEffort="high"
      onEffortChange={setEffort}
      adaptiveEnabled
      displayMessagesCount={0}
      hasAssistantActivity={false}
      composerMode={mode}
      onComposerModeChange={setMode}
      sessionRulesThreadId="thread-test"
    />
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

  it('orders mode, attach, picker, mic, and send with mic immediately before send', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const footer = container.querySelector('[data-testid="composer-selector-footer"]');
    expect([...footer!.children].map((node) => node.getAttribute('data-testid'))).toEqual([
      'composer-selector-mode',
      'composer-selector-attach',
      'composer-selector-spacer',
      'composer-selector-picker',
      'composer-selector-mic',
      'composer-selector-send',
    ]);
    expect(footer?.querySelector('[data-testid="composer-selector-send"]')?.previousElementSibling)
      .toBe(footer?.querySelector('[data-testid="composer-selector-mic"]'));
  });

  it('cycles all four modes with Shift+Tab and keeps textarea focus', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.focus();
    for (const label of ['Multitask', 'Compare plans', 'Fusion', 'Solo']) {
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
    expect(container.querySelector('[data-testid="composer-selector-picker"]')?.textContent).toContain('xhigh');

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    search.focus();
    expect(document.activeElement).toBe(search);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-picker"]')?.textContent).toContain('xhigh');
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true }));
    });
    expect(container.querySelector('[data-testid="composer-selector-picker"]')?.textContent).toContain('high');
  });

  it('selecting Fusion leaves effort unchanged', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    const mode = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-mode"]')!;
    act(() => mode.click());
    const fusion = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Fusion'))!;
    act(() => fusion.click());
    expect(container.querySelector('[data-testid="composer-selector-picker"]')?.textContent).toContain('high');
  });

  it('updates the at-rest string after picking a model', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
    const terra = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('GPT-5.6 Terra'))!;
    act(() => terra.click());
    expect(container.querySelector('[data-testid="composer-selector-picker"]')?.textContent).toContain('Terra');
  });

  it('search narrows both lead and worker rows', async () => {
    await act(async () => { root.render(createElement(Harness)); });
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
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
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
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
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
    const search = container.querySelector<HTMLInputElement>('[data-testid="composer-selector-search"]')!;
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    await act(async () => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(fetch).toHaveBeenCalledWith('/api/panel/operator-defaults', expect.objectContaining({
      body: JSON.stringify({ defaultDispatchRuntime: lastRuntime }),
    }));
  });

  it('keeps the classic footer and exposes no selector ids while the flag is off', async () => {
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
      }));
    });

    expect(container.querySelector('[data-testid="composer-selector-footer"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Send (Enter)"]')).not.toBeNull();
    expect(container.querySelector('button[title="Attach files"]')).not.toBeNull();
  });

  it('uses the selector footer from the real flag gate', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(RealComposerHarness)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[data-testid="composer-selector-footer"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Fleet worker: Codex. Starts: Run now"]')).toBeNull();
  });

  it('resolves a no-pin Codex lead to the effective catalogue default', async () => {
    localStorage.setItem('o8:composer-selector-v1', '1');
    act(() => { root.render(createElement(NoPinCodexHarness, {})); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const catalogueDefault = COMPOSER_MODEL_GROUPS
      .flatMap((group) => group.options)
      .find((option) => option.backend === 'codex' && option.model === MODEL_IDS.codexDefault)!;
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!;
    expect(picker.textContent).toContain(`${catalogueDefault.label}· xhigh`);

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
    act(() => container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!.click());
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
    const picker = container.querySelector<HTMLButtonElement>('[data-testid="composer-selector-picker"]')!;
    expect(picker.textContent).toContain('local-code:32b');
    act(() => picker.click());
    const selectedLeadRows = [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="lead-row-"][aria-pressed="true"]')];
    expect(selectedLeadRows).toHaveLength(1);
    expect(selectedLeadRows[0]?.dataset.testid).toBe('lead-row-ollama:local-code:32b');
  });
});
