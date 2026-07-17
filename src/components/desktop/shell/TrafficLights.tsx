'use client';

/**
 * TrafficLights — DOM-rendered macOS window controls (close / minimize / zoom).
 *
 * WHY THESE EXIST (Q ruling 2026-07-16): the native NSWindow traffic lights are
 * drawn by the OS at a fixed PHYSICAL size and position, so they can never
 * track the app's CSS `zoom` (⌘+/-). Every alignment between them and the
 * scaled chrome was a per-zoom calibration — the 64px × --zoom-inverse spacer,
 * the empirical-22.4px yNudge saga. Q wants the stoplights to scale WITH the
 * UI, so the shell hides the native buttons (hide_native_traffic_lights in
 * src-tauri/src/lib.rs) and sets `window.__O8_HTML_TRAFFIC_LIGHTS__ = true`
 * via its initialization script; the strips render this component instead.
 *
 * On shells WITHOUT the flag (older installed binaries under dev-bridge, plain
 * browser dev) the exported TrafficLightsOrSpacer falls back to the legacy
 * screen-pixel spacer that clears the still-visible native lights.
 *
 * Behavior parity with native:
 * - red    → window close (the shell's CloseRequested handler hides to tray)
 * - yellow → minimize
 * - green  → toggle fullscreen; ⌥-click → toggle maximize (native semantics)
 * - hovering the GROUP shows the glyphs on all three (native behavior)
 * - window unfocused → all three flatten to a neutral grey
 */

import { useEffect, useRef, useState } from 'react';

const LIGHT = 12; // native diameter
const GAP = 8; // native 20px center spacing → 8px between edges

const COLORS = {
  close: '#FF5F57',
  minimize: '#FEBC2E',
  zoom: '#28C840',
} as const;

// Glyphs drawn dark-on-color like native. 12×12 viewBox.
const GLYPH_STROKE = 'rgba(0, 0, 0, 0.55)';

