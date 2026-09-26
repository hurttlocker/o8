// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { buildTerminalTabHandle, type ImperativeHandleDeps } from './terminal-imperative-handle';
import { useOrchestratorTurnInjection } from './use-orchestrator-turn-injection';
import type { TerminalTab } from './types';
import type { ThoughtsChatPanelHandle } from '../thoughts/ThoughtsChatPanel';

it('delivers the first task only to its selected lead composer without sending', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const tabsRef = { current: [{ id: 'other', kind: 'orchestrator', label: 'Existing lead' }, { id: 'first-task', kind: 'orchestrator', label: 'Selected project lead', repoPath: '/fixture/project' }] as TerminalTab[] };
  const setTabs = vi.fn();
  const handle = buildTerminalTabHandle({ tabsRef, setTabs } as unknown as ImperativeHandleDeps);
  expect(handle.injectIntoOrchestrator('first-task', 'Explain this project', { autoSend: false })).toBe(true);
  expect(tabsRef.current[0].orchestratorTurnInjection).toBeUndefined();
  const injection = tabsRef.current[1].orchestratorTurnInjection!;
  expect(injection.autoSend).toBe(false);
  const panel = { fillInput: vi.fn(), focusInput: vi.fn(), sendNow: vi.fn() } as unknown as ThoughtsChatPanelHandle;
  const panelRef = { current: panel };
  const root = createRoot(document.createElement('div'));
  function Harness() {
    useOrchestratorTurnInjection(panelRef, injection, null, null, false);
    return null;
  }
  act(() => root.render(createElement(Harness)));
  expect(panel.fillInput).toHaveBeenCalledExactlyOnceWith('Explain this project');
  expect(panel.sendNow).not.toHaveBeenCalled();
  act(() => root.render(createElement(Harness)));
  expect(panel.fillInput).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});
