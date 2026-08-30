'use client';

import { useCallback, useEffect, useRef } from 'react';
import { Fragment } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { useTauriFileDrop } from '@/lib/hooks/use-tauri-file-drop';
import { richMarkdownSchema } from '@/lib/markdown/editor';
import {
  createImageFileUploads,
  createImagePathUploads,
  imageFilesFromClipboard,
  imageFilesFromList,
  type MarkdownImageAttributes,
  type PendingMarkdownImageUpload,
} from '../markdown-image-upload';

interface RichMarkdownImageInputOptions {
  hostRef: React.RefObject<HTMLElement | null>;
  viewRef: React.RefObject<EditorView | null>;
  repoPath: string | null;
}

function imageNode(image: MarkdownImageAttributes) {
  return richMarkdownSchema.nodes.image.create(image);
}

function imagePosition(view: EditorView, preferredPosition?: number): number {
  const fallback = view.state.selection.head;
  const candidate = Math.max(0, Math.min(preferredPosition ?? fallback, view.state.doc.content.size));
  return view.state.doc.resolve(candidate).parent.inlineContent ? candidate : fallback;
}

function placeholderPosition(view: EditorView, src: string): number | null {
  let match: number | null = null;
  view.state.doc.descendants((node, position) => {
    if (node.type === richMarkdownSchema.nodes.image && node.attrs.src === src) {
      match = position;
      return false;
    }
    return match === null;
  });
  return match;
}

function replacePlaceholder(
  view: EditorView,
  placeholderSrc: string,
  replacement: MarkdownImageAttributes | null,
): void {
  if (view.isDestroyed) return;
  const position = placeholderPosition(view, placeholderSrc);
  if (position === null) return;
  if (replacement) {
    view.dispatch(view.state.tr.setNodeMarkup(position, undefined, replacement));
    return;
  }
  const node = view.state.doc.nodeAt(position);
  if (!node) return;
  let to = position + node.nodeSize;
  if (view.state.doc.textBetween(to, to + 1) === '\n') to += 1;
  view.dispatch(view.state.tr.delete(position, to));
}

function insertUploads(
  view: EditorView,
  uploads: PendingMarkdownImageUpload[],
  preferredPosition?: number,
): boolean {
  if (uploads.length === 0) return false;
  const position = imagePosition(view, preferredPosition);
  const resolved = view.state.doc.resolve(position);
  const parentOffset = resolved.parentOffset;
  const before = parentOffset === 0
    ? '\n'
    : resolved.parent.textBetween(parentOffset - 1, parentOffset);
  const after = parentOffset === resolved.parent.content.size
    ? '\n'
    : resolved.parent.textBetween(parentOffset, parentOffset + 1);
  const nodes = [];
  if (before !== '\n') nodes.push(richMarkdownSchema.text('\n'));
  uploads.forEach((upload, index) => {
    if (index > 0) nodes.push(richMarkdownSchema.text('\n'));
    nodes.push(imageNode(upload.placeholder));
  });
  if (after !== '\n') nodes.push(richMarkdownSchema.text('\n'));
  view.dispatch(view.state.tr.insert(position, Fragment.fromArray(nodes)).scrollIntoView());

  uploads.forEach((upload) => {
    void upload.result.then(
      (image) => replacePlaceholder(view, upload.placeholder.src, image),
      (error: unknown) => {
        console.warn('[markdown-image] upload failed', error);
        replacePlaceholder(view, upload.placeholder.src, null);
      },
    );
  });
  return true;
}

export function useRichMarkdownImageInput({
  hostRef,
  viewRef,
  repoPath,
}: RichMarkdownImageInputOptions) {
  const repoPathRef = useRef(repoPath);
  useEffect(() => {
    repoPathRef.current = repoPath;
  }, [repoPath]);

  useTauriFileDrop({
    hostRef,
    disabled: !repoPath,
    onDrop: (paths, coordinates) => {
      const currentRepoPath = repoPathRef.current;
      const view = viewRef.current;
      if (!currentRepoPath || !view) return;
      const position = view.posAtCoords({
        left: coordinates.x,
        top: coordinates.y,
      })?.pos;
      insertUploads(view, createImagePathUploads(currentRepoPath, paths), position);
    },
  });

  const handlePaste = useCallback((view: EditorView, event: ClipboardEvent): boolean => {
    const currentRepoPath = repoPathRef.current;
    if (!currentRepoPath) return false;
    const files = imageFilesFromClipboard(event.clipboardData);
    if (files.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    return insertUploads(view, createImageFileUploads(currentRepoPath, files));
  }, []);

  const handleDrop = useCallback((view: EditorView, event: DragEvent): boolean => {
    const currentRepoPath = repoPathRef.current;
    if (!currentRepoPath) return false;
    const files = imageFilesFromList(event.dataTransfer?.files);
    if (files.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
    return insertUploads(view, createImageFileUploads(currentRepoPath, files), position);
  }, []);

  const handleDragOver = useCallback((_view: EditorView, event: DragEvent): boolean => {
    if (
      repoPathRef.current
      && Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === 'file')
    ) {
      event.preventDefault();
    }
    return false;
  }, []);

  return { handlePaste, handleDrop, handleDragOver };
}
