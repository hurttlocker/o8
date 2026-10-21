// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), setRect: vi.fn() }));
vi.mock('@/lib/tauri/remote-preview', () => ({ remotePreviewOpen: native.open, remotePreviewClose: native.close, remotePreviewSetRect: native.setRect }));
import { NativeRemotePreview } from './NativeRemotePreview';

let root: Root;
let container: HTMLDivElement;
let finishOpen: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 10, y: 10, left: 10, top: 10, right: 510, bottom: 310, width: 500, height: 300, toJSON: () => ({}) });
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('[aria-label="Remote task preview"]') });
  native.open.mockImplementation(() => new Promise<void>((resolve) => { finishOpen = resolve; }));
  native.close.mockResolvedValue(undefined);
  native.setRect.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native remote preview ownership', () => {
  it('opens one bootstrap and does not close it during Strict Mode effect replay', async () => {
    await act(async () => root.render(createElement(StrictMode, null, createElement(NativeRemotePreview, { id: 'a'.repeat(48), url: 'http://[::1]:54321/', onError: vi.fn() }))));
    expect(native.open).toHaveBeenCalledTimes(1);
    expect(native.close).not.toHaveBeenCalled();
    await act(async () => { finishOpen?.(); });
    expect(native.close).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(native.close).toHaveBeenCalledExactlyOnceWith('a'.repeat(48));
  });

  it('closes an in-flight native open after the actual view unmounts', async () => {
    await act(async () => root.render(createElement(NativeRemotePreview, { id: 'b'.repeat(48), url: 'http://[::1]:54321/', onError: vi.fn() })));
    expect(native.open).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    await act(async () => { finishOpen?.(); });
    expect(native.close).toHaveBeenCalledExactlyOnceWith('b'.repeat(48));
  });
});
