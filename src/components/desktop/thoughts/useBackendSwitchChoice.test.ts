// @vitest-environment jsdom
// Exercises deferred and direct backend application through a mounted hook caller.

import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { readStoredOrchestratorModel, writeStoredOrchestratorModel } from '@/lib/orchestrator/store';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK } from './operator-defaults';
import { useBackendSwitchChoice, resolveFreshComposerTurnOptions } from './useBackendSwitchChoice';
import { prepareOrchestratorTurn } from './use-orchestrator-stream/turn-option-resolution';

let currentSwitch: ReturnType<typeof useBackendSwitchChoice> | null = null;
const REPO_PATH = '/repo/backend-switch';

function Harness({ onBeforeApply, persistSelection = true }: { onBeforeApply: () => void; persistSelection?: boolean }) {
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
    persistSelection,
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

  it('normalizes captured o8 options when a defaults refresh cannot complete', () => {
    expect(prepareOrchestratorTurn('fixture', { backend: 'o8', model: 'claude-opus-5' }).model).toBe('o8-free');
    expect(prepareOrchestratorTurn('fixture', { backend: 'o8', model: 'o8-next' }).model).toBe('o8-next');
    expect(prepareOrchestratorTurn('fixture', { backend: 'acp', model: '' }).model).toBe('');
    expect(prepareOrchestratorTurn('fixture', { backend: 'codex', model: 'gpt-6.1-sol' }).model).toBe('gpt-6.1-sol');
  });

  it('preserves the comparison provider model across refresh and preparation', async () => {
    writeStoredOrchestratorModel(REPO_PATH, 'claude-opus-5');
    const outgoing = await resolveFreshComposerTurnOptions({ repoPath: REPO_PATH, backend: 'o8', backendSourceRef: { current: 'user' }, setBackend: vi.fn(), setModel: vi.fn(), setOperatorDefaults: vi.fn() }, undefined, { collide: true, orchestrationMode: 'fleet' });
    const turn = prepareOrchestratorTurn('fixture', { ...outgoing, collide: true, orchestrationMode: 'fleet' });
    expect(turn).toMatchObject({ backend: 'collide', model: 'claude-opus-5', collideBaseBackend: 'o8' });
    expect(prepareOrchestratorTurn('fixture', { ...outgoing, collide: true, orchestrationMode: 'single' })).toMatchObject({ backend: 'o8', model: 'o8-free' });
    const single = await resolveFreshComposerTurnOptions({ repoPath: REPO_PATH, backend: 'o8', backendSourceRef: { current: 'user' }, setBackend: vi.fn(), setModel: vi.fn(), setOperatorDefaults: vi.fn() }, undefined, { collide: true, orchestrationMode: 'single' });
    expect(single).toMatchObject({ backend: 'o8', model: 'o8-free' });
  });

  it('clears a prior model pin when choosing a local agent default', async () => {
    await act(async () => { root.render(createElement(Harness, { onBeforeApply: vi.fn(), persistSelection: true })); });
    writeStoredOrchestratorModel(REPO_PATH, 'gpt-5.6-sol');
    await act(async () => { currentSwitch!.apply('acp', ''); });
    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('');
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('');
    const outgoing = await resolveFreshComposerTurnOptions({ repoPath: REPO_PATH, backend: 'acp', backendSourceRef: { current: 'user' }, setBackend: vi.fn(), setModel: vi.fn(), setOperatorDefaults: vi.fn() });
    expect(outgoing).toEqual({ backend: 'acp', model: '' });
    expect(prepareOrchestratorTurn('fixture', outgoing).model).toBe('');
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

  it('keeps reply model choices local without writing workspace defaults', async () => {
    writeStoredOrchestratorModel(REPO_PATH, 'gpt-6-astra');
    await act(async () => { root.render(createElement(Harness, { onBeforeApply: vi.fn(), persistSelection: false })); });
    await act(async () => { currentSwitch!.apply('o8', 'o8-free'); });
    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('o8-free');
    await act(async () => { currentSwitch!.selectModel('gpt-6-luna'); });
    expect(host.querySelector('[data-testid="backend-switch-model"]')?.textContent).toBe('gpt-6-luna');
    expect(readStoredOrchestratorModel(REPO_PATH)).toBe('gpt-6-astra');
    expect(fetch).not.toHaveBeenCalled();
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
