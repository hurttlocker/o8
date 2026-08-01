'use client';

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

const FONT = 'var(--font-sans-system)';
const OPEN_DWELL_MS = 240;
const CLOSE_GRACE_MS = 200;
const HEADER_HEIGHT = 30;
const VIEWPORT_GUTTER = 8;
const PIP_ACTIVATED_EVENT = 'o8:hover-pip-activated';

const SHAPES = {
  tall: { width: 300, frameHeight: 470, viewport: 390 },
  wide: { width: 440, frameHeight: 264, viewport: 1280 },
} as const;

export type HoverPipOrientation = keyof typeof SHAPES;
export type HoverPipShape = (typeof SHAPES)[HoverPipOrientation];

export type HoverPipEventDetail = {
  hovering?: boolean;
  toggle?: boolean;
  open?: boolean;
};

type PipPosition = { x: number; y: number };

function PopOutGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  );
}

/** Rotation toggle — shows the shape the card would switch to. */
function OrientationGlyph({ next }: { next: HoverPipOrientation }) {
  return next === 'tall' ? (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="3" width="10" height="18" rx="2" />
    </svg>
  ) : (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="7" width="18" height="10" rx="2" />
    </svg>
  );
}

function readPosition(key: string): PipPosition | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<PipPosition> | null;
    return value && Number.isFinite(value.x) && Number.isFinite(value.y)
      ? { x: value.x as number, y: value.y as number }
      : null;
  } catch {
    return null;
  }
}

function clampPosition(position: PipPosition, shape: HoverPipShape): PipPosition {
  const maxX = Math.max(VIEWPORT_GUTTER, window.innerWidth - shape.width - VIEWPORT_GUTTER);
  const maxY = Math.max(VIEWPORT_GUTTER, window.innerHeight - shape.frameHeight - HEADER_HEIGHT - VIEWPORT_GUTTER);
  return {
    x: Math.min(Math.max(position.x, VIEWPORT_GUTTER), maxX),
    y: Math.min(Math.max(position.y, VIEWPORT_GUTTER), maxY),
  };
}

