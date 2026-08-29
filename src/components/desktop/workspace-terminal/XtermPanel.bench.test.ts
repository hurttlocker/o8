// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { XtermPanelHandle, XtermPanelProps } from './XtermPanel';

const xtermMock = vi.hoisted(() => ({
  writes: [] as Uint8Array[],
  writeCallbacks: [] as Array<(() => void) | undefined>,
  onRenderCalls: 0,
  resets: 0,
  onData: null as ((data: string) => void) | null,
  completeWritesImmediately: true,
}));

class MockDisposable {
  dispose() {}
}

class MockAddon {
  fit() {}
}

class MockTerminal {
  cols = 120;
  rows = 30;
  options: { theme?: Record<string, string> } = {};
  unicode = { activeVersion: '' };
  buffer = {
    active: {
      length: 1,
      getLine: () => ({ translateToString: () => 'fixture terminal' }),
    },
  };

  loadAddon() {}
  open() {}
  focus() {}
  reset() { xtermMock.resets += 1; }
  dispose() {}
  getSelection() { return ''; }
  onData(callback: (data: string) => void) {
    xtermMock.onData = callback;
    return new MockDisposable();
  }
  onSelectionChange() { return new MockDisposable(); }
  onRender() {
    xtermMock.onRenderCalls += 1;
    return new MockDisposable();
  }
  write(data: Uint8Array | string, callback?: () => void) {
    if (data instanceof Uint8Array) xtermMock.writes.push(data);
    xtermMock.writeCallbacks.push(callback);
    if (xtermMock.completeWritesImmediately) callback?.();
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: MockTerminal }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: MockAddon }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: MockAddon }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: MockAddon }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: MockAddon }));
vi.mock('@xterm/addon-image', () => ({ ImageAddon: MockAddon }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ themeId: 'dark-solid' }) }));
vi.mock('@/components/desktop/workspace-terminal/constants', () => ({ buildXtermTheme: () => ({}) }));
vi.mock('@/components/desktop/workspace-terminal/xterm-selection-registry', () => ({
  recordXtermSelectionSnapshot: vi.fn(),
  registerXtermSelectionSource: () => () => {},
}));

import { XtermPanel } from './XtermPanel';

function panelProps(visible: boolean): XtermPanelProps {
  return {
    tmuxSession: 'cortex-dash-bench-fixture',
    visible,
    sendTerminalAttach: vi.fn(),
    sendTerminalInput: vi.fn(),
    sendTerminalResize: vi.fn(),
    sendTerminalDetach: vi.fn(),
  };
}

