'use client';

import { useLayoutEffect, useRef, useState, type PointerEventHandler } from 'react';
import { readAppliedUiZoom } from '@/lib/appearance/ui-zoom';
import { ResizeEdge } from './ResizeEdge';
import { COLUMN_HANDLE_WIDTH, RIGHT_COLUMN_CHROME, WORKSPACE_RESERVE } from '../hooks/useColumnResize';

export function RightPanelResizeEdge({ width, minimum, maximum, onStartDrag, onResize }: {
  width: number; minimum: number; maximum: number;
  onStartDrag: PointerEventHandler<HTMLDivElement>;
  onResize: (width: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<{ width: number; max: number } | null>(null);
  useLayoutEffect(() => {
    const shell = host.current?.parentElement;
    const column = shell?.querySelector<HTMLElement>('[data-mcp-scope="chat-panel"]');
    const container = shell?.parentElement;
    if (!column || !container) return;
    const measure = () => {
      const zoom = readAppliedUiZoom();
      const next = { width: column.getBoundingClientRect().width / zoom,
        max: Math.min(maximum, Math.max(0, container.getBoundingClientRect().width / zoom - WORKSPACE_RESERVE - RIGHT_COLUMN_CHROME)) };
      setMeasured(current => current?.width === next.width && current.max === next.max ? current : next);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(column); observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [maximum]);
  const max = measured?.max ?? maximum;
  const min = Math.min(minimum, max);
  const current = measured?.width ?? width;
  return <ResizeEdge ref={host} aria-label="Right panel width" aria-valuemin={min} aria-valuemax={max} aria-valuenow={current}
    onPointerDown={onStartDrag} linePosition={COLUMN_HANDLE_WIDTH + 0.5} hitSlop={8}
    onKeyDown={event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      onResize(Math.max(min, Math.min(max, current + (event.key === 'ArrowLeft' ? 16 : -16))));
    }} style={{ width: COLUMN_HANDLE_WIDTH }} glowStyle={{ top: 22, bottom: 22 }} />;
}
