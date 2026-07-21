/** @vitest-environment jsdom */

import { act, createElement, createRef, forwardRef, useImperativeHandle, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SEND_UNDO_GRACE_MS,
  useComposerSendBuffer,
  type ComposerSendBuffer,
  type ComposerSendBufferConfig,
} from './use-composer-send-buffer';

type Handle = { boundary: number };

type HarnessProps = ComposerSendBufferConfig<Handle>;

let bufferRef: RefObject<ComposerSendBuffer | null>;
let root: Root;

const Harness = forwardRef<ComposerSendBuffer, HarnessProps>(function Harness(props, ref) {
  const buffer = useComposerSendBuffer(props);
  useImperativeHandle(ref, () => buffer, [buffer]);
  return null;
});

function currentBuffer(): ComposerSendBuffer {
  if (!bufferRef.current) throw new Error('send buffer harness is not mounted');
  return bufferRef.current;
}

describe('useComposerSendBuffer', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    bufferRef = createRef<ComposerSendBuffer>();
    root = createRoot(document.createElement('div'));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it('undoes an in-flight send by interrupting, truncating, and restoring text plus images', () => {
    const image = { name: 'proof.png', dataUri: 'data:image/png;base64,abc' };
    const handle = { boundary: 7 };
    const dispatch = vi.fn(() => handle);
    const interrupt = vi.fn();
    const restore = vi.fn();
    const truncate = vi.fn();
    act(() => root.render(createElement(Harness, {
      busy: false,
      dispatch,
      interrupt,
      restore,
      truncate,
      ref: bufferRef,
    })));

    act(() => {
      expect(currentBuffer().send('  fix it  ', [image])).toBe(true);
    });
    expect(currentBuffer().undoArmed).toBe(true);

    act(() => currentBuffer().stopOrUndo());
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(truncate).toHaveBeenCalledWith(handle);
    expect(restore).toHaveBeenCalledWith('fix it', [image]);
    expect(currentBuffer().undoArmed).toBe(false);
  });

  it('turns Stop into a plain interrupt after the grace window expires', () => {
    vi.useFakeTimers();
    const interrupt = vi.fn();
    const restore = vi.fn();
    const truncate = vi.fn();
    act(() => root.render(createElement(Harness, {
      busy: false,
      dispatch: () => ({ boundary: 1 }),
      interrupt,
      restore,
      truncate,
      ref: bufferRef,
    })));
    act(() => { currentBuffer().send('keep this send'); });
    act(() => vi.advanceTimersByTime(SEND_UNDO_GRACE_MS));

    act(() => currentBuffer().stopOrUndo());
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(truncate).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('queues while busy and drains exactly one item on each busy-to-idle edge', async () => {
    let boundary = 0;
    const dispatch = vi.fn(() => ({ boundary: boundary += 1 }));
    const config = {
      dispatch,
      interrupt: vi.fn(),
      restore: vi.fn(),
      truncate: vi.fn(),
    };
    act(() => root.render(createElement(Harness, { busy: true, ...config, ref: bufferRef })));

    act(() => {
      currentBuffer().send('first', [{ name: 'one.png', dataUri: 'data:image/png;base64,one' }]);
      currentBuffer().send('second');
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(currentBuffer().queued.map((item) => item.text)).toEqual(['first', 'second']);

    await act(async () => root.render(createElement(Harness, { busy: false, ...config, ref: bufferRef })));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenLastCalledWith('first', [{ name: 'one.png', dataUri: 'data:image/png;base64,one' }]);
    expect(currentBuffer().queued.map((item) => item.text)).toEqual(['second']);

    act(() => root.render(createElement(Harness, { busy: false, ...config, ref: bufferRef })));
    expect(dispatch).toHaveBeenCalledTimes(1);

    act(() => root.render(createElement(Harness, { busy: true, ...config, ref: bufferRef })));
    await act(async () => root.render(createElement(Harness, { busy: false, ...config, ref: bufferRef })));
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenLastCalledWith('second', []);
    expect(currentBuffer().queued).toEqual([]);
  });
});
