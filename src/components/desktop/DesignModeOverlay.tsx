'use client';

import { useEffect, useRef, useState } from 'react';
import { selectorFor } from '@/lib/browser/selector';
import { buildGrabbedElement, type GrabbedElement } from '@/lib/browser/grab';

interface DesignModeOverlayProps {
  active: boolean;
  onGrab: (grabbed: GrabbedElement) => void;
  onClose: () => void;
}

interface ScreenRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Resolved {
  /** The element to grab, or null when the target is a cross-origin frame. */
  el: Element | null;
  /** The highlight box in dashboard (screen) coordinates. */
  rect: ScreenRect;
}

/** Resolve the real element under the cursor — drilling into a same-origin
 *  embedded browser iframe (`data-o8-browser`) when the pointer is over one,
 *  so Design Mode grabs the live inner element, not the `<iframe>` itself. */
function resolveTarget(clientX: number, clientY: number, overlay: HTMLDivElement | null): Resolved | null {
  // The overlay sits on top to capture the click; ignore it while hit-testing.
  const previous = overlay?.style.pointerEvents ?? '';
  if (overlay) overlay.style.pointerEvents = 'none';
  const hit = document.elementFromPoint(clientX, clientY);
  if (overlay) overlay.style.pointerEvents = previous;
  if (!hit) return null;

  if (hit instanceof HTMLIFrameElement && hit.dataset.o8Browser) {
    const frameRect = hit.getBoundingClientRect();
    let doc: Document | null = null;
    try {
      doc = hit.contentDocument;
    } catch {
      doc = null;
    }
    const inner = doc?.elementFromPoint(clientX - frameRect.left, clientY - frameRect.top) ?? null;
    if (inner) {
      const innerRect = inner.getBoundingClientRect();
      return {
        el: inner,
        rect: {
          top: frameRect.top + innerRect.top,
          left: frameRect.left + innerRect.left,
          width: innerRect.width,
          height: innerRect.height,
        },
      };
    }
    // Cross-origin (or empty) frame — highlight it but it can't be grabbed.
    return { el: null, rect: { top: frameRect.top, left: frameRect.left, width: frameRect.width, height: frameRect.height } };
  }

  const rect = hit.getBoundingClientRect();
  return { el: hit, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } };
}

export function DesignModeOverlay({ active, onGrab, onClose }: DesignModeOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<Resolved | null>(null);
  const [hover, setHover] = useState<ScreenRect | null>(null);
  const [grabbable, setGrabbable] = useState(false);

  useEffect(() => {
    if (!active) {
      targetRef.current = null;
      setHover(null);
      return;
    }

    const handleMove = (event: MouseEvent) => {
      const resolved = resolveTarget(event.clientX, event.clientY, overlayRef.current);
      targetRef.current = resolved;
      setHover(resolved?.rect ?? null);
      setGrabbable(Boolean(resolved?.el));
    };

    const handleClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const resolved = targetRef.current ?? resolveTarget(event.clientX, event.clientY, overlayRef.current);
      const target = resolved?.el;
      if (!target) return; // cross-origin frame or empty — nothing to grab
      try {
        onGrab(buildGrabbedElement(target, selectorFor(target)));
      } finally {
        onClose();
      }
    };

    window.addEventListener('mousemove', handleMove, true);
    window.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('mousemove', handleMove, true);
      window.removeEventListener('click', handleClick, true);
    };
  }, [active, onClose, onGrab]);

  if (!active) return null;

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      data-design-mode-overlay="true"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 9999,
        cursor: 'crosshair',
        backgroundColor: 'rgba(15, 23, 42, 0.08)',
        userSelect: 'none',
      }}
    >
      <div
        style={{
          position: 'fixed',
          top: 18,
          left: '50%',
          transform: 'translateX(-50%)',
          minHeight: 44,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider)',
          backgroundColor: 'var(--t-panel-translucent)',
          color: 'var(--t-text)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '-0.01em',
          lineHeight: 1.4,
          boxShadow: 'var(--t-glass-shadow)',
          backdropFilter: 'blur(18px) saturate(1.5)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.5)',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Design Mode — click any element to grab it · Esc to exit
      </div>

      {hover ? (
        <div
          style={{
            position: 'fixed',
            top: hover.top,
            left: hover.left,
            width: hover.width,
            height: hover.height,
            borderWidth: 2,
            borderStyle: 'solid',
            borderColor: grabbable ? '#2563eb' : 'rgba(148, 163, 184, 0.8)',
            borderRadius: 6,
            backgroundColor: grabbable ? 'rgba(37, 99, 235, 0.08)' : 'rgba(148, 163, 184, 0.06)',
            boxSizing: 'border-box',
            pointerEvents: 'none',
            transition: 'top 60ms linear, left 60ms linear, width 60ms linear, height 60ms linear',
          }}
        />
      ) : null}
    </div>
  );
}
