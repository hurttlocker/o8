// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useUIChrome } from './useUIChrome';
import { useFtuxMilestones } from './useFtuxMilestones';

it('a late completion cannot reopen or widen a deliberately closed chat list', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let chrome: ReturnType<typeof useUIChrome>;
  let ftux: ReturnType<typeof useFtuxMilestones>;
  function Probe() {
    const currentChrome = useUIChrome();
    const currentFtux = useFtuxMilestones({
      sidebarVisible: currentChrome.sidebarVisible,
      setLeftWidth: currentChrome.setSidebarWidth,
      setSidebarVisible: currentChrome.setSidebarVisible,
      sidebarManualIntentRef: currentChrome.sidebarManualIntentRef,
    });
    useLayoutEffect(() => { chrome = currentChrome; ftux = currentFtux; });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => {
      chrome.sidebarManualIntentRef.current = true;
      chrome.setSidebarVisible(false);
      chrome.setActiveNavSection('projects');
    });
    await act(async () => { ftux.enqueueFtuxMilestone('firstCompletion'); });
    expect(ftux!.activeFtuxMilestone).toBe('firstCompletion');
    expect(chrome!.sidebarVisible).toBe(false);
    expect(chrome!.sidebarWidth).toBe(300);
    expect(chrome!.activeNavSection).toBe('projects');
  } finally {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  }
});
