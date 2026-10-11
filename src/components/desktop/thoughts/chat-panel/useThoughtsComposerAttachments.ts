'use client';

import { useCallback, useEffect, useState, type DragEvent, type RefObject } from 'react';
import { useFileDrop, MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

export interface ThoughtsAttachedImage {
  name: string;
  dataUri: string;
  mimeType: string;
  /** Transient upload acknowledgment; omitted from normal send payloads. */
  uploadRequestId?: string;
}

export interface ThoughtsComposerDragHandlers {
  onDragOver: (event: DragEvent) => void;
  onDragLeave: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

export interface UseThoughtsComposerAttachmentsOptions {
  /** Optional ref to hit-test Tauri drag-drop events against (see #1136). */
  hostRef?: RefObject<HTMLElement | null>;
}

export function useThoughtsComposerAttachments(options?: UseThoughtsComposerAttachmentsOptions) {
  const [attachedImages, setAttachedImages] = useState<ThoughtsAttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const {
    pendingFiles,
    setPendingFiles,
    dragOver,
    processFiles,
    clearPendingFiles,
    dragHandlers,
  } = useFileDrop({ enablePaste: false, hostRef: options?.hostRef });

  useEffect(() => {
    if (pendingFiles.length === 0) return;

    const promote = (files: typeof pendingFiles) => {
      for (const file of files) {
        if (file.isCurrent && !file.isCurrent()) continue;
        if (file.mimeType.startsWith('image/')) {
          setAttachedImages((current) => {
            if ((file.isCurrent && !file.isCurrent()) || current.length >= MAX_COMPOSER_IMAGES || (file.uploadRequestId && current.some(image => image.uploadRequestId === file.uploadRequestId))) return current;
            return [
              ...current,
              {
                name: file.name,
                dataUri: `data:${file.mimeType};base64,${file.content}`,
                mimeType: file.mimeType,
                ...(file.uploadRequestId ? { uploadRequestId: file.uploadRequestId } : {}),
              },
            ];
          });
        } else {
          setAttachedFiles((current) => (
            current.includes(file.name) ? current : [...current, file.name]
          ));
        }
      }
      // Consume only this snapshot, preserving manual/newly queued files.
      setPendingFiles(current => {
        const remaining = current.filter(file => !files.includes(file));
        if (remaining.length === current.length) return current;
        for (const file of current) {
          if (files.includes(file) && file.preview?.startsWith('blob:')) URL.revokeObjectURL(file.preview);
        }
        return remaining;
      });
    };
    const background = pendingFiles.filter(file => file.backgroundAgent === true && file.isCurrent && file.uploadRequestId);
    if (background.length > 0) promote(background);
    const paced = pendingFiles.filter(file => !background.includes(file));
    if (paced.length === 0) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => { if (!cancelled) promote(paced); });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, [pendingFiles, setPendingFiles]);

  const removeAttachedImage = useCallback((index: number) => {
    setAttachedImages((current) => current.filter((_, imageIndex) => imageIndex !== index));
  }, []);

  // Swap one attachment in place (e.g. after screenshot annotation) — keeps the
  // array position so the thumbnail updates without a remount, and the send path
  // (which reads live state) picks up the annotated dataUri on the next send.
  const replaceAttachedImage = useCallback((index: number, image: ThoughtsAttachedImage) => {
    setAttachedImages((current) => current.map((im, i) => (i === index ? image : im)));
  }, []);

  // Programmatic add (e.g. "Add to chat" from an o8.md inline image). Respects
  // the same image cap as the drop/paste bridge above.
  const addAttachedImage = useCallback((image: ThoughtsAttachedImage) => {
    setAttachedImages((current) => (current.length >= MAX_COMPOSER_IMAGES ? current : [...current, image]));
  }, []);

  const removeAttachedFile = useCallback((fileName: string) => {
    setAttachedFiles((current) => current.filter((name) => name !== fileName));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachedImages([]);
    setAttachedFiles([]);
    clearPendingFiles();
  }, [clearPendingFiles]);

  return {
    attachedImages,
    attachedFiles,
    dragOver,
    dragHandlers,
    processFiles,
    addAttachedImage,
    removeAttachedImage,
    replaceAttachedImage,
    removeAttachedFile,
    clearAttachments,
  };
}
