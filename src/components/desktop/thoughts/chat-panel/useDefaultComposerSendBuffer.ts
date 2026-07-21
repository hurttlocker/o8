'use client';

import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import {
  useComposerSendBuffer,
  type ComposerSendBuffer,
  type ComposerSendImage,
} from '@/lib/hooks/use-composer-send-buffer';
import type { OrchestratorSendHandle } from '../useOrchestratorStream';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';

interface UseDefaultComposerSendBufferOptions {
  active: boolean;
  busy: boolean;
  threadId: string | null;
  repoPath: string | null;
  attachedImages: ThoughtsAttachedImage[];
  latestInputRef: MutableRefObject<string>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setInput: (text: string) => void;
  addAttachedImage: (image: ThoughtsAttachedImage) => void;
  clearAttachments: () => void;
  dispatch: (text: string, images: ComposerSendImage[]) => OrchestratorSendHandle | null;
  interrupt: () => void;
  undoSend: (handle: OrchestratorSendHandle) => void;
  shouldBypass: (text: string) => boolean;
  sendUnbuffered: (text: string) => void;
}

export function useDefaultComposerSendBuffer({
  active,
  busy,
  threadId,
  repoPath,
  attachedImages,
  latestInputRef,
  inputRef,
  setInput,
  addAttachedImage,
  clearAttachments,
  dispatch,
  interrupt,
  undoSend,
  shouldBypass,
  sendUnbuffered,
}: UseDefaultComposerSendBufferOptions): {
  sendBuffer: ComposerSendBuffer;
  handleSend: () => void;
} {
  const restoreDraft = useCallback((text: string, images: ComposerSendImage[]) => {
    setInput(text);
    latestInputRef.current = text;
    clearAttachments();
    for (const image of images) {
      const mimeType = image.dataUri.match(/^data:([^;]+);/)?.[1] ?? 'image/png';
      addAttachedImage({ ...image, mimeType });
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [addAttachedImage, clearAttachments, inputRef, latestInputRef, setInput]);

  const sendBuffer = useComposerSendBuffer<OrchestratorSendHandle>({
    busy: active && busy,
    dispatch,
    interrupt,
    restore: restoreDraft,
    truncate: undoSend,
  });
  const clearSendBuffer = sendBuffer.clear;
  const scopeRef = useRef({ threadId, repoPath });
  useEffect(() => {
    const previous = scopeRef.current;
    const repoChanged = previous.repoPath !== repoPath;
    const switchedExistingThread = previous.threadId !== null && previous.threadId !== threadId;
    if (repoChanged || switchedExistingThread) clearSendBuffer();
    scopeRef.current = { threadId, repoPath };
  }, [clearSendBuffer, repoPath, threadId]);

  const handleSend = useCallback(() => {
    const text = latestInputRef.current.trim();
    if (!text) return;
    if (!active || shouldBypass(text)) {
      sendUnbuffered(text);
      return;
    }

    const images = attachedImages.map((image) => ({ name: image.name, dataUri: image.dataUri }));
    if (!sendBuffer.send(text, images)) return;
    setInput('');
    latestInputRef.current = '';
    clearAttachments();
  }, [active, attachedImages, clearAttachments, latestInputRef, sendBuffer, sendUnbuffered, setInput, shouldBypass]);

  return { sendBuffer, handleSend };
}
