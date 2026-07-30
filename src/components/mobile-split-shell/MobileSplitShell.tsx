'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useLandscapeSplit } from './landscape-controller';
import { DevHostFrame } from './DevHostFrame';
import { useMobileUrlPushListener } from './url-push-listener';

// MobileSplitShell — landscape chrome wrapper for the mobile PWA.
//
// In portrait (or below the 720px width gate) this component is transparent:
// it renders `children` exactly where it sat in the React tree, with no extra
// wrappers and no style. That keeps the existing chat shell mounted at the
// same tree depth on rotation, so transcript/draft/scroll state survives.
//
// In landscape it lays out two panes:
//   left  — `children` (the existing mobile chat shell, mounted as-is)
//   right — dev-host preview iframe
//
// A 6px draggable handle separates them. Ratio is clamped to 0.25–0.75 and
// persisted to localStorage so it survives rotations and reloads.
//
// Hard rules honored here:
//   - inline styles only, palette tokens only (no hardcoded rgba whites)
//   - 100dvh + safe-area-inset-* (no 100vh, no overscroll-behavior traps)
//   - PWA topbar stays solid — we do NOT touch the topbar; the existing
//     mobile shell paints it from inside `children`
//   - system UI for chrome text
//   - File ceiling 800 lines (this file is well under)

const RATIO_STORAGE_KEY = 'o8:mobile-split:ratio';
const RATIO_MIN = 0.25;
const RATIO_MAX = 0.75;
const RATIO_DEFAULT = 0.5;
const HANDLE_HOT_ZONE = 6; // px — visual is centered inside this zone

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return RATIO_DEFAULT;
  if (value < RATIO_MIN) return RATIO_MIN;
  if (value > RATIO_MAX) return RATIO_MAX;
  return value;
}

function readStoredRatio(): number {
  if (typeof window === 'undefined') return RATIO_DEFAULT;
  try {
    const raw = window.localStorage.getItem(RATIO_STORAGE_KEY);
    if (!raw) return RATIO_DEFAULT;
    const parsed = Number(raw);
    return clampRatio(parsed);
  } catch {
    return RATIO_DEFAULT;
  }
}

function writeStoredRatio(value: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RATIO_STORAGE_KEY, String(value));
  } catch {
    // Storage may be disabled in private mode — ignore silently.
  }
}

interface MobileSplitShellProps {
  children: ReactNode;
}

export function MobileSplitShell({ children }: MobileSplitShellProps) {
  const { isSplit } = useLandscapeSplit();

  if (!isSplit) {
    // Transparent passthrough in portrait. The chat shell renders identically
    // to today, no wrapper, no extra DOM nodes.
    return <>{children}</>;
  }

  return <SplitLayout>{children}</SplitLayout>;
}

