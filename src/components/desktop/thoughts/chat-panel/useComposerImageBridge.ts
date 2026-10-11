'use client';

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { observeImageAttachments, registerImageComposer, type ImageComposerSnapshot } from '@/lib/composer/image-attachment-bridge';
import type { FileUploadHandler } from '@/lib/hooks/use-file-drop';
import type { ThoughtsAttachedImage } from './useThoughtsComposerAttachments';

export function useComposerImageBridge(
  host: RefObject<HTMLElement | null>, active: boolean, disabled: boolean,
  context: string, images: readonly ThoughtsAttachedImage[], upload?: FileUploadHandler,
) {
  const latest = useRef<ImageComposerSnapshot>({ element: null, images: [], upload });
  useLayoutEffect(() => {
    latest.current = { element: host.current, images, upload };
    observeImageAttachments();
  }, [host, images, upload]);
  useLayoutEffect(() => {
    if (!active || disabled || !upload) return;
    return registerImageComposer(() => latest.current);
  }, [active, disabled, context, upload]);
}