function CloseGlyph() {
  return (
    <svg width={LIGHT} height={LIGHT} viewBox="0 0 12 12" style={{ display: 'block' }} aria-hidden>
      <path d="M3.7 3.7 L8.3 8.3 M8.3 3.7 L3.7 8.3" stroke={GLYPH_STROKE} strokeWidth="1.1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function MinimizeGlyph() {
  return (
    <svg width={LIGHT} height={LIGHT} viewBox="0 0 12 12" style={{ display: 'block' }} aria-hidden>
      <path d="M2.9 6 H9.1" stroke={GLYPH_STROKE} strokeWidth="1.1" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function ZoomGlyph() {
  // The native fullscreen glyph — two solid right triangles on the diagonal.
  return (
    <svg width={LIGHT} height={LIGHT} viewBox="0 0 12 12" style={{ display: 'block' }} aria-hidden>
      <path d="M3 6.6 V3 h3.6 Z" fill={GLYPH_STROKE} />
      <path d="M9 5.4 V9 H5.4 Z" fill={GLYPH_STROKE} />
    </svg>
  );
}

function LightButton({
  kind,
  focused,
  groupHovered,
  onClick,
  label,
}: {
  kind: keyof typeof COLORS;
  focused: boolean;
  groupHovered: boolean;
  onClick: (event: React.MouseEvent) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      data-no-drag
      onClick={onClick}
      aria-label={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: LIGHT,
        height: LIGHT,
        borderRadius: LIGHT / 2,
        borderWidth: 0,
        padding: 0,
        cursor: 'default',
        flexShrink: 0,
        // Unfocused windows flatten the lights to neutral grey (native).
        // color-mix off the ink token adapts to both palettes without
        // hardcoding a surface rgba.
        background: focused ? COLORS[kind] : 'color-mix(in srgb, var(--t-text) 22%, transparent)',
        // Native lights carry a hairline darker rim so they read crisp on
        // any backdrop — inset ring, not a layout border.
        boxShadow: focused ? 'inset 0 0 0 0.5px rgba(0, 0, 0, 0.18)' : 'none',
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {groupHovered && focused ? (
        kind === 'close' ? <CloseGlyph /> : kind === 'minimize' ? <MinimizeGlyph /> : <ZoomGlyph />
      ) : null}
    </button>
  );
}

export function TrafficLights({ yNudge = 0, leadInPx = 1 }: { yNudge?: number; leadInPx?: number }) {
  const [focused, setFocused] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenRef = useRef(false);
  fullscreenRef.current = fullscreen;

  // Track window focus so the lights grey out like native ones.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const [isFocused, isFullscreen] = await Promise.all([win.isFocused(), win.isFullscreen()]);
        if (cancelled) return;
        setFocused(isFocused);
        setFullscreen(isFullscreen);
        const stop = await win.onFocusChanged(({ payload }) => setFocused(payload));
        if (cancelled) stop();
        else unlisten = stop;
      } catch {
        // Browser mode — stay "focused"; the component only mounts behind the
        // shell flag anyway.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const withWindow = async (fn: (win: Awaited<ReturnType<typeof importWindow>>) => Promise<void>) => {
    try {
      const win = await importWindow();
      await fn(win);
    } catch (err) {
      // Loud, never silent (2026-07-17 live-hit): minimize + fullscreen were
      // permission-DENIED (capabilities/default.json lacked allow-minimize /
      // allow-set-fullscreen) and this catch ate the rejection — the buttons
      // read as dead with zero trace. Browser mode still lands here benignly.
      console.warn('[traffic-lights] window verb failed:', err);
    }
  };

  return (
    <div
      data-no-drag
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: GAP,
        // Lead-in puts the first light at window-x 14 (where the native ones
        // sat). Left strip content starts at 13 → default 1; the workspace
        // strip's starts at 12 → it passes 2, so the cluster doesn't jump 1px
        // when the sidebar collapses. 7px tail + the strip's 4px gap lands
        // the sidebar toggle at its pre-DOM-lights x (77).
        paddingLeft: leadInPx,
        paddingRight: 7,
        flexShrink: 0,
        // Same nudge contract as SidebarTogglePill: the strip vertically
        // centers items, so marginTop moves the group HALF its value. Passing
        // the pill's own yNudge keeps both centers on the same line.
        marginTop: yNudge,
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      <LightButton
        kind="close"
        focused={focused}
        groupHovered={hovered}
        label="Close window"
        onClick={() => { void withWindow(async (win) => { await win.close(); }); }}
      />
      <LightButton
        kind="minimize"
        focused={focused}
        groupHovered={hovered}
        label="Minimize window"
        onClick={() => { void withWindow(async (win) => { await win.minimize(); }); }}
      />
      <LightButton
        kind="zoom"
        focused={focused}
        groupHovered={hovered}
        label={fullscreen ? 'Exit full screen' : 'Enter full screen'}
        onClick={(event) => {
          const alt = event.altKey;
          void withWindow(async (win) => {
            if (alt) {
              // ⌥-click = zoom/maximize, native semantics.
              await win.toggleMaximize();
              return;
            }
            const next = !fullscreenRef.current;
            await win.setFullscreen(next);
            setFullscreen(next);
          });
        }}
      />
    </div>
  );
}

async function importWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

/**
 * TrafficLightsOrSpacer — the strip-facing entry point. Renders the DOM
 * lights when the shell says the native ones are hidden; otherwise renders
 * the legacy screen-pixel spacer that clears the still-visible native lights
 * (sized × --zoom-inverse because native lights ignore CSS zoom).
 *
 * The flag is read after mount (initialization_script sets it before the page
 * loads, but SSR can't see it) — one frame of spacer before the lights mount
 * is invisible behind the boot loader.
 */
export function TrafficLightsOrSpacer({ yNudge = 0, leadInPx = 1 }: { yNudge?: number; leadInPx?: number }) {
  const [htmlLights, setHtmlLights] = useState(false);
  useEffect(() => {
    setHtmlLights((window as unknown as { __O8_HTML_TRAFFIC_LIGHTS__?: boolean }).__O8_HTML_TRAFFIC_LIGHTS__ === true);
  }, []);
  if (!htmlLights) {
    return <div style={{ width: 'calc(64px * var(--zoom-inverse, 1))', flexShrink: 0 }} />;
  }
  return <TrafficLights yNudge={yNudge} leadInPx={leadInPx} />;
}
