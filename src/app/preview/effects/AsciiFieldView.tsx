'use client';

import { useRef, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { useAsciiField, type AsciiEngine, type AsciiVisual } from './ascii-field';

// Thin wrapper shared by every field-based ASCII effect: mounts the container +
// canvas and runs the shared engine loop. An effect supplies its engine (an
// `update` fn) and live visual params; everything else (DPR, resize, cursor,
// render) is handled by useAsciiField.
export function AsciiFieldView(props: {
  engineRef: MutableRefObject<AsciiEngine | null>;
  visualRef: MutableRefObject<AsciiVisual>;
  reinitKey: string;
  width: string | number;
  height: string | number;
  opacity: number;
  className?: string;
  children?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useAsciiField({
    containerRef,
    canvasRef,
    engineRef: props.engineRef,
    visualRef: props.visualRef,
    reinitKey: props.reinitKey,
  });

  const containerStyle: CSSProperties = {
    position: 'relative',
    width: typeof props.width === 'number' ? `${props.width}px` : props.width,
    height: typeof props.height === 'number' ? `${props.height}px` : props.height,
    overflow: 'hidden',
  };
  const canvasStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    display: 'block',
    opacity: props.opacity,
    touchAction: 'none',
  };

  return (
    <div ref={containerRef} className={props.className} style={containerStyle}>
      <canvas ref={canvasRef} style={canvasStyle} aria-hidden />
      {props.children != null && (
        <div style={{ position: 'relative', zIndex: 1, width: '100%', height: '100%' }}>{props.children}</div>
      )}
    </div>
  );
}