function SplitLayout({ children }: { children: ReactNode }) {
  // Subscribe to send-to-mobile URL pushes from desktop (#782). The listener
  // re-fans WS messages as `o8:mobile-url-push` window events; DevHostFrame
  // listens for that event and re-points its iframe.
  useMobileUrlPushListener();

  const containerRef = useRef<HTMLDivElement | null>(null);
  // dragStateRef tracks both the active pointer and the most recent ratio
  // emitted by the pointer-move handler. We persist on pointer-up by reading
  // `lastRatio` directly from this ref — that avoids mirroring React state
  // into a separate ref (which the React 19 immutability rule disallows).
  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number | null;
    lastRatio: number;
  }>({ active: false, pointerId: null, lastRatio: RATIO_DEFAULT });

  const [ratio, setRatio] = useState<number>(() => readStoredRatio());
  const [dragging, setDragging] = useState<boolean>(false);

  // Keep the drag-state ratio in sync with React state. `readStoredRatio`
  // already clamps the persisted value, and pointer handlers only push
  // pre-clamped values into state, so we never need to write back here.
  useEffect(() => {
    dragStateRef.current.lastRatio = ratio;
  }, [ratio]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // setPointerCapture can throw on detached elements — safe to ignore.
      }
      dragStateRef.current.active = true;
      dragStateRef.current.pointerId = event.pointerId;
      setDragging(true);
      event.preventDefault();
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current.active) return;
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0) return;
      const offsetX = event.clientX - rect.left;
      const next = clampRatio(offsetX / rect.width);
      // Drag is high-frequency — only persist on release (handlePointerUp)
      // to avoid storage write spam. State updates per move keep the
      // divider tracking the finger; the ref retains the latest value so
      // pointer-up can flush it to localStorage without ref-mirroring
      // React state.
      dragStateRef.current.lastRatio = next;
      setRatio(next);
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const target = event.currentTarget;
      if (dragStateRef.current.pointerId === event.pointerId) {
        try {
          target.releasePointerCapture(event.pointerId);
        } catch {
          // ignore — capture may already be released
        }
      }
      const finalRatio = clampRatio(dragStateRef.current.lastRatio);
      dragStateRef.current.active = false;
      dragStateRef.current.pointerId = null;
      setDragging(false);
      writeStoredRatio(finalRatio);
    },
    [],
  );

  const containerStyle: CSSProperties = useMemo(
    () => ({
      position: 'fixed',
      inset: 0,
      // 100dvh handles iOS dynamic viewport (safe with the URL bar collapse).
      // 100vh kept as a fallback for browsers without dvh support.
      height: '100dvh',
      minHeight: '100vh',
      width: '100vw',
      display: 'grid',
      gridTemplateColumns: `${ratio * 100}% ${HANDLE_HOT_ZONE}px 1fr`,
      // The transition only animates when not dragging — drags must feel
      // 1:1 with the finger.
      transition: dragging
        ? 'none'
        : 'grid-template-columns 220ms cubic-bezier(0.22, 1, 0.36, 1)',
      background: 'var(--t-bg, #111111)',
      // Establish a containing block for `position: fixed` descendants so
      // the chat shell's compose bar / FAB anchor inside the left pane
      // instead of the global viewport.
      transform: 'translateZ(0)',
      isolation: 'isolate',
      overflow: 'hidden',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      paddingLeft: 'env(safe-area-inset-left, 0px)',
      paddingRight: 'env(safe-area-inset-right, 0px)',
    }),
    [ratio, dragging],
  );

  // Each pane needs its own containing block so the chat's fixed-position
  // chrome (top bar, bottom dock) anchors to the pane, not the viewport.
  const leftPaneStyle: CSSProperties = {
    position: 'relative',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    // Same trick — fix-position descendants resolve to this element.
    transform: 'translateZ(0)',
    isolation: 'isolate',
  };

  const rightPaneStyle: CSSProperties = {
    position: 'relative',
    height: '100%',
    minWidth: 0,
    overflow: 'hidden',
    background: 'var(--t-panel, rgba(30,28,26,0.82))',
    color: 'var(--t-text, #FAF5F0)',
    borderLeft: '1px solid var(--t-border, rgba(255,248,240,0.08))',
    transform: 'translateZ(0)',
  };

  const handleStyle: CSSProperties = {
    position: 'relative',
    height: '100%',
    width: '100%',
    cursor: 'col-resize',
    touchAction: 'none',
    background: 'transparent',
    // The hot-zone is wider than the visible line for fingers — the line is
    // drawn by the inner span.
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    WebkitTapHighlightColor: 'transparent',
  };

  const handleLineStyle: CSSProperties = {
    width: 2,
    height: '100%',
    background: dragging
      ? 'var(--t-text-muted, rgba(255,248,240,0.42))'
      : 'var(--t-border, rgba(255,248,240,0.16))',
    transition: dragging ? 'none' : 'background 160ms ease',
  };

  const handleGripStyle: CSSProperties = {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    width: 4,
    height: 36,
    borderRadius: 2,
    background: dragging
      ? 'var(--t-text, rgba(255,248,240,0.78))'
      : 'var(--t-text-muted, rgba(255,248,240,0.32))',
    transition: dragging ? 'none' : 'background 160ms ease',
  };

  return (
    <div ref={containerRef} style={containerStyle}>
      <div style={leftPaneStyle}>{children}</div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={Math.round(RATIO_MIN * 100)}
        aria-valuemax={Math.round(RATIO_MAX * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        aria-label="Resize chat and dev host preview"
        style={handleStyle}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <span style={handleLineStyle} aria-hidden="true" />
        <span style={handleGripStyle} aria-hidden="true" />
      </div>
      <div style={rightPaneStyle}>
        <DevHostFrame />
      </div>
    </div>
  );
}