describe('XtermPanel terminal workload instrumentation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useRealTimers();
    xtermMock.writes.length = 0;
    xtermMock.writeCallbacks.length = 0;
    xtermMock.onRenderCalls = 0;
    xtermMock.resets = 0;
    xtermMock.onData = null;
    xtermMock.completeWritesImmediately = true;
    delete window.__o8TerminalDiagnostics;
    delete window.__o8TerminalBenchEnabled;
    delete window.__o8TerminalWriteStats;
    delete window.__o8TerminalDiagnostics;
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      value: class ResizeObserver {
        observe() {}
        disconnect() {}
      },
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(performance.now());
      return 1;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.getElementById('xterm-css')?.remove();
    delete window.__o8TerminalBenchEnabled;
    delete window.__o8TerminalWriteStats;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not allocate counters when the bench flag is unset', async () => {
    const panelRef = createRef<XtermPanelHandle>();
    await act(async () => {
      root.render(createElement(XtermPanel, { ...panelProps(false), ref: panelRef }));
      await Promise.resolve();
    });

    await act(async () => panelRef.current?.writeData(btoa('hidden')));

    expect(xtermMock.writes).toHaveLength(0);
    expect(window.__o8TerminalWriteStats).toBeUndefined();
  });

  it('does not install render or write-completion instrumentation when the bench flag is unset', async () => {
    const panelRef = createRef<XtermPanelHandle>();
    await act(async () => {
      root.render(createElement(XtermPanel, { ...panelProps(true), ref: panelRef }));
      await Promise.resolve();
    });

    await act(async () => panelRef.current?.writeData(btoa('plain')));

    expect(xtermMock.onRenderCalls).toBe(0);
    expect(xtermMock.writes).toHaveLength(1);
    expect(xtermMock.writeCallbacks).toEqual([undefined]);
  });

  it('resizes a visible terminal after its session name arrives', async () => {
    vi.useFakeTimers();
    const sendTerminalResize = vi.fn();
    const pendingProps = {
      ...panelProps(true),
      tmuxSession: null as unknown as string,
      sendTerminalResize,
    };
    await act(async () => {
      root.render(createElement(XtermPanel, pendingProps));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });
    sendTerminalResize.mockClear();

    await act(async () => {
      root.render(createElement(XtermPanel, {
        ...pendingProps,
        tmuxSession: 'cortex-dash-session-ready',
      }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75);
    });

    expect(sendTerminalResize).toHaveBeenCalledWith('cortex-dash-session-ready', 120, 30);
    vi.useRealTimers();
  });

  it('counts writes through the real hidden and visible writeData path', async () => {
    window.__o8TerminalBenchEnabled = true;
    const panelRef = createRef<XtermPanelHandle>();
    const hiddenProps = { ...panelProps(false), sendTerminalVisibility: vi.fn() };
    await act(async () => {
      root.render(createElement(XtermPanel, { ...hiddenProps, ref: panelRef }));
      await Promise.resolve();
    });

    await act(async () => panelRef.current?.writeData(btoa('hidden')));
    await act(async () => root.render(createElement(XtermPanel, {
      ...hiddenProps,
      visible: true,
      ref: panelRef,
    })));
    const visibleCall = hiddenProps.sendTerminalVisibility.mock.calls.findLast((call) => call[1] === true);
    await act(async () => panelRef.current?.visibilityReady?.(visibleCall?.[2]?.epoch ?? -1));
    await act(async () => panelRef.current?.writeData(btoa('shown')));

    const session = window.__o8TerminalWriteStats?.sessions['cortex-dash-bench-fixture'];
    expect(session).toMatchObject({ cols: 120, rows: 30 });
    expect(session?.hiddenWork).toMatchObject({ calls: 0, decodedBytes: 0 });
    expect(session?.visibleWork).toMatchObject({ calls: 1, decodedBytes: 5 });
    expect(xtermMock.writes).toHaveLength(2);
  });

  it('flushes hidden bytes once after the visibility acknowledgement', async () => {
    const panelRef = createRef<XtermPanelHandle>();
    const props = { ...panelProps(false), sendTerminalVisibility: vi.fn() };
    await act(async () => {
      root.render(createElement(XtermPanel, { ...props, ref: panelRef }));
      await Promise.resolve();
    });
    await act(async () => panelRef.current?.writeData(btoa('one')));
    await act(async () => panelRef.current?.writeData(btoa('two')));
    expect(xtermMock.writes).toHaveLength(0);

    await act(async () => root.render(createElement(XtermPanel, { ...props, visible: true, ref: panelRef })));
    const visibleCall = props.sendTerminalVisibility.mock.calls.findLast((call) => call[1] === true);
    await act(async () => panelRef.current?.visibilityReady?.(visibleCall?.[2]?.epoch ?? -1));

    expect(xtermMock.writes).toHaveLength(1);
    expect(new TextDecoder().decode(xtermMock.writes[0])).toBe('onetwo');
  });

  it('requests resync after hidden overflow and queues input until the snapshot paints', async () => {
    const panelRef = createRef<XtermPanelHandle>();
    const props = { ...panelProps(false), sendTerminalVisibility: vi.fn() };
    await act(async () => {
      root.render(createElement(XtermPanel, { ...props, ref: panelRef }));
      await Promise.resolve();
    });
    await act(async () => panelRef.current?.writeData(btoa('x'.repeat(256 * 1024 + 16))));
    expect(window.__o8TerminalDiagnostics?.[0]).toMatchObject({
      code: 'terminal_client_hidden_overflow',
      bytesDropped: 16,
    });

    await act(async () => root.render(createElement(XtermPanel, { ...props, visible: true, ref: panelRef })));
    const visibleCall = props.sendTerminalVisibility.mock.calls.findLast((call) => call[1] === true);
    expect(visibleCall?.[2]).toMatchObject({ needsResync: true });
    xtermMock.onData?.('queued-input');
    expect(props.sendTerminalInput).not.toHaveBeenCalled();

    xtermMock.completeWritesImmediately = false;
    await act(async () => panelRef.current?.applyResync?.(
      btoa('oracle-screen'),
      visibleCall?.[2]?.epoch ?? -1,
      false,
      'tmux',
    ));
    await act(async () => panelRef.current?.writeData(btoa('after-snapshot')));
    expect(xtermMock.resets).toBeGreaterThan(0);
    expect(new TextDecoder().decode(xtermMock.writes[0])).toBe('oracle-screen');
    expect(xtermMock.writes).toHaveLength(1);
    expect(props.sendTerminalInput).not.toHaveBeenCalled();

    await act(async () => xtermMock.writeCallbacks[0]?.());
    expect(new TextDecoder().decode(xtermMock.writes[1])).toBe('after-snapshot');
    expect(props.sendTerminalInput).not.toHaveBeenCalled();
    await act(async () => xtermMock.writeCallbacks[1]?.());
    expect(props.sendTerminalInput).toHaveBeenCalledWith('cortex-dash-bench-fixture', 'queued-input');
  });
});
