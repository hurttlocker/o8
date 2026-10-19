'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import { composerBackendSupportsImages, validateComposerImageAttachments } from '@/lib/mobile/composer-image-validation';
import {
  useComposerSendBuffer,
  type ComposerSendBuffer,
  type ComposerSendImage,
} from '@/lib/hooks/use-composer-send-buffer';
import type { OrchestratorSendHandle } from '../useOrchestratorStream';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import { COMPOSER_STEER_UNAVAILABLE_REASON } from '@/lib/orchestrator/composer-queue-types';
import { useDurableComposerQueue } from './useDurableComposerQueue';

interface UseDefaultComposerSendBufferOptions {
  active: boolean;
  backend: string;
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
  captureQueuedSend: (text: string, images: ComposerSendImage[]) => ComposerQueuePayload;
  interrupt: () => void;
  undoSend: (handle: OrchestratorSendHandle) => void;
  shouldBypass: (text: string) => boolean;
  sendUnbuffered: (text: string) => void;
}

export function useDefaultComposerSendBuffer({
  active,
  backend,
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
  captureQueuedSend,
  interrupt,
  undoSend,
  shouldBypass,
  sendUnbuffered,
}: UseDefaultComposerSendBufferOptions): {
  durable: ReturnType<typeof useDurableComposerQueue>;
  sendBuffer: ComposerSendBuffer;
  handleSend: () => void;
  attachmentError: string | null;
  saving: boolean;
  handleSteer: () => void;
} {
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const latestScopeRef = useRef({ threadId, repoPath }); latestScopeRef.current = { threadId, repoPath };
  const imagesRef = useRef(attachedImages); imagesRef.current = attachedImages;
  const durable = useDurableComposerQueue(active && threadId && repoPath ? { repoPath, threadId } : null, busy);
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
    if (repoChanged || switchedExistingThread) { clearSendBuffer(); setAttachmentError(null); }
    scopeRef.current = { threadId, repoPath };
  }, [clearSendBuffer, repoPath, threadId]);

  const handleSend = useCallback(() => {
    if (savingRef.current) return;
    const draft = latestInputRef.current;
    const text = latestInputRef.current.trim() || (attachedImages.length > 0 ? '[Image attached]' : '');
    if (!text) return;
    const images = attachedImages.map((image) => ({ name: image.name, dataUri: image.dataUri }));
    if (images.length > 0) {
      try {
        validateComposerImageAttachments(images);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : 'Invalid image attachment.');
        return;
      }
      if (!active || shouldBypass(text) || !composerBackendSupportsImages(backend)) {
        setAttachmentError('This chat mode cannot receive images. Select a Codex or Claude agent, then send again.');
        return;
      }
    }
    setAttachmentError(null);
    if (!active || shouldBypass(text)) {
      sendUnbuffered(text);
      return;
    }

    if (!durable.ready) { setAttachmentError('Wait for queued messages to load before sending.'); return; }
    if (busy || durable.items.length > 0) {
      const scope = { threadId, repoPath };
      const attachmentSnapshot = JSON.stringify(images);
      savingRef.current = true;
      setSaving(true);
      void (async () => {
        try {
          await durable.enqueue(captureQueuedSend(text, images));
          const sameScope = latestScopeRef.current.threadId === scope.threadId && latestScopeRef.current.repoPath === scope.repoPath;
          if (sameScope && latestInputRef.current === draft && JSON.stringify(imagesRef.current.map(image => ({ name: image.name, dataUri: image.dataUri }))) === attachmentSnapshot) {
            setInput(''); latestInputRef.current = ''; clearAttachments();
          }
        } catch (error) {
          if (latestScopeRef.current.threadId === scope.threadId && latestScopeRef.current.repoPath === scope.repoPath) setAttachmentError(error instanceof Error ? error.message : 'Unable to save the queued message.');
        } finally { savingRef.current = false; setSaving(false); }
      })();
      return;
    }

    if (!sendBuffer.send(text, images)) return;
    setInput('');
    latestInputRef.current = '';
    clearAttachments();
  }, [active, attachedImages, backend, busy, captureQueuedSend, clearAttachments, durable, latestInputRef, repoPath, sendBuffer, sendUnbuffered, setInput, shouldBypass, threadId]);

  const handleSteer = useCallback(() => { setAttachmentError(COMPOSER_STEER_UNAVAILABLE_REASON); }, []);
  const queued = durable.items.map(item => ({
    id: item.sequence, text: item.payload.text, images: item.payload.images,
    status: item.status, reason: item.reason,
    cancellable: !durable.removing.has(item.sequence) && (item.status !== 'dispatching' || item.admittedAt === null),
  }));
  return {
    durable,
    sendBuffer: { ...sendBuffer, queued, cancelQueued: id => { void durable.cancel(id); } },
    handleSend, handleSteer, saving, attachmentError: attachmentError ?? durable.error,
  };
}
