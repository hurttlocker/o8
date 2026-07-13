'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { selectorFor } from '@/lib/browser/selector';
import { reactComponentName } from '@/lib/browser/react-fiber';

interface DesignModeOverlayProps {
  active: boolean;
  onClose: () => void;
  /** DRAW is Design Mode (Q ruling 2026-07-12 — the click-to-grab with hard
   *  element squares is dead): a freeform paint stroke over the page — circle
   *  it, underline it, scribble on it — and on release a floating composer
   *  materializes anchored to the drawing. The submitted text + region + the
   *  SILENTLY collected elements under the stroke route here; part 2 (Q's
   *  next reference video) adds the screenshot crop. */
  onDrawPrompt?: (payload: DesignDrawPrompt) => void;
}

export interface DesignDrawPrompt {
  text: string;
  rect: ScreenRect;
  points: Array<{ x: number; y: number }>;
  /** Technical context under the drawing, collected silently at submit.
   *  `component` is the React component name (Cursor parity) when discoverable. */
  elements: Array<{ selector: string; tag: string; text: string; component?: string | null }>;
}

/** Movement past this many px turns a press into a draw (filters accidental
 *  clicks — a bare click does nothing now that grab is gone). */
const DRAW_THRESHOLD_PX = 6;

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

function strokeBounds(points: Array<{ x: number; y: number }>): ScreenRect {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { top: minY, left: minX, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Quadratic-smoothed SVG path through the raw pointer samples — each segment
 *  curves through the MIDPOINT of adjacent points with the sample as the control
 *  handle, so the ink reads as one fluid line instead of faceted polyline
 *  segments (Apple Pencil feel). Points are already in local surface coords. */
function smoothPathD(points: Array<{ x: number; y: number }>): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const mx = (points[i].x + points[i + 1].x) / 2;
    const my = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${mx} ${my}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export function DesignModeOverlay({ active, onClose, onDrawPrompt }: DesignModeOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // Draw state — pointsRef accumulates at mousemove rate; `stroke` mirrors it
  // for render. `composerAt` anchors the floating prompt to the finished
  // drawing.
  const pointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const drawingRef = useRef(false);
  const [stroke, setStroke] = useState<Array<{ x: number; y: number }>>([]);
  const [composerAt, setComposerAt] = useState<ScreenRect | null>(null);
  const [draft, setDraft] = useState('');
  const composerInputRef = useRef<HTMLInputElement>(null);
  // Craft-pass choreography (2026-07-12): the composer focus ring, the exit
  // fade after send, and the auto-fading hint pill. All compositor-only
  // (opacity/transform), and disabled under prefers-reduced-motion.
  const [composerFocused, setComposerFocused] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [hintShown, setHintShown] = useState(false);
  // Pre-draw hover identity label (Cursor parity): names the React component +
  // tag under the cursor while armed. Hidden during an active stroke / while the
  // composer is open. rAF-throttled.
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; text: string } | null>(null);
  const hoverRafRef = useRef<number | null>(null);
  const reduceMotionRef = useRef<boolean>(
    typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  /** A gesture that CLEARED existing ink/composer suppresses the double-click
   *  exit briefly — rapid re-draws were reading as double-clicks and dumping
   *  the operator out of the mode (Q live-hit 2026-07-12: "it just is always
   *  clicking [out]"). Exit needs a CLEAN double-tap. */
  const suppressExitUntilRef = useRef(0);

  // The ink is CONFINED to the browser content area (Q ruling 2026-07-12:
  // "just in the browser") — the overlay portals into the pane marked
  // [data-o8-draw-surface] instead of covering the window, so the rest of
  // the app (toolbar, drawer, Design button) stays live while armed. That
  // also makes the Design button a working off-switch for free.
  const [surfaceEl, setSurfaceEl] = useState<HTMLElement | null>(null);
  const surfaceRectRef = useRef<ScreenRect | null>(null);
  const [, bumpRectVersion] = useState(0);

  useEffect(() => {
    if (!active) {
      pointsRef.current = [];
      downRef.current = null;
      drawingRef.current = false;
      setStroke([]);
      setComposerAt(null);
      setDraft('');
      setComposerFocused(false);
      setExiting(false);
      setHintShown(false);
      setHoverLabel(null);
      if (hoverRafRef.current) { cancelAnimationFrame(hoverRafRef.current); hoverRafRef.current = null; }
      setSurfaceEl(null);
      surfaceRectRef.current = null;
      return;
    }
    // Multiple browser mounts can exist (main + contextual) — pick the one
    // actually laid out.
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-o8-draw-surface]'));
    const el = candidates.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 10 && rect.height > 10;
    }) ?? null;
    setSurfaceEl(el);
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      surfaceRectRef.current = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      bumpRectVersion((n) => n + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [active]);

  // Hint pill: fade in on arm, then auto-dismiss after ~4s (Cursor pattern) so it
  // states the gesture without lingering as chrome once the operator gets it.
  useEffect(() => {
    if (!active || !surfaceEl) return;
    const raf = requestAnimationFrame(() => setHintShown(true));
    const timer = window.setTimeout(() => setHintShown(false), 4200);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [active, surfaceEl]);

  const inComposer = (target: EventTarget | null) => (
    target instanceof Element && Boolean(target.closest('[data-design-composer]'))
  );

  // Gesture: mousedown on the overlay starts it; move/up ride WINDOW
  // listeners for the gesture's lifetime so a stroke that leaves the pane
  // finishes cleanly (points clamp to the surface).
  const beginGesture = (event: React.MouseEvent) => {
    if (inComposer(event.target)) return;
    event.preventDefault();
    setHoverLabel(null);
    if (pointsRef.current.length > 0 || composerAt) {
      suppressExitUntilRef.current = Date.now() + 800;
    }
    setComposerAt(null);
    setDraft('');
    setStroke([]);
    pointsRef.current = [];
    drawingRef.current = false;
    downRef.current = { x: event.clientX, y: event.clientY };

    const clamp = (p: { x: number; y: number }) => {
      const rect = surfaceRectRef.current;
      if (!rect) return p;
      return {
        x: Math.min(Math.max(p.x, rect.left), rect.left + rect.width),
        y: Math.min(Math.max(p.y, rect.top), rect.top + rect.height),
      };
    };

    const handleMove = (moveEvent: MouseEvent) => {
      const down = downRef.current;
      if (!down) return;
      const point = clamp({ x: moveEvent.clientX, y: moveEvent.clientY });
      if (!drawingRef.current) {
        const dist = Math.hypot(point.x - down.x, point.y - down.y);
        if (dist >= DRAW_THRESHOLD_PX) {
          drawingRef.current = true;
          pointsRef.current = [down, point];
          setStroke([...pointsRef.current]);
        }
        return;
      }
      pointsRef.current.push(point);
      setStroke([...pointsRef.current]);
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove, true);
      window.removeEventListener('mouseup', handleUp, true);
      const wasDrawing = drawingRef.current;
      downRef.current = null;
      drawingRef.current = false;
      if (!wasDrawing) return;
      if (onDrawPrompt && pointsRef.current.length > 1) {
        setComposerAt(strokeBounds(pointsRef.current));
        window.setTimeout(() => composerInputRef.current?.focus(), 30);
      }
    };

    window.addEventListener('mousemove', handleMove, true);
    window.addEventListener('mouseup', handleUp, true);
  };

  // Scrolling while armed (Q live-hit 2026-07-12: "the browser stops and I
  // can't scroll when I draw"). Same-origin iframe pages scroll directly;
  // the native page gets a brief reveal-scroll-refreeze cycle. Either way
  // any existing ink clears — the page moved under it, so both the drawing
  // and the element sampling would lie.
  const handleWheel = (event: React.WheelEvent) => {
    if (inComposer(event.target)) return;
    if (pointsRef.current.length > 0 || composerAt) {
      pointsRef.current = [];
      setStroke([]);
      setComposerAt(null);
      setDraft('');
    }
    const iframe = surfaceEl?.querySelector<HTMLIFrameElement>('iframe[data-o8-browser]');
    if (iframe) {
      try {
        iframe.contentWindow?.scrollBy(event.deltaX, event.deltaY);
      } catch {
        // cross-origin — nothing to scroll from here
      }
    }
  };

  // Pre-draw hover: identify the element under the cursor (component + tag) and
  // float a calm chip beside it. Suppressed during a stroke / while the composer
  // is open; rAF-throttled so it costs at most one hit-test per frame.
  const handleHoverMove = (event: React.MouseEvent) => {
    if (drawingRef.current || composerAt || inComposer(event.target)) {
      if (hoverLabel) setHoverLabel(null);
      return;
    }
    const cx = event.clientX;
    const cy = event.clientY;
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      if (drawingRef.current || composerAt) { setHoverLabel(null); return; }
      const resolved = resolveTarget(cx, cy, overlayRef.current);
      const el = resolved?.el;
      if (!el) { setHoverLabel(null); return; }
      let comp: string | null = null;
      try { comp = reactComponentName(el); } catch { comp = null; }
      const tag = el.tagName.toLowerCase();
      setHoverLabel({ x: cx, y: cy, text: comp ? `${comp} · ${tag}` : tag });
    });
  };

  const submitDraw = () => {
    const text = draft.trim();
    if (!text || !composerAt || !onDrawPrompt) return;
    // Silent technical context (Q ruling): sample the stroke and collect the
    // distinct elements it passed over — the orchestrator gets what the
    // operator circled without the operator naming it. The snapshot img over
    // a frozen native page yields nothing here (part 2 adds the screenshot
    // crop for that path).
    const seen = new Set<Element>();
    const elements: DesignDrawPrompt['elements'] = [];
    const step = Math.max(1, Math.floor(pointsRef.current.length / 24));
    for (let i = 0; i < pointsRef.current.length && elements.length < 4; i += step) {
      const p = pointsRef.current[i];
      const resolved = resolveTarget(p.x, p.y, overlayRef.current);
      const el = resolved?.el;
      if (!el || seen.has(el) || el === overlayRef.current) continue;
      if (el instanceof HTMLElement && el.closest('[data-design-composer]')) continue;
      seen.add(el);
      const textContent = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      let component: string | null = null;
      try { component = reactComponentName(el); } catch { component = null; }
      try {
        elements.push({ selector: selectorFor(el), tag: el.tagName.toLowerCase(), text: textContent, component });
      } catch {
        // selector derivation failed — skip this element
      }
    }
    try {
      onDrawPrompt({ text, rect: composerAt, points: pointsRef.current, elements });
    } finally {
      // Let the ink + composer fade rather than pop out (they're the operator's
      // last touch point) — then close. Reduced-motion closes immediately.
      if (reduceMotionRef.current) {
        onClose();
      } else {
        setExiting(true);
        window.setTimeout(onClose, 150);
      }
    }
  };

  if (!active || !surfaceEl) return null;
  // Native browser page: the in-page injected draw layer owns the gesture
  // (the native window sits ABOVE this webview and stays LIVE — scroll works,
  // ink rides the page, screenshot captures at send). This overlay only
  // handles same-origin iframe pages.
  if (surfaceEl.querySelector('[data-o8-native-browser]')) return null;

  const surfaceRect = surfaceRectRef.current;
  const toLocalX = (x: number) => x - (surfaceRect?.left ?? 0);
  const toLocalY = (y: number) => y - (surfaceRect?.top ?? 0);
  const strokePathD = stroke.length > 1
    ? smoothPathD(stroke.map((p) => ({ x: toLocalX(p.x), y: toLocalY(p.y) })))
    : '';

  // Composer anchor — bottom-center of the drawing, clamped to the pane.
  const composerWidth = Math.min(320, Math.max(200, (surfaceRect?.width ?? 320) - 16));
  const composerLeft = composerAt && surfaceRect
    ? Math.min(Math.max(8, toLocalX(composerAt.left) + composerAt.width / 2 - composerWidth / 2), Math.max(8, surfaceRect.width - composerWidth - 8))
    : 0;
  const composerTop = composerAt && surfaceRect
    ? Math.min(toLocalY(composerAt.top) + composerAt.height + 10, surfaceRect.height - 56)
    : 0;

  return createPortal(
    <div
      ref={overlayRef}
      aria-hidden="true"
      data-design-mode-overlay="true"
      onMouseDown={beginGesture}
      onMouseMove={handleHoverMove}
      onWheel={handleWheel}
      onClickCapture={(event) => {
        if (inComposer(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        // Quick exit without the keyboard (Q ruling 2026-07-12): a CLEAN
        // double-tap leaves the mode. Mid-draw can't trigger it (drawing
        // needs movement), and a tap that just cleared ink/composer is part
        // of the draw rhythm, not an exit.
        if (inComposer(event.target)) return;
        if (drawingRef.current) return;
        if (Date.now() < suppressExitUntilRef.current) return;
        onClose();
      }}
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 60,
        cursor: 'crosshair',
        backgroundColor: 'rgba(15, 23, 42, 0.08)',
        userSelect: 'none',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: `translateX(-50%) translateY(${hintShown && !exiting ? 0 : -3}px)`,
          opacity: hintShown && !exiting ? 1 : 0,
          transition: reduceMotionRef.current ? 'none' : 'opacity 260ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
          maxWidth: 'calc(100% - 24px)',
          minHeight: 34,
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
        Draw on the page · double-click or Esc to exit
      </div>

      {/* Pre-draw hover identity chip — names the React component + tag under the
          cursor while armed, so the operator sees WHAT they're about to circle
          (Cursor parity). Calm dark chip, follows with a slight offset. */}
      {hoverLabel && !composerAt && stroke.length === 0 ? (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: Math.min(toLocalX(hoverLabel.x) + 14, (surfaceRect?.width ?? 0) - 8),
            top: Math.min(toLocalY(hoverLabel.y) + 16, (surfaceRect?.height ?? 0) - 8),
            zIndex: 9999,
            maxWidth: 280,
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 7,
            paddingRight: 7,
            borderRadius: 6,
            backgroundColor: 'rgba(28, 28, 30, 0.92)',
            color: '#f5f5f7',
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.35)',
          }}
        >
          {hoverLabel.text}
        </div>
      ) : null}

      {/* The freeform ink stroke — quadratic-smoothed brand-orange paint with a
          soft white halo underneath (dual-stroke) so it survives any page
          background, Apple Pencil style. Fades on exit rather than popping. */}
      {strokePathD ? (
        <svg
          width="100%"
          height="100%"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'none',
            opacity: exiting ? 0 : 1,
            transition: reduceMotionRef.current ? 'none' : 'opacity 150ms ease',
          }}
          aria-hidden
        >
          <path
            d={strokePathD}
            fill="none"
            stroke="rgba(255, 255, 255, 0.55)"
            strokeWidth={5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={strokePathD}
            fill="none"
            stroke="var(--t-brand-orange, #FF5A1F)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.92}
          />
        </svg>
      ) : null}

      {/* Floating composer — materializes anchored to the finished drawing
          (Cursor part 1). Enter or the send arrow submits; part 2 refines
          the payload per Q's follow-up reference. */}
      {composerAt ? (
        <div
          data-design-composer
          style={{
            position: 'absolute',
            top: composerTop,
            left: composerLeft,
            width: composerWidth,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingTop: 8,
            paddingBottom: 8,
            paddingLeft: 12,
            paddingRight: 8,
            borderRadius: 12,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: composerFocused ? 'var(--t-accent)' : 'var(--t-divider)',
            background: 'var(--t-panel-solid, var(--t-panel))',
            boxShadow: composerFocused
              ? '0 12px 32px rgba(15, 23, 42, 0.28), 0 0 0 2px var(--t-accent)'
              : '0 12px 32px rgba(15, 23, 42, 0.28)',
            zIndex: 10000,
            opacity: exiting ? 0 : 1,
            transform: exiting ? 'translateY(4px) scale(0.96)' : undefined,
            animation: reduceMotionRef.current || exiting ? undefined : 'o8DesignPopIn 150ms cubic-bezier(0.22, 1, 0.36, 1) both',
            transition: reduceMotionRef.current
              ? 'none'
              : 'box-shadow 130ms ease, border-color 130ms ease, opacity 130ms ease, transform 130ms ease',
          }}
        >
          <input
            ref={composerInputRef}
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submitDraw();
              }
              event.stopPropagation();
            }}
            placeholder="Describe what to change here…"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              background: 'transparent',
              outline: 'none',
              color: 'var(--t-text)',
              fontSize: 12.5,
              fontFamily: 'var(--font-sans-system)',
              cursor: 'text',
            }}
          />
          <button
            type="button"
            onClick={submitDraw}
            aria-label="Send"
            disabled={!draft.trim()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              border: 'none',
              borderRadius: 8,
              background: draft.trim() ? 'var(--t-accent)' : 'var(--t-hover)',
              color: draft.trim() ? '#ffffff' : 'var(--t-text-faint)',
              cursor: draft.trim() ? 'pointer' : 'default',
              flexShrink: 0,
              padding: 0,
              transition: 'background 120ms ease, color 120ms ease',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
      ) : null}

    </div>,
    surfaceEl,
  );
}
