'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { paintCanvasImage, type CustomCanvasBackgroundSettings } from '@/lib/canvas-mode/custom-background';

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' };

export function CustomCanvasBackground({ image, fallback }: { image: CustomCanvasBackgroundSettings; fallback: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState<{ key: string; mode: string; failed?: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const source = new Image();
    source.src = image.dataUrl;
    void source.decode().then(() => {
      if (cancelled || !canvas.current) return;
      paintCanvasImage(canvas.current, source, image.mode);
      setRendered({ key: image.dataUrl, mode: image.mode });
    }).catch(() => {
      if (!cancelled) setRendered({ key: image.dataUrl, mode: image.mode, failed: true });
    });
    return () => { cancelled = true; };
  }, [image.dataUrl, image.mode]);

  if (rendered?.failed && rendered.key === image.dataUrl && rendered.mode === image.mode) return fallback;
  return (
    <div aria-hidden="true" data-custom-canvas-background data-mode={rendered?.key === image.dataUrl ? rendered.mode : undefined} style={{ ...fill, zIndex: 1, overflow: 'hidden' }}>
      <canvas ref={canvas} style={{ ...fill, objectFit: 'cover' }} />
      <div data-custom-canvas-scrim style={{ ...fill, background: 'var(--cnv-custom-backdrop-scrim)' }} />
    </div>
  );
}
