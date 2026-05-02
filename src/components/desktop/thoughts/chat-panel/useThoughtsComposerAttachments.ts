'use client';

import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { useFileDrop } from '@/lib/hooks/use-file-drop';

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

export function useThoughtsComposerAttachments() {
  const [attachedImages, setAttachedImages] = useState<ThoughtsAttachedImage[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const {
    pendingFiles,
    dragOver,
    processFiles,
    clearPendingFiles,
    dragHandlers,
  } = useFileDrop({ enablePaste: false });

  useEffect(() => {
    if (pendingFiles.length === 0) return;

    const frame = window.requestAnimationFrame(() => {
      for (const file of pendingFiles) {
        if (file.mimeType.startsWith('image/')) {
          setAttachedImages((current) => {
            if (current.length >= 4) return current;
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
    removeAttachedImage,
    removeAttachedFile,
    clearAttachments,
  };
}
