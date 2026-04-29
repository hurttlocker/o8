'use client';

/**
 * MobileBrowserTabRoot — wraps the existing MobileSplitShell behind an
 * explicit Browser tab in the mobile bottom nav (closes #786).
 *
 * Behavior contract:
 *   - On mount, attempt `screen.orientation.lock('landscape')` (best-effort,
 *     wrapped in try/catch — never throws, never blocks render).
 *   - On unmount, attempt `screen.orientation.unlock()` (same try/catch).
 *   - In landscape, mount MobileSplitShell as-is — children become the left
 *     pane, DevHostFrame ships on the right (the existing #779 layout).
 *   - In portrait, render a dismissible banner ("Rotate to landscape") +
 *     a vertical stack of children (chat) on top and the iframe below.
 *     Banner dismissal persists to localStorage.
 *
 * What we don't do:
 *   - Modify MobileSplitShell.tsx, DevHostFrame.tsx, landscape-controller.ts,
 *     or url-push-listener.ts. They stay exactly as #779/#781/#782 shipped.
 *
 * Hard rules honored:
 *   - inline styles only / palette tokens for surfaces
 *   - Plus Jakarta Sans for chrome; Phosphor SVG drawn inline
 *   - 100dvh + safe-area-inset-* iOS-safe layout
 *   - File ceiling 800 lines (this file is well under)
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { MobileSplitShell } from './MobileSplitShell';
import { useLandscapeSplit } from './landscape-controller';
import { DevHostFrame } from './DevHostFrame';
import { useMobileUrlPushListener } from './url-push-listener';

const FONT_STACK = '"Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const HINT_DISMISSED_KEY = 'o8:mobile-browser:landscape-hint-dismissed';

// Shape of `screen.orientation` that we touch. The DOM lib types ship a
// readonly OrientationLockType union; declaring a narrowed shape here lets
// us call `.lock()` / `.unlock()` without ts-ignoring the call sites and
// keeps the try/catch tight.
interface OrientationLockTarget {
  lock?: (orientation: 'landscape') => Promise<void>;
  unlock?: () => void;
}

function getOrientationTarget(): OrientationLockTarget | null {
  if (typeof window === 'undefined') return null;
  // `screen.orientation` is missing on iOS Safari < 16.4 and inside locked
  // PWA chrome — we treat both as no-op surfaces.
  const candidate = (window.screen as unknown as { orientation?: OrientationLockTarget }).orientation;
  return candidate ?? null;
}

function attemptLandscapeLock(): void {
  const target = getOrientationTarget();
  if (!target?.lock) return;
  try {
    const promise = target.lock('landscape');
    if (promise && typeof promise.catch === 'function') {
      // Lock can reject in non-fullscreen PWAs / Safari — swallow silently.
      promise.catch(() => undefined);
    }
  } catch {
    // Some browsers throw synchronously. Best-effort means best-effort.
  }
}

function attemptOrientationUnlock(): void {
  const target = getOrientationTarget();
  if (!target?.unlock) return;
  try {
    target.unlock();
  } catch {
    // Same swallow rule — never block tab teardown.
  }
}

function readHintDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(HINT_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeHintDismissed(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(HINT_DISMISSED_KEY, '1');
    } else {
      window.localStorage.removeItem(HINT_DISMISSED_KEY);
    }
  } catch {
    // Storage may be disabled — swallow.
  }
}

interface MobileBrowserTabRootProps {
  children: ReactNode;
  onBack?: () => void;
}

export function MobileBrowserTabRoot({ children, onBack }: MobileBrowserTabRootProps) {
  const { isSplit } = useLandscapeSplit();
  const [hintDismissed, setHintDismissed] = useState<boolean>(() => readHintDismissed());

  // Fire-and-forget orientation lock. The actual lock might be denied by
  // Safari / iOS PWA — if it succeeds the user feels snappy, if it fails
  // the hint banner picks up the slack.
  useEffect(() => {
    attemptLandscapeLock();
    return () => {
      attemptOrientationUnlock();
    };
  }, []);

  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    writeHintDismissed(true);
  }, []);

  if (isSplit) {
    // Landscape — defer entirely to MobileSplitShell. It already paints the
    // chat-left + DevHostFrame-right layout, handles drag-resize, and owns
    // the URL-push WS listener inside its inner SplitLayout component (so
    // we don't open a second WebSocket in this branch).
    return <MobileSplitShell>{children}</MobileSplitShell>;
  }

  // Portrait fallback — vertical stack: chat on top, iframe below, with an
  // optional hint banner offering rotation. Dismissal is sticky so the
  // user only ever sees it once. We mount the URL-push listener inside the
  // fallback (and not at the root of MobileBrowserTabRoot) so we don't open
  // a duplicate WS to the one MobileSplitShell already opens in landscape.
  return (
    <PortraitFallback
      hintDismissed={hintDismissed}
      onDismissHint={dismissHint}
      onBack={onBack}
    >
      {children}
    </PortraitFallback>
  );
}

interface PortraitFallbackProps {
  children: ReactNode;
  hintDismissed: boolean;
  onDismissHint: () => void;
  onBack?: () => void;
}

function PortraitFallback({ children, hintDismissed, onDismissHint, onBack }: PortraitFallbackProps) {
  // Subscribe to send-to-mobile URL pushes (#782) so the iframe re-points
  // when desktop fires a long-press push. We mount it here (instead of at
  // the MobileBrowserTabRoot level) because in landscape MobileSplitShell
  // already opens its own listener, and we don't want two WebSockets per
  // device.
  useMobileUrlPushListener();

  // We use a fixed full-viewport container so the chat surface and iframe
  // live in their own scroll/positioning contexts. iOS dynamic viewport is
  // covered by 100dvh with a 100vh fallback for older Safaris. The top
  // padding leaves room for the floating TopBar (44px button + 8px offset
  // above safe-area), so the hint banner and chat pane don't slide under
  // it.
  const containerStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    height: '100dvh',
    minHeight: '100vh',
    width: '100vw',
    display: 'grid',
    gridTemplateRows: hintDismissed ? '1fr 1fr' : 'auto 1fr 1fr',
    background: 'var(--t-bg, #111111)',
    paddingTop: 'calc(env(safe-area-inset-top, 0px) + 64px)',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    paddingLeft: 'env(safe-area-inset-left, 0px)',
    paddingRight: 'env(safe-area-inset-right, 0px)',
    isolation: 'isolate',
    overflow: 'hidden',
  };

  const chatPaneStyle: CSSProperties = {
    position: 'relative',
    minHeight: 0,
    overflow: 'hidden',
    transform: 'translateZ(0)',
    isolation: 'isolate',
  };

  const iframePaneStyle: CSSProperties = {
    position: 'relative',
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--t-panel, rgba(30,28,26,0.82))',
    color: 'var(--t-text, #FAF5F0)',
    borderTop: '1px solid var(--t-border, rgba(255,248,240,0.08))',
    transform: 'translateZ(0)',
  };

  return (
    <div style={containerStyle}>
      {hintDismissed ? null : (
        <RotateHintBanner onDismiss={onDismissHint} onBack={onBack} />
      )}
      <div style={chatPaneStyle}>{children}</div>
      <div style={iframePaneStyle}>
        <DevHostFrame />
      </div>
    </div>
  );
}

interface RotateHintBannerProps {
  onDismiss: () => void;
  onBack?: () => void;
}

function RotateHintBanner({ onDismiss, onBack }: RotateHintBannerProps) {
  const wrapStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    margin: '8px 12px 0',
    borderRadius: 12,
    background: 'var(--t-bg-card, rgba(46,42,38,0.62))',
    border: '1px solid var(--t-border, rgba(255,248,240,0.10))',
    color: 'var(--t-text, #FAF5F0)',
    fontFamily: FONT_STACK,
  };

  const iconWrapStyle: CSSProperties = {
    width: 28,
    height: 28,
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    color: 'var(--t-text-muted, rgba(255,248,240,0.62))',
  };

  const textStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 1.35,
    letterSpacing: '-0.01em',
  };

  const buttonRowStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
  };

  const baseChipStyle: CSSProperties = {
    minHeight: 32,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid var(--t-border, rgba(255,248,240,0.10))',
    background: 'transparent',
    color: 'var(--t-text, #FAF5F0)',
    fontFamily: FONT_STACK,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '-0.01em',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  };

  return (
    <div style={wrapStyle} role="status" aria-live="polite">
      <span style={iconWrapStyle} aria-hidden="true">
        {/* Phosphor "DeviceMobile" tilt — drawn inline. */}
        <svg
          viewBox="0 0 256 256"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="14"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect
            x="56"
            y="32"
            width="144"
            height="192"
            rx="16"
            transform="rotate(15 128 128)"
          />
          <line x1="100" y1="208" x2="156" y2="208" transform="rotate(15 128 128)" />
        </svg>
      </span>
      <span style={textStyle}>Rotate to landscape for the split view</span>
      <span style={buttonRowStyle}>
        {onBack ? (
          <button type="button" onClick={onBack} style={baseChipStyle} aria-label="Back to chat">
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          style={baseChipStyle}
          aria-label="Dismiss rotation hint"
        >
          Got it
        </button>
      </span>
    </div>
  );
}
