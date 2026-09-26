// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useMicrophoneCheck } from './useMicrophoneCheck';
let root: Root;
let value: ReturnType<typeof useMicrophoneCheck>;
const stop = vi.fn(); const close = vi.fn(async () => {});
let sample = 128;
function Harness() { const next = useMicrophoneCheck(); useEffect(() => { value = next; }); return createElement('div'); }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sample = 128; vi.useFakeTimers();
  vi.stubGlobal('AudioContext', class {
    resume = async () => {};
    close = close;
    createAnalyser = () => ({ fftSize: 512, getByteTimeDomainData: (data: Uint8Array) => data.fill(sample) });
    createMediaStreamSource = () => ({ connect: () => {} });
  });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop }] })) } });
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(createElement(Harness)));
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('checks real samples, distinguishes silence, and releases the microphone when finished', async () => {
  await act(async () => value.start());
  expect(value.state).toBe('listening');
  await act(async () => vi.advanceTimersByTime(8000));
  expect(value.state).toBe('silent'); expect(stop).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
  sample = 145;
  await act(async () => value.start());
  await act(async () => vi.advanceTimersByTime(8000));
  expect(value.state).toBe('heard');
});
it('shows denied access and cleans up a stream arriving after the user stops', async () => {
  vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'));
  await act(async () => value.start());
  expect(value.state).toBe('error'); expect(value.error).toContain('not granted');
  let deliver!: (stream: MediaStream) => void;
  vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = value.start(); });
  act(() => value.stop());
  await act(async () => { deliver({ getTracks: () => [{ stop }] } as unknown as MediaStream); await pending; });
  expect(value.state).toBe('idle'); expect(stop).toHaveBeenCalled();
});
it('uses elapsed time when sampling is throttled and stops capture when the app loses focus', async () => {
  await act(async () => value.start());
  vi.setSystemTime(Date.now() + 9000);
  await act(async () => vi.advanceTimersByTime(100));
  expect(value.state).toBe('silent'); expect(stop).toHaveBeenCalled();
  stop.mockClear();
  await act(async () => value.start());
  act(() => window.dispatchEvent(new Event('blur')));
  expect(value.state).toBe('interrupted'); expect(stop).toHaveBeenCalledOnce();
});
