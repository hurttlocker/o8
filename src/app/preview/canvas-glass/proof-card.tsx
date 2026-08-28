'use client';

import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { ImageCard, ImageItem } from './image-card';

interface ScreenshotReference {
  path?: string;
  base64?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface UiLoopProofIntent {
  proofId: string;
  before: ScreenshotReference;
  after: ScreenshotReference;
  element: string;
  filePath?: string;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function screenshotReference(value: unknown): ScreenshotReference | null {
  const record = recordValue(value);
  if (!record) return null;
  const path = typeof record.path === 'string' && record.path.trim() ? record.path.trim() : undefined;
  const base64 = typeof record.base64 === 'string' && record.base64.trim() ? record.base64.trim() : undefined;
  if (!path && !base64) return null;
  return {
    path,
    base64,
    mimeType: typeof record.mimeType === 'string' ? record.mimeType : undefined,
    width: typeof record.width === 'number' && Number.isFinite(record.width) ? record.width : undefined,
    height: typeof record.height === 'number' && Number.isFinite(record.height) ? record.height : undefined,
  };
}

function screenshotSrc(reference: ScreenshotReference): string {
  if (reference.path) return `/api/panel/serve-image?path=${encodeURIComponent(reference.path)}`;
  return `data:${reference.mimeType ?? 'image/png'};base64,${reference.base64 ?? ''}`;
}

export function parseUiLoopProofIntent(value: unknown): UiLoopProofIntent | null {
  const args = recordValue(value);
  if (!args) return null;
  const before = screenshotReference(args.before);
  const after = screenshotReference(args.after);
  if (!before || !after) return null;
  const element = typeof args.element === 'string' && args.element.trim()
    ? args.element.trim()
    : 'selected element';
  const proofId = typeof args.proofId === 'string' && args.proofId.trim()
    ? args.proofId.trim()
    : `${before.path ?? before.base64}:${after.path ?? after.base64}`;
  return {
    proofId,
    before,
    after,
    element,
    ...(typeof args.filePath === 'string' && args.filePath.trim() ? { filePath: args.filePath.trim() } : {}),
  };
}

export function proofImageItems(proof: UiLoopProofIntent): [ImageItem, ImageItem] {
  return [
    { src: screenshotSrc(proof.before), name: `before · ${proof.element}` },
    { src: screenshotSrc(proof.after), name: `after · ${proof.element}` },
  ];
}

export function buildUiLoopProofCard(input: {
  proof: UiLoopProofIntent;
  id: number;
  x: number;
  y: number;
  z: number;
}): ImageCard {
  const width = input.proof.before.width ?? input.proof.after.width ?? 16;
  const height = input.proof.before.height ?? input.proof.after.height ?? 9;
  const aspect = width > 0 && height > 0 ? width / height : 16 / 9;
  const w = 420;
  return {
    id: input.id,
    x: input.x,
    y: input.y,
    z: input.z,
    w,
    h: Math.round(w / aspect),
    aspect,
    items: proofImageItems(input.proof),
  };
}

export function useUiLoopProofCardSpawner(
  canvasCardsRef: { current: { file: Array<{ path?: string; x: number; y: number; w: number }> } },
  nextIdRef: { current: number },
  zPeakRef: { current: number },
  setImageCards: Dispatch<SetStateAction<ImageCard[]>>,
  findFreeSpot: (width: number, height: number) => { x: number; y: number },
) {
  return useCallback((value: unknown) => {
    const proof = parseUiLoopProofIntent(value);
    if (!proof) return;
    const file = proof.filePath ? canvasCardsRef.current.file.find((card) => card.path === proof.filePath) : null;
    const target = file ? { x: file.x + file.w + 24, y: file.y } : findFreeSpot(420, 236);
    const id = nextIdRef.current++;
    zPeakRef.current = Math.min(zPeakRef.current + 1, 39);
    const card = buildUiLoopProofCard({ proof, id, ...target, z: zPeakRef.current });
    setImageCards((previous) => {
      const existing = previous.find((candidate) => candidate.items[0]?.src === card.items[0]?.src && candidate.items[1]?.src === card.items[1]?.src);
      return existing ? previous.map((candidate) => candidate.id === existing.id ? { ...candidate, z: card.z } : candidate) : [...previous, card];
    });
  }, [canvasCardsRef, findFreeSpot, nextIdRef, setImageCards, zPeakRef]);
}
