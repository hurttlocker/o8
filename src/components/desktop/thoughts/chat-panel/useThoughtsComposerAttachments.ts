'use client';

import { useCallback, useEffect, useState, type DragEvent, type RefObject } from 'react';
import { useFileDrop, MAX_COMPOSER_IMAGES } from '@/lib/hooks/use-file-drop';

export interface ThoughtsAttachedImage {
  name: string;
  dataUri: string;
  mimeType: string;
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
    dragOver,
    processFiles,
    clearPendingFiles,
    dragHandlers,
  } = useFileDrop({ enablePaste: false, hostRef: options?.hostRef });

  useEffect(() => {
    if (pendingFiles.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      for (const file of pendingFiles) {
        if (file.mimeType.startsWith('image/')) {
          setAttachedImages((current) => {
            if (current.length >= MAX_COMPOSER_IMAGES) return current;
            return [
              ...current,
              {
                name: file.name,
                dataUri: `data:${file.mimeType};base64,${file.content}`,
                mimeType: file.mimeType,
              },
            ];
          });
        } else {
          setAttachedFiles((current) => (
            current.includes(file.name) ? current : [...current, file.name]
          ));
        }
      }
      clearPendingFiles();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [clearPendingFiles, pendingFiles]);

  const removeAttachedImage = useCallback((index: number) => {
    setAttachedImages((current) => current.filter((_, imageIndex) => imageIndex !== index));
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
    removeAttachedFile,
    clearAttachments,
  };
}
