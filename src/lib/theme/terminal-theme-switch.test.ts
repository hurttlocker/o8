// @vitest-environment jsdom

import { act, createElement, createRef, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './context';
import { getPalette, resolveTheme } from './registry';
import { XtermPanel, type XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { BottomXtermPanel, type XtermPanelHandle as BottomHandle } from '@/components/desktop/BottomXtermPanel';

const terminals = vi.hoisted(() => [] as Array<{
  options: { theme?: Record<string, string> };
  output: string;
  disposed: boolean;
}>);

class MockTerminal {
  options: { theme?: Record<string, string> };
  output = '';
  disposed = false;
  cols = 80;
  rows = 24;
  unicode = { activeVersion: '' };
  buffer = { active: { length: 1, getLine: () => ({ translateToString: () => this.output }) } };
  constructor(options: { theme?: Record<string, string> }) { this.options = options; terminals.push(this); }
  open() {}
  loadAddon() {}
  focus() {}
  reset() { this.output = ''; }
  dispose() { this.disposed = true; }
  onData() { return { dispose() {} }; }
  onSelectionChange() { return { dispose() {} }; }
  write(data: Uint8Array | string, done?: () => void) {
    this.output += typeof data === 'string' ? data : new TextDecoder().decode(data);
    done?.();
  }
}
class MockAddon { fit() {} }
vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: MockAddon }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: MockAddon }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockAddon }));
vi.mock('@xterm/addon-image', () => ({ ImageAddon: MockAddon }));
vi.mock('@/components/desktop/workspace-terminal/xterm-selection-registry', () => ({
  recordXtermSelectionSnapshot: vi.fn(), registerXtermSelectionSource: () => () => {},
}));

type Theme = ReturnType<typeof useTheme>;
const workspace = createRef<XtermPanelHandle>();
const bottom = createRef<BottomHandle>();
const attach = vi.fn();
const input = vi.fn();
const resize = vi.fn();
const detach = vi.fn();
let currentTheme: Theme;

function OpenTerminals() {
  const theme = useTheme();
  useEffect(() => { currentTheme = theme; }, [theme]);
  const props = { sendTerminalAttach: attach, sendTerminalInput: input, sendTerminalResize: resize, sendTerminalDetach: detach, visible: true };
  return createElement('div', null,
    createElement(XtermPanel, { ...props, ref: workspace, tmuxSession: 'theme-workspace', transparent: theme.workspaceGlass }),
    createElement(BottomXtermPanel, { ...props, ref: bottom, tmuxSession: 'theme-bottom' }),
  );
}

describe('appearance changes with terminals already open', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'on');
    localStorage.setItem('cortex-workspace-glass', 'false');
    Object.assign(window, { __O8_HOST_PLATFORM__: 'macos' });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(performance.now()); return 1; });
    terminals.length = 0;
    vi.clearAllMocks();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.getElementById('xterm-css')?.remove();
    document.getElementById('theme-transition')?.remove();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    delete (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__;
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('updates ink, cursor, selection and ANSI colors on every light/dark switch without reattaching', async () => {
    await act(async () => root.render(createElement(ThemeProvider, null, createElement(OpenTerminals))));
    expect(terminals).toHaveLength(2);
    await act(async () => {
      workspace.current?.writeData(btoa('workspace prompt and draft'));
      bottom.current?.writeData(btoa('bottom prompt and draft'));
    });
    const original = [...terminals];
    const output = original.map((terminal) => terminal.output);
    expect(attach).toHaveBeenCalledTimes(2);
    for (const palette of ['light', 'dark', 'light', 'dark'] as const) {
      await act(async () => currentTheme.setPalette(palette));
      const vars = resolveTheme(getPalette(palette), 'solid').cssVars;
      for (const terminal of terminals) {
        expect(terminal.options.theme).toMatchObject({
          background: vars['--t-terminal-bg'], foreground: vars['--t-terminal-fg'],
          cursor: vars['--t-terminal-cursor'], selectionBackground: vars['--t-terminal-selection-bg'],
          red: vars['--t-terminal-ansi-red'], white: vars['--t-terminal-ansi-white'],
        });
      }
    }
    expect(terminals).toEqual(original);
    expect(terminals.map((terminal) => terminal.output)).toEqual(output);
    expect(terminals.some((terminal) => terminal.disposed)).toBe(false);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(detach).not.toHaveBeenCalled();
  });

  it('returns from All Glass to light paper with current ink and the same terminal instances', async () => {
    await act(async () => root.render(createElement(ThemeProvider, null, createElement(OpenTerminals))));
    const original = [...terminals];
    await act(async () => {
      workspace.current?.writeData(btoa('workspace scrollback and draft'));
      bottom.current?.writeData(btoa('bottom scrollback and draft'));
    });
    const output = original.map((terminal) => terminal.output);
    await act(async () => currentTheme.setWorkspaceGlass(true));
    expect(terminals).toHaveLength(2);
    for (const terminal of terminals) {
      expect(terminal.options.theme?.background).toBe('rgba(0,0,0,0)');
      expect(terminal.options.theme?.foreground).toBe(resolveTheme(getPalette('dark'), 'glass').cssVars['--t-terminal-fg']);
    }
    await act(async () => { currentTheme.setPalette('light'); currentTheme.setWorkspaceGlass(false); });
    const vars = resolveTheme(getPalette('light'), 'solid').cssVars;
    for (const terminal of terminals) expect(terminal.options.theme).toMatchObject({
      background: vars['--t-terminal-bg'], foreground: vars['--t-terminal-fg'],
    });
    expect(terminals).toEqual(original);
    expect(terminals.map((terminal) => terminal.output)).toEqual(output);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(detach).not.toHaveBeenCalled();
  });
});
