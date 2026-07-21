'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const SEND_UNDO_GRACE_MS = 4500;

export interface ComposerSendImage {
  name: string;
  dataUri: string;
}

export interface QueuedComposerSend {
  id: number;
  text: string;
  images: ComposerSendImage[];
}

export interface ComposerSendBufferConfig<DispatchHandle> {
  busy: boolean;
  graceMs?: number;
  dispatch: (text: string, images: ComposerSendImage[]) => DispatchHandle | null;
  interrupt: () => void;
  restore: (text: string, images: ComposerSendImage[]) => void;
  truncate: (handle: DispatchHandle) => void;
}

export interface ComposerSendBuffer {
  send: (text: string, images?: ComposerSendImage[]) => boolean;
  stopOrUndo: () => void;
  undoArmed: boolean;
  undoSequence: number;
  queued: QueuedComposerSend[];
  cancelQueued: (id: number) => void;
  clear: () => void;
}

/**
 * Conversation-agnostic send buffering shared by the canvas and desktop
 * composers. Hosts own dispatch, interruption, transcript rewind, and draft
 * restoration because those seams differ between transcript stores.
 */
export function useComposerSendBuffer<DispatchHandle>(
  config: ComposerSendBufferConfig<DispatchHandle>,
): ComposerSendBuffer {
  const configRef = useRef(config);
  const graceMs = config.graceMs ?? SEND_UNDO_GRACE_MS;

  const [queued, setQueued] = useState<QueuedComposerSend[]>([]);
  const queuedRef = useRef(queued);
  const nextQueueIdRef = useRef(1);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    queuedRef.current = queued;
  }, [queued]);

  const [undoArmed, setUndoArmed] = useState(false);
  const [undoSequence, setUndoSequence] = useState(0);
  const undoRef = useRef<{
    text: string;
    images: ComposerSendImage[];
    handle: DispatchHandle;
  } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousBusyRef = useRef(config.busy);

  const disarm = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    undoRef.current = null;
    setUndoArmed(false);
  }, []);

  const arm = useCallback((handle: DispatchHandle, text: string, images: ComposerSendImage[]) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    undoRef.current = { text, images, handle };
    setUndoArmed(true);
    setUndoSequence((current) => current + 1);
    undoTimerRef.current = setTimeout(() => {
      undoTimerRef.current = null;
      undoRef.current = null;
      setUndoArmed(false);
    }, graceMs);
  }, [graceMs]);

  const send = useCallback((text: string, images: ComposerSendImage[] = []) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (configRef.current.busy) {
      const id = nextQueueIdRef.current;
      nextQueueIdRef.current += 1;
      setQueued((previous) => [...previous, { id, text: trimmed, images }]);
      return true;
    }

    const handle = configRef.current.dispatch(trimmed, images);
    if (!handle) return false;
    arm(handle, trimmed, images);
    return true;
  }, [arm]);

  const stopOrUndo = useCallback(() => {
    configRef.current.interrupt();
    const pendingUndo = undoRef.current;
    if (!pendingUndo) return;
    disarm();
    configRef.current.truncate(pendingUndo.handle);
    configRef.current.restore(pendingUndo.text, pendingUndo.images);
  }, [disarm]);

  const cancelQueued = useCallback((id: number) => {
    setQueued((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(() => {
    disarm();
    setQueued([]);
  }, [disarm]);

  useEffect(() => {
    const wasBusy = previousBusyRef.current;
    previousBusyRef.current = config.busy;
    if (!wasBusy || config.busy) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || configRef.current.busy) return;
      disarm();
      const queue = queuedRef.current;
      if (queue.length === 0) return;
      const [head, ...rest] = queue;
      setQueued(rest);
      const handle = configRef.current.dispatch(head.text, head.images);
      if (handle) {
        arm(handle, head.text, head.images);
        return;
      }

      // A queue drain must never silently lose operator intent. If dispatch is
      // unavailable on the idle edge, put the full draft back in the composer.
      configRef.current.restore(head.text, head.images);
    });
    return () => { cancelled = true; };
  }, [arm, config.busy, disarm]);

  useEffect(() => () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
  }, []);

  return { send, stopOrUndo, undoArmed, undoSequence, queued, cancelQueued, clear };
}
