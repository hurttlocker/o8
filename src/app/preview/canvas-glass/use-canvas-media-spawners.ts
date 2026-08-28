'use client';

/* eslint-disable react-hooks/exhaustive-deps -- Extracted callbacks keep the page's dependency arrays; refs and state setters remain stable inputs. */

import { useCallback, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import { deleteMedia, putMedia } from './canvas-media-store';
import type { ImageCard } from './image-card';
import { IMG_MAX_SPAWN_EDGE, canvasZoom } from './ui';
import type { VideoCard } from './video-card';

interface MutableRef<T> {
  current: T;
}

type StateSetter<T> = Dispatch<SetStateAction<T>>;

interface UseCanvasMediaSpawnersDeps {
  nextIdRef: MutableRef<number>;
  zPeakRef: MutableRef<number>;
  imageCardsRef: MutableRef<ImageCard[]>;
  canvasMedia: {
    retainObjectURL: (src: string) => boolean;
  };
  setImageCards: StateSetter<ImageCard[]>;
  setVideoCards: StateSetter<VideoCard[]>;
  setDropTargetId: StateSetter<number | null>;
}

export function useCanvasMediaSpawners({
  nextIdRef,
  zPeakRef,
  imageCardsRef,
  canvasMedia,
  setImageCards,
  setVideoCards,
  setDropTargetId,
}: UseCanvasMediaSpawnersDeps) {
  /** Drop a photo anywhere — it surfaces reference-style: filename pill,
   *  bottom edge dissolving into the canvas, aspect-locked resize.
   *  dataURI, not an object URL — the persistence snapshot stores items
   *  verbatim, and a blob: src is dead on the next reload. */
  const spawnImageCard = useCallback((file: File, at: { x: number; y: number }) => {
    const reader = new FileReader();
    reader.onload = () => {
      const src = typeof reader.result === 'string' ? reader.result : null;
      if (!src) return;
      const probe = new Image();
      probe.onload = () => {
        const natW = probe.naturalWidth || 1;
        const natH = probe.naturalHeight || 1;
        const aspect = natW / natH;
        const w = natW >= natH ? IMG_MAX_SPAWN_EDGE : Math.round(IMG_MAX_SPAWN_EDGE * aspect);
        const h = Math.round(w / aspect);
        const id = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        const z = zPeakRef.current;
        setImageCards((previous) => [...previous, {
          id,
          x: Math.max(8, at.x - w / 2),
          y: Math.max(48, at.y - h / 2),
          z,
          w,
          h,
          aspect,
          items: [{ src, name: file.name }],
        }]);
      };
      probe.src = src;
    };
    reader.readAsDataURL(file);
  }, []);

  const moveImageCard = useCallback((id: number, x: number, y: number) => {
    setImageCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
    // Live hit-test while dragging: highlight the photo we'd stack onto (the
    // topmost OTHER card whose bounds contain the dragged card's center).
    const cards = imageCardsRef.current;
    const dragged = cards.find((c) => c.id === id);
    if (!dragged) return;
    const cx = x + dragged.w / 2;
    const cy = y + dragged.h / 2;
    let tgt: number | null = null;
    for (const c of cards) {
      if (c.id === id) continue;
      if (cx >= c.x && cx <= c.x + c.w && cy >= c.y && cy <= c.y + c.h) tgt = c.id;
    }
    setDropTargetId(tgt);
  }, []);

  const resizeImageCard = useCallback((id: number, w: number, h: number) => {
    setImageCards((previous) => previous.map((card) => (
      card.id === id ? { ...card, w, h } : card
    )));
  }, []);

  const closeImageCard = useCallback((id: number) => {
    setImageCards((previous) => {
      const target = previous.find((card) => card.id === id);
      target?.items.forEach((item) => URL.revokeObjectURL(item.src));
      return previous.filter((card) => card.id !== id);
    });
  }, []);

  /** Dropped onto another photo → the two collapse into a stack (deck). */
  const dropImageCard = useCallback((id: number) => {
    setDropTargetId(null);
    setImageCards((previous) => {
      const dragged = previous.find((card) => card.id === id);
      if (!dragged) return previous;
      // Hit-test in CANVAS coords from the dragged card's own geometry — the
      // SAME basis moveImageCard's live highlight uses. The drop once trusted
      // the pointer's SCREEN clientX/Y, which only matched canvas space at
      // zoom=1 / no pan and silently mis-targeted (or missed) the stack under
      // zoom or pan (#agent-surface-ergonomics coord smell).
      const centerX = dragged.x + dragged.w / 2;
      const centerY = dragged.y + dragged.h / 2;
      const target = previous.find((card) => (
        card.id !== id
        && centerX >= card.x && centerX <= card.x + card.w
        && centerY >= card.y && centerY <= card.y + card.h
      ));
      if (!target) return previous;
      return previous
        .filter((card) => card.id !== id)
        .map((card) => (card.id === target.id ? { ...card, items: [...card.items, ...dragged.items] } : card));
    });
  }, []);

  /** Flip a deck to the next (dir≥0) or previous (dir<0) photo, rotating the
   *  stack in place — tap and the ‹ › arrows both route here. items[0] is the
   *  visible top photo. */
  const cycleImageCard = useCallback((id: number, dir = 1) => {
    setImageCards((previous) => previous.map((card) => {
      if (card.id !== id || card.items.length < 2) return card;
      if (dir >= 0) {
        const [first, ...rest] = card.items;
        return { ...card, items: [...rest, first] };
      }
      const last = card.items[card.items.length - 1]!;
      return { ...card, items: [last, ...card.items.slice(0, -1)] };
    }));
  }, []);

  /** Separate a deck → spread its photos back into individual cards (the
   *  explicit un-stack control on a hovered deck). */
  const spreadImageCard = useCallback((id: number) => {
    setImageCards((previous) => {
      const stackCard = previous.find((card) => card.id === id);
      if (!stackCard || stackCard.items.length < 2) return previous;
      const spread: ImageCard[] = stackCard.items.slice(1).map((item, index) => {
        const spreadId = nextIdRef.current;
        nextIdRef.current += 1;
        zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
        return {
          id: spreadId,
          x: stackCard.x + 30 * (index + 1),
          y: stackCard.y + 22 * (index + 1),
          z: zPeakRef.current,
          w: stackCard.w,
          h: stackCard.h,
          aspect: stackCard.aspect,
          items: [item],
        };
      });
      return [
        ...previous.map((card) => (card.id === id ? { ...card, items: [stackCard.items[0]!] } : card)),
        ...spread,
      ];
    });
  }, []);

  /** Drop a video clip onto the canvas. IndexedDB stores the bytes, the card
   *  renders an object URL, and the snapshot keeps only the media id. */
  const spawnVideoCard = useCallback((file: File, at: { x: number; y: number }) => {
    const src = URL.createObjectURL(file);
    const mediaId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `vid-${Date.now()}-${nextIdRef.current}`;
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      if (!canvasMedia.retainObjectURL(src)) return;
      const natW = probe.videoWidth || 16;
      const natH = probe.videoHeight || 9;
      const aspect = natW / natH;
      const w = natW >= natH ? IMG_MAX_SPAWN_EDGE : Math.round(IMG_MAX_SPAWN_EDGE * aspect);
      const h = Math.round(w / aspect);
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
      const z = zPeakRef.current;
      setVideoCards((previous) => [...previous, {
        id,
        x: Math.max(8, at.x - w / 2),
        y: Math.max(48, at.y - h / 2),
        z,
        w,
        h,
        aspect,
        src,
        name: file.name,
        mediaId,
      }]);
      void putMedia(mediaId, file);
    };
    probe.onerror = () => { URL.revokeObjectURL(src); };
    probe.src = src;
  }, [canvasMedia]);

  const moveVideoCard = useCallback((id: number, x: number, y: number) => {
    setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, x, y } : card)));
  }, []);

  const resizeVideoCard = useCallback((id: number, w: number, h: number) => {
    setVideoCards((previous) => previous.map((card) => (
      card.id === id ? { ...card, w, h } : card
    )));
  }, []);

  // First-frame thumbnail from the card → stored on the card so the minimap can
  // render the video as a still (it can't decode the blob video URL as an image).
  const setVideoPoster = useCallback((id: number, poster: string) => {
    setVideoCards((previous) => previous.map((card) => (card.id === id ? { ...card, poster } : card)));
  }, []);

  const closeVideoCard = useCallback((id: number) => {
    setVideoCards((previous) => {
      const target = previous.find((card) => card.id === id);
      if (target) {
        URL.revokeObjectURL(target.src);
        void deleteMedia(target.mediaId);
      }
      return previous.filter((card) => card.id !== id);
    });
  }, []);

  const dropImages = useCallback((event: DragEvent) => {
    event.preventDefault();
    const all = Array.from(event.dataTransfer?.files ?? []);
    const videos = all.filter((file) => file.type.startsWith('video/'));
    const files = all.filter((file) => file.type.startsWith('image/'));
    // Drop point arrives in visual px — the card layer is zoomed.
    const z = canvasZoom();
    files.forEach((file, index) => {
      spawnImageCard(file, { x: event.clientX / z + index * 30, y: event.clientY / z + index * 24 });
    });
    videos.forEach((file, index) => {
      spawnVideoCard(file, { x: event.clientX / z + (files.length + index) * 30, y: event.clientY / z + (files.length + index) * 24 });
    });
  }, [spawnImageCard, spawnVideoCard]);

  return {
    spawnImageCard,
    moveImageCard,
    resizeImageCard,
    closeImageCard,
    dropImageCard,
    cycleImageCard,
    spreadImageCard,
    spawnVideoCard,
    moveVideoCard,
    resizeVideoCard,
    setVideoPoster,
    closeVideoCard,
    dropImages,
  };
}
