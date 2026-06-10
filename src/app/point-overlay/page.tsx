'use client';

/**
 * /point-overlay — the Symon Points surface (Clicky-parity dossier #1).
 *
 * Loaded by the THIRD Tauri window (label `point-overlay`, see
 * src-tauri/src/point_overlay.rs): transparent, click-through, sized to the
 * captured monitor. This page paints the animated pointer when the agent's
 * reply carried [POINT:x,y:label] tags:
 *
 *   - SINGLE point → the glass dot flies from the dock (top center) to the
 *     target along a quadratic Bézier with a lifted midpoint (CSS offset-path,
 *     offset-rotate following travel), lands with a spring overshoot + one
 *     orange ring ripple, then the label chip fades in.
 *   - TOUR (2+ points) → numbered markers spring in staggered 120ms apart,
 *     in the order the user should follow.
 *
 * Glyph is Symon, not Clicky: a soft glass dot wearing the o8 orange ring
 * (#FF5A1F = --t-brand-orange) — Rams, not gamer. All coords arrive in
 * window-local logical px (the Rust side owns the screenshot→screen
 * transform). Everything is pointer-events:none — the window is already
 * click-through at the OS level; this is belt and suspenders.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';

export const dynamic = 'force-dynamic';

const ORANGE = '#FF5A1F';

type OverlayPoint = { x: number; y: number; label: string };
type ShowPayload = { gen: number; points: OverlayPoint[]; tour: boolean; durationMs: number };

/** Travel time scales with distance so short hops feel quick and a cross-screen
 * swoop reads as one continuous gesture. */
function flightMs(dist: number): number {
  return Math.min(920, 480 + dist * 0.28);
}

/** Quadratic Bézier path from the dock (top center) to the target, midpoint
 * pushed perpendicular to the travel line — the "swoop". Arcs toward screen
 * center so the lift never leaves the visible area. */
function swoopPath(sx: number, sy: number, tx: number, ty: number, w: number, h: number): string {
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.max(1, Math.hypot(dx, dy));
  const side = tx < w / 2 ? -1 : 1; // bow outward, away from screen center
  const lift = Math.min(180, dist * 0.22);
  const cx = Math.min(w - 24, Math.max(24, sx + dx / 2 + (-dy / dist) * lift * side));
  const cy = Math.min(h - 24, Math.max(24, sy + dy / 2 + (dx / dist) * lift * side));
  return `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`;
}

/** The glass dot itself — shared by the flier and landed markers. */
function GlassDot({ size = 18 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background:
          'radial-gradient(circle at 35% 30%, rgba(255,255,255,0.88), rgba(255,255,255,0.30) 58%, rgba(255,255,255,0.14))',
        border: '1px solid rgba(255,255,255,0.6)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.4), inset 0 1px 2px rgba(255,255,255,0.5)',
      }}
    />
  );
}

/** Label chip in the dock's glass vocabulary. */
function LabelChip({ text, above }: { text: string; above: boolean }) {
  if (!text) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        ...(above ? { bottom: 30 } : { top: 30 }),
        whiteSpace: 'nowrap',
        maxWidth: 240,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        background: 'linear-gradient(rgba(20,24,34,0.66), rgba(14,18,28,0.6))',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 8,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 9,
        paddingRight: 9,
        fontSize: 11.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: '#f4f5f7',
        textShadow: '0 1px 4px rgba(0,0,0,0.35)',
        animation: 'o8PointChipIn 0.26s cubic-bezier(0.22, 1, 0.36, 1) both',
      }}
    >
      {text}
    </div>
  );
}

/** A landed marker: breathing orange ring + glass dot + ripple + chip. */
function Marker({
  point,
  index,
  numbered,
  delayMs,
  screenH,
}: {
  point: OverlayPoint;
  index: number;
  numbered: boolean;
  delayMs: number;
  screenH: number;
}) {
  const above = point.y > screenH - 90;
  return (
    <div
      style={{
        position: 'fixed',
        left: point.x,
        top: point.y,
        width: 0,
        height: 0,
        pointerEvents: 'none',
        animation: `o8PointIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) ${delayMs}ms both`,
      }}
    >
      {/* ring ripple — one pulse outward on arrival */}
      <div
        style={{
          position: 'absolute',
          left: -20,
          top: -20,
          width: 40,
          height: 40,
          borderRadius: '50%',
          border: `2px solid ${ORANGE}`,
          opacity: 0,
          animation: `o8PointRipple 0.9s ease-out ${delayMs + 120}ms both`,
        }}
      />
      {/* the steady orange ring, breathing */}
      <div
        style={{
          position: 'absolute',
          left: -19,
          top: -19,
          width: 38,
          height: 38,
          borderRadius: '50%',
          border: `2px solid ${ORANGE}E6`,
          boxShadow: `0 0 14px ${ORANGE}59, inset 0 0 6px ${ORANGE}26`,
          animation: 'o8PointBreathe 2.4s ease-in-out infinite alternate',
        }}
      />
      <div style={{ position: 'absolute', left: -9, top: -9 }}>
        <GlassDot />
      </div>
      {numbered ? (
        <div
          style={{
            position: 'absolute',
            left: 11,
            top: -25,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: ORANGE,
            color: '#fff',
            fontSize: 9.5,
            fontWeight: 500,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 1px 6px rgba(0,0,0,0.35)',
          }}
        >
          {index + 1}
        </div>
      ) : null}
      <LabelChip text={point.label} above={above} />
    </div>
  );
}

