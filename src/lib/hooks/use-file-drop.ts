'use client';

import { useCallback, useEffect, useState } from 'react';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export interface DroppedFile {
  name: string;
  mimeType: string;
  content: string; // base64
  preview?: string; // ObjectURL for images
}

export interface UseFileDropOptions {
  /** Maximum number of files allowed at once */
  maxFiles?: number;
  /** Listen for window-level paste events */
  enablePaste?: boolean;
}

export interface UseFileDropResult {
  pendingFiles: DroppedFile[];
  setPendingFiles: React.Dispatch<React.SetStateAction<DroppedFile[]>>;
  dragOver: boolean;
  processFiles: (files: FileList | File[]) => void;
  removePendingFile: (index: number) => void;
  clearPendingFiles: () => void;
  dragHandlers: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
}

export function useFileDrop(options?: UseFileDropOptions): UseFileDropResult {
  const maxFiles = options?.maxFiles ?? 10;
  const enablePaste = options?.enablePaste ?? true;

  const [pendingFiles, setPendingFiles] = useState<DroppedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const processFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        console.warn(`[file-drop] Skipping ${file.name}: exceeds 5 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        setPendingFiles((prev) => {
          if (prev.length >= maxFiles) return prev;
          return [...prev, { name: file.name, mimeType: file.type || 'application/octet-stream', content: base64, preview }];
        });
      };
      reader.readAsDataURL(file);
    });
  }, [maxFiles]);

  const removePendingFile = useCallback((index: number) => {
    setPendingFiles((prev) => {
      const f = prev[index];
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const clearPendingFiles = useCallback(() => {
    setPendingFiles((prev) => {
      prev.forEach((f) => { if (f.preview) URL.revokeObjectURL(f.preview); });
      return [];
    });
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  useEffect(() => {
    if (!enablePaste) return undefined;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file') {
          const file = items[i].getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) processFiles(files);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enablePaste, processFiles]);

  return {
    pendingFiles,
    setPendingFiles,
    dragOver,
    processFiles,
    removePendingFile,
    clearPendingFiles,
    dragHandlers: { onDragOver, onDragLeave, onDrop },
  };
}
