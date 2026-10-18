'use client';

import { useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import {
  compactWorkerScrollRows,
  projectResponsiveAutomaticSessionTiles,
  sessionTileViewportBand,
  type SessionTileViewportBand,
} from '@/lib/orchestrator/session-tile-responsive';
import { SessionTileSurface } from './SessionTileSurface';
import { ThreadDropLayer, type ThreadDropAction } from './ThreadDropLayer';

interface ResponsiveSessionSurfaceProps extends ComponentProps<typeof SessionTileSurface> {
  active: boolean;
  onThreadDrop: (action: ThreadDropAction) => void;
}

export function ResponsiveSessionSurface({
  active,
  onThreadDrop,
  ...surfaceProps
}: ResponsiveSessionSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [band, setBand] = useState<SessionTileViewportBand>('wide');

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    const update = (width: number) => {
      if (width <= 0) return;
      const next = sessionTileViewportBand(width);
      setBand((current) => current === next ? current : next);
    };
    update(surface.clientWidth);
    if (typeof ResizeObserver === 'undefined') {
      const updateOnResize = () => update(surface.clientWidth);
      window.addEventListener('resize', updateOnResize);
      return () => window.removeEventListener('resize', updateOnResize);
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined) update(width);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const renderedLayout = useMemo(
    () => projectResponsiveAutomaticSessionTiles(surfaceProps.layout, band),
    [surfaceProps.layout, band],
  );
  const workerScrollRows = compactWorkerScrollRows(surfaceProps.layout, band);
  const renderedSurfaceProps = {
    ...surfaceProps,
    layout: renderedLayout,
    workerScrollRows,
    disableResizeHandles: surfaceProps.disableResizeHandles || (workerScrollRows > 0 || (band === 'stacked' && renderedLayout !== surfaceProps.layout)),
  };

  return (
    <div ref={surfaceRef} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <SessionTileSurface {...renderedSurfaceProps} />
      <ThreadDropLayer active={active} layout={renderedLayout} onDrop={onThreadDrop} useRenderedLeafRects={workerScrollRows > 0} />
    </div>
  );
}
