// @vitest-environment jsdom
// Exercises deferred and direct backend application through a mounted hook caller.

import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK } from './operator-defaults';
import { useBackendSwitchChoice } from './useBackendSwitchChoice';

let currentSwitch: ReturnType<typeof useBackendSwitchChoice> | null = null;
const REPO_PATH = '/repo/backend-switch';

function Harness({ onBeforeApply }: { onBeforeApply: () => void }) {
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const latestAssistantBackendRef = useRef<'codex' | null>('codex');
  const [, setBackend] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorBackend);
  const [model, setModel] = useState('gpt-5.6-sol');
  const [, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const [, setActiveThreadAgent] = useState<string | null>(null);
  const [, setActiveThreadBackend] = useState<OrchestratorBackendId | null>('codex');
  const backendSwitch = useBackendSwitchChoice({
    backendSourceRef,
    currentModel: model,
    latestAssistantBackendRef,
    operatorDefaults: THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
    repoPath: REPO_PATH,
    setActiveThreadAgent,
    setActiveThreadBackend,
    setBackend,
    setModel,
    setOperatorDefaults,
    onBeforeApply,
  });
  useEffect(() => {
    currentSwitch = backendSwitch;
    return () => { currentSwitch = null; };
  }, [backendSwitch]);
  return createElement(
    'div',
    null,
    createElement('output', null, backendSwitch.pending?.backend ?? 'none'),
    createElement('span', { 'data-testid': 'backend-switch-model' }, model),
  );
}

describe('useBackendSwitchChoice', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      values: { orchestratorBackend: 'claude' },
    }), { status: 200 })));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('runs the lead-change reset only when a deferred backend switch applies', async () => {
    const onBeforeApply = vi.fn();
    await act(async () => { root.render(createElement(Harness, { onBeforeApply })); });

    act(() => currentSwitch!.request('claude', 'claude-sonnet-5'));
    expect(host.querySelector('output')?.textContent).toBe('claude');
    expect(onBeforeApply).not.toHaveBeenCalled();

    await act(async () => { currentSwitch!.acceptHandoff(); });
    expect(onBeforeApply).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('claude-sonnet-5');
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('claude-sonnet-5');

    await act(async () => { currentSwitch!.apply('codex', 'gpt-5.6-terra'); });
    expect(onBeforeApply).toHaveBeenCalledTimes(2);
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('gpt-5.6-terra');

    await act(async () => { currentSwitch!.selectModel('gpt-6-astra'); });
    expect(onBeforeApply).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('gpt-6-astra');
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('gpt-6-astra');
  });

  it('rolls the session model back without changing storage when backend persistence fails', async () => {
    writeStoredOrchestratorModel(REPO_PATH, 'gpt-5.6-sol');
    vi.mocked(fetch).mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await act(async () => { root.render(createElement(Harness, { onBeforeApply: vi.fn() })); });

    act(() => currentSwitch!.request('claude', 'claude-sonnet-5'));
    await act(async () => {
      currentSwitch!.acceptHandoff();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('gpt-5.6-sol');
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('gpt-5.6-sol');
  });
});
