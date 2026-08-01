'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { VideoCard } from './video-card';

interface CanvasMediaLifecycle {
  createObjectURL: (blob: Blob) => string | null;
  retainObjectURL: (src: string) => boolean;
}

export function useCanvasMediaLifecycle(videoCards: VideoCard[]): CanvasMediaLifecycle {
  const videoCardsRef = useRef<VideoCard[]>([]);
  const mountedRef = useRef(true);
  const cleanupTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    videoCardsRef.current = videoCards;
  }, [videoCards]);

  useEffect(() => {
    if (cleanupTimerRef.current !== undefined) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = undefined;
    }
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Defer one task so React Strict Mode's setup-cleanup-setup probe can
      // cancel disposal. A real route unmount releases document-owned URLs.
      cleanupTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) return;
        for (const card of videoCardsRef.current) URL.revokeObjectURL(card.src);
        videoCardsRef.current = [];
        cleanupTimerRef.current = undefined;
      }, 0);
    };
  }, []);

  const createObjectURL = useCallback((blob: Blob) => (
    mountedRef.current ? URL.createObjectURL(blob) : null
  ), []);
  const retainObjectURL = useCallback((src: string) => {
    if (mountedRef.current) return true;
    URL.revokeObjectURL(src);
    return false;
  }, []);

  return useMemo(() => ({ createObjectURL, retainObjectURL }), [createObjectURL, retainObjectURL]);
}
