// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUIChrome } from './useUIChrome';

describe('dashboard chat list preferences', () => {
  let root: Root;
  let host: HTMLDivElement;
  let value: ReturnType<typeof useUIChrome>;
  function Probe() {
    const chrome = useUIChrome();
    useLayoutEffect(() => { value = chrome; });
    return createElement('div');
  }
  function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(createElement(Probe)));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    vi.restoreAllMocks();
  });
  it('restores a deliberately collapsed list without changing the destination', () => {
    mount();
    act(() => value.setSidebarVisible(false));
    act(() => value.setActiveNavSection('automations'));
    expect(value.sidebarVisible).toBe(false);
    act(() => root.unmount());
    host.remove();
    mount();
    expect(value.sidebarVisible).toBe(false);
    expect(value.activeNavSection).toBe('agents');
  });
  it('remembers list width independently of visibility and destination changes', () => {
    mount();
    act(() => {
      value.setSidebarWidth(384);
      value.setSidebarVisible(false);
      value.setActiveNavSection('projects');
    });
    act(() => root.unmount());
    host.remove();
    mount();
    expect(value.sidebarWidth).toBe(384);
    expect(value.sidebarVisible).toBe(false);
    act(() => value.setSidebarVisible(true));
    expect(value.sidebarWidth).toBe(384);
    expect(localStorage.getItem('o8:sidebar:width')).toBe('384');
  });
  it.each(['NaN', '0', '999'])('ignores invalid saved width %s', (width) => {
    localStorage.setItem('o8:sidebar:width', width);
    mount();
    expect(value.sidebarWidth).toBe(300);
  });
  it('stays usable when persistence is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
    mount();
    act(() => value.setSidebarVisible(false));
    expect(value.sidebarVisible).toBe(false);
  });
});
