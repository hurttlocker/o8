// @vitest-environment jsdom
// Exercises deferred and direct backend application through a mounted hook caller.

import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { THOUGHTS_OPERATOR_DEFAULTS_FALLBACK } from './operator-defaults';
import { useBackendSwitchChoice } from './useBackendSwitchChoice';

let currentSwitch: ReturnType<typeof useBackendSwitchChoice> | null = null;

function Harness({ onBeforeApply }: { onBeforeApply: () => void }) {
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const latestAssistantBackendRef = useRef<'codex' | null>('codex');
  const [, setBackend] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.orchestratorBackend);
  const [, setModel] = useState('gpt-5.6-sol');
  const [, setOperatorDefaults] = useState(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK);
  const [, setActiveThreadAgent] = useState<string | null>(null);
  const [, setActiveThreadBackend] = useState<OrchestratorBackendId | null>('codex');
  const backendSwitch = useBackendSwitchChoice({
    backendSourceRef,
    currentModel: 'gpt-5.6-sol',
    latestAssistantBackendRef,
    operatorDefaults: THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
    repoPath: '/repo/backend-switch',
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
  return createElement('output', null, backendSwitch.pending?.backend ?? 'none');
}

describe('useBackendSwitchChoice', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    expect(host.textContent).toBe('claude');
    expect(onBeforeApply).not.toHaveBeenCalled();

    await act(async () => { currentSwitch!.acceptHandoff(); });
    expect(onBeforeApply).toHaveBeenCalledTimes(1);

    await act(async () => { currentSwitch!.apply('codex', 'gpt-5.6-terra'); });
    expect(onBeforeApply).toHaveBeenCalledTimes(2);
  });
});