export function HoverPipCard({
  active,
  available,
  eventName,
  storageKey,
  title,
  titleTooltip,
  onOpen,
  openLabel = 'Open preview',
  children,
}: {
  active: boolean;
  available: boolean;
  eventName: string;
  storageKey: string;
  title: string;
  titleTooltip?: string;
  onOpen?: () => void;
  openLabel?: string;
  children: (context: {
    orientation: HoverPipOrientation;
    shape: HoverPipShape;
    close: () => void;
  }) => ReactNode;
}) {
  const positionKey = `${storageKey}:position`;
  const [hoverVisible, setHoverVisible] = useState(false);
  const [manualVisible, setManualVisible] = useState(false);
  const hoverVisibleRef = useRef(false);
  const manualVisibleRef = useRef(false);
  const [orientation, setOrientation] = useState<HoverPipOrientation>(() => {
    if (typeof window === 'undefined') return 'tall';
    try {
      return window.localStorage.getItem(storageKey) === 'wide' ? 'wide' : 'tall';
    } catch {
      return 'tall';
    }
  });
  const [position, setPosition] = useState<PipPosition | null>(() => readPosition(positionKey));
  const positionRef = useRef(position);
  const cardHoverRef = useRef(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    cardX: number;
    cardY: number;
  } | null>(null);
  const shape = SHAPES[orientation];
  const reduceMotion = useReducedMotion();

  const persistPosition = useCallback((next: PipPosition) => {
    try {
      window.localStorage.setItem(positionKey, JSON.stringify(next));
    } catch {
      // Persistence is a convenience; dragging still works without storage.
    }
  }, [positionKey]);

  const updatePosition = useCallback((next: PipPosition, persist = false) => {
    positionRef.current = next;
    setPosition(next);
    if (persist) persistPosition(next);
  }, [persistPosition]);

  const close = useCallback(() => {
    hoverVisibleRef.current = false;
    manualVisibleRef.current = false;
    setHoverVisible(false);
    setManualVisible(false);
  }, []);

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    openTimerRef.current = null;
    closeTimerRef.current = null;
  }, []);

  const closeImmediately = useCallback(() => {
    clearTimers();
    hoverVisibleRef.current = false;
    manualVisibleRef.current = false;
    close();
  }, [clearTimers, close]);

  const requestClose = useCallback(() => {
    window.dispatchEvent(new CustomEvent(eventName, { detail: { open: false } }));
  }, [eventName]);

  const announceActivation = useCallback(() => {
    window.dispatchEvent(new CustomEvent(PIP_ACTIVATED_EVENT, { detail: { eventName } }));
  }, [eventName]);

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      if (!cardHoverRef.current) {
        hoverVisibleRef.current = false;
        setHoverVisible(false);
      }
    }, CLOSE_GRACE_MS);
  }, []);

  useEffect(() => {
    const onPipEvent = (event: Event) => {
      const detail = (event as CustomEvent<HoverPipEventDetail>).detail ?? {};
      if (typeof detail.open === 'boolean') {
        if (detail.open) {
          if (!available) return;
          announceActivation();
          manualVisibleRef.current = true;
          setManualVisible(true);
        } else {
          closeImmediately();
        }
      }
      if (detail.toggle) {
        if (hoverVisibleRef.current || manualVisibleRef.current) {
          closeImmediately();
        } else {
          if (!available) return;
          announceActivation();
          manualVisibleRef.current = true;
          setManualVisible(true);
        }
      }
      if (typeof detail.hovering !== 'boolean') return;

      if (detail.hovering) {
        if (!available) return;
        clearTimers();
        openTimerRef.current = window.setTimeout(() => {
          announceActivation();
          hoverVisibleRef.current = true;
          setHoverVisible(true);
        }, OPEN_DWELL_MS);
      } else {
        if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
        openTimerRef.current = null;
        scheduleClose();
      }
    };
    window.addEventListener(eventName, onPipEvent);
    return () => {
      window.removeEventListener(eventName, onPipEvent);
      clearTimers();
    };
  }, [announceActivation, available, clearTimers, closeImmediately, eventName, scheduleClose]);

  useEffect(() => {
    const onOtherPipActivated = (event: Event) => {
      const activatedEventName = (event as CustomEvent<{ eventName?: string }>).detail?.eventName;
      if (activatedEventName && activatedEventName !== eventName) closeImmediately();
    };
    window.addEventListener(PIP_ACTIVATED_EVENT, onOtherPipActivated);
    return () => window.removeEventListener(PIP_ACTIVATED_EVENT, onOtherPipActivated);
  }, [closeImmediately, eventName]);

  useEffect(() => {
    if (!positionRef.current) return;
    const next = clampPosition(positionRef.current, shape);
    updatePosition(next, true);
  }, [shape, updatePosition]);

  useEffect(() => {
    const onResize = () => {
      if (!positionRef.current) return;
      updatePosition(clampPosition(positionRef.current, shape), true);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [shape, updatePosition]);

  const toggleOrientation = useCallback(() => {
    setOrientation((current) => {
      const next: HoverPipOrientation = current === 'tall' ? 'wide' : 'tall';
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // Orientation still changes for this session.
      }
      return next;
    });
  }, [storageKey]);

  const onDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const card = event.currentTarget.parentElement;
    if (!card) return;
    const bounds = card.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      cardX: bounds.left,
      cardY: bounds.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, []);

  const onDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updatePosition(clampPosition({
      x: drag.cardX + event.clientX - drag.pointerX,
      y: drag.cardY + event.clientY - drag.pointerY,
    }, shape));
  }, [shape, updatePosition]);

  const onDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (positionRef.current) persistPosition(positionRef.current);
  }, [persistPosition]);

  const show = active && available && (hoverVisible || manualVisible);

  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key={eventName}
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: 'easeOut' }}
          onMouseEnter={() => {
            cardHoverRef.current = true;
            if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
          }}
          onMouseLeave={() => {
            cardHoverRef.current = false;
            scheduleClose();
          }}
          style={{
            position: 'fixed',
            top: position?.y ?? 52,
            right: position ? undefined : 16,
            left: position?.x,
            width: shape.width,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 14,
            overflow: 'hidden',
            background: 'var(--t-panel-solid, var(--t-panel))',
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-panel-border)',
            boxShadow: 'var(--t-panel-shadow, 0 12px 32px rgba(0, 0, 0, 0.25))',
            fontFamily: FONT,
            transformOrigin: 'top right',
          }}
        >
          <div
            onPointerDown={onDragStart}
            onPointerMove={onDragMove}
            onPointerUp={onDragEnd}
            onPointerCancel={onDragEnd}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minHeight: HEADER_HEIGHT,
              paddingLeft: 10,
              paddingRight: 4,
              cursor: 'grab',
              touchAction: 'none',
              userSelect: 'none',
            }}
          >
            <span
              title={titleTooltip}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 10.5,
                fontWeight: 300,
                letterSpacing: '-0.1px',
                color: 'var(--t-text-muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
            <button
              type="button"
              aria-label={orientation === 'tall' ? 'Switch to desktop-style view' : 'Switch to mobile-style view'}
              title={orientation === 'tall' ? 'Desktop-style view' : 'Mobile-style view'}
              onClick={toggleOrientation}
              style={controlStyle}
            >
              <OrientationGlyph next={orientation === 'tall' ? 'wide' : 'tall'} />
            </button>
            <button
              type="button"
              aria-label={openLabel}
              title={openLabel}
              onClick={() => {
                closeImmediately();
                onOpen?.();
              }}
              style={controlStyle}
            >
              <PopOutGlyph />
            </button>
            <button
              type="button"
              aria-label="Close preview"
              title="Close preview"
              onClick={closeImmediately}
              style={{
                ...controlStyle,
                fontSize: 14,
                fontWeight: 300,
                fontFamily: FONT,
              }}
            >
              ×
            </button>
          </div>
          {children({ orientation, shape, close: requestClose })}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

const controlStyle = {
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  minWidth: 24,
  height: 24,
  minHeight: 24,
  borderWidth: 0,
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--t-text-faint)',
  cursor: 'pointer',
} as const;
