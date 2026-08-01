'use client';

import dynamic from 'next/dynamic';
import { useCallback, useRef, type KeyboardEvent, type WheelEvent } from 'react';
import { HoverPipCard } from '@/components/desktop/HoverPipCard';

export const O8_SPEC_PIP_EVENT = 'o8:spec-pip';

const ORIENTATION_KEY = 'o8:spec-pip-orientation';
const LazyO8SpecPane = dynamic(
  () => import('@/components/desktop/o8-panel/O8SpecPane').then((module) => module.O8SpecPane),
  {
    ssr: false,
    loading: () => (
      <div
        aria-label="Loading o8.md preview"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 1,
          color: 'var(--t-text-faint)',
          fontFamily: 'var(--font-sans-system)',
          fontSize: 11,
        }}
      >
        Loading o8.md…
      </div>
    ),
  },
);

export function O8SpecPipCard({
  active,
  repoPath,
  onOpenSpec,
}: {
  active: boolean;
  repoPath?: string | null;
  onOpenSpec?: () => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const movePreview = useCallback((deltaX: number, deltaY: number) => {
    const scroller = previewRef.current?.querySelector<HTMLElement>('.o8-notes-scroll');
    if (!scroller) return false;
    scroller.scrollLeft += deltaX;
    scroller.scrollTop += deltaY;
    return true;
  }, []);

  const onPreviewWheel = useCallback((event: WheelEvent<HTMLButtonElement>, pageHeight: number) => {
    const multiplier = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2 ? pageHeight : 1;
    if (!movePreview(event.deltaX * multiplier, event.deltaY * multiplier)) return;
    event.stopPropagation();
  }, [movePreview]);

  const onPreviewKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, pageHeight: number) => {
    const pageStep = pageHeight * 0.8;
    let deltaY = 0;
    if (event.key === 'ArrowDown') deltaY = 40;
    else if (event.key === 'ArrowUp') deltaY = -40;
    else if (event.key === 'PageDown') deltaY = pageStep;
    else if (event.key === 'PageUp') deltaY = -pageStep;
    else return;
    if (!movePreview(0, deltaY)) return;
    event.preventDefault();
    event.stopPropagation();
  }, [movePreview]);

  return (
    <HoverPipCard
      active={active}
      available={Boolean(repoPath)}
      eventName={O8_SPEC_PIP_EVENT}
      storageKey={ORIENTATION_KEY}
      title="o8.md"
      titleTooltip={repoPath ?? undefined}
      openLabel="Open o8.md panel"
      onOpen={onOpenSpec}
    >
      {({ shape, close }) => (
        <div
          ref={previewRef}
          style={{
            position: 'relative',
            display: 'flex',
            height: shape.frameHeight,
            overflow: 'hidden',
            background: 'var(--t-canvas-bg)',
          }}
        >
          <div
            aria-hidden="true"
            style={{
              display: 'flex',
              flex: 1,
              minWidth: 0,
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            <LazyO8SpecPane repoPath={repoPath} active embedded />
          </div>
          <button
            type="button"
            aria-label="Open o8.md panel"
            onWheel={(event) => onPreviewWheel(event, shape.frameHeight)}
            onKeyDown={(event) => onPreviewKeyDown(event, shape.frameHeight)}
            onClick={() => {
              close();
              onOpenSpec?.();
            }}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 0,
              borderWidth: 0,
              background: 'transparent',
              cursor: 'pointer',
            }}
          />
        </div>
      )}
    </HoverPipCard>
  );
}