/** Single-point mode: the dot flies the swoop, then the Marker takes over. */
function Flight({ point, screenW, screenH }: { point: OverlayPoint; screenW: number; screenH: number }) {
  const [landed, setLanded] = useState(false);
  const [distance, setDistance] = useState('0%');
  const sx = screenW / 2;
  const sy = 10;
  const dist = Math.hypot(point.x - sx, point.y - sy);
  const dur = useMemo(() => flightMs(dist), [dist]);
  const path = useMemo(
    () => swoopPath(sx, sy, point.x, point.y, screenW, screenH),
    [sx, sy, point.x, point.y, screenW, screenH],
  );

  useEffect(() => {
    // Double-rAF so the 0% start position commits before the transition runs.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDistance('100%'));
    });
    const t = setTimeout(() => setLanded(true), dur + 30);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(t);
    };
  }, [dur]);

  if (landed) {
    return <Marker point={point} index={0} numbered={false} delayMs={0} screenH={screenH} />;
  }

  return (
    <div
      style={
        {
          position: 'fixed',
          left: 0,
          top: 0,
          pointerEvents: 'none',
          offsetPath: `path('${path}')`,
          offsetRotate: 'auto',
          offsetDistance: distance,
          transition: `offset-distance ${dur}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        } as React.CSSProperties
      }
    >
      {/* comet trail — local +x points along travel (offset-rotate auto), so
          the streak extends backwards in -x and fades */}
      <div
        style={{
          position: 'absolute',
          right: 6,
          top: -2.5,
          width: 34,
          height: 5,
          borderRadius: 3,
          background: 'linear-gradient(to left, rgba(255,255,255,0.5), rgba(255,255,255,0))',
          filter: 'blur(1.5px)',
        }}
      />
      <div style={{ position: 'absolute', left: -9, top: -9 }}>
        <GlassDot />
      </div>
    </div>
  );
}

export default function PointOverlayPage() {
  const [show, setShow] = useState<ShowPayload | null>(null);
  const [fading, setFading] = useState(false);
  const [viewport, setViewport] = useState({ w: 1440, h: 900 });
  const lastGenRef = useRef(0);

  // Transparent html/body — same rationale as /dictation-pill: the window is
  // clearColor at the OS level; any painted background becomes a solid sheet
  // over the whole monitor.
  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  useEffect(() => {
    const sync = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unShow: (() => void) | undefined;
    let unHide: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        Promise.all([
          listen<ShowPayload>('o8:point-show', (e) => {
            if (!e.payload?.points?.length) return;
            if (e.payload.gen <= lastGenRef.current) return; // stale re-emit
            lastGenRef.current = e.payload.gen;
            setFading(false);
            setShow(e.payload);
          }),
          listen('o8:point-hide', () => setFading(true)),
        ]),
      )
      .then(([a, b]) => {
        unShow = a;
        unHide = b;
      })
      .catch(() => {
        /* outside Tauri: nothing to listen to */
      });
    return () => {
      unShow?.();
      unHide?.();
    };
  }, []);

  // After the fade transition completes, clear the markers entirely so a
  // hidden window never holds stale DOM.
  useEffect(() => {
    if (!fading) return;
    const t = setTimeout(() => setShow(null), 520);
    return () => clearTimeout(t);
  }, [fading]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.5s ease',
      }}
    >
      <style>{`
        @keyframes o8PointIn {
          0% { opacity: 0; transform: scale(0.4); }
          70% { opacity: 1; transform: scale(1.06); }
          100% { opacity: 1; transform: scale(1); }
        }
        @keyframes o8PointRipple {
          0% { opacity: 0.85; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.9); }
        }
        @keyframes o8PointBreathe {
          from { transform: scale(1); }
          to { transform: scale(1.06); }
        }
        @keyframes o8PointChipIn {
          from { opacity: 0; transform: translateX(-50%) translateY(4px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
      {show ? (
        show.tour ? (
          show.points.map((p, i) => (
            <Marker
              key={`${show.gen}-${i}`}
              point={p}
              index={i}
              numbered
              delayMs={i * 120}
              screenH={viewport.h}
            />
          ))
        ) : (
          <Flight
            key={show.gen}
            point={show.points[0]}
            screenW={viewport.w}
            screenH={viewport.h}
          />
        )
      ) : null}
    </div>
  );
}
