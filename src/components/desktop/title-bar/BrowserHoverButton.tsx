'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';

// BrowserHoverButton — the TitleBar's globe button. Click acts the same as
// a normal chrome chip (open the wide O8 panel, focus its Browser tab),
// but hovering reveals a small floating iframe popover anchored beneath
// the button so you can peek at the running app without losing your
// workspace tab. Delays in/out keep the popover from flashing on
// incidental mouse-throughs.
const BROWSER_HOVER_OPEN_DELAY_MS = 220;
const BROWSER_HOVER_CLOSE_DELAY_MS = 160;
const BROWSER_HOVER_WIDTH = 480;
const BROWSER_HOVER_HEIGHT = 320;

function IconGlobeSimple({ size = 16, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      style={{ display: 'block', width: size, height: size, flexShrink: 0 }}
      aria-hidden="true"
    >
      <path d="M128,20A108,108,0,1,0,236,128,108.12,108.12,0,0,0,128,20Zm83.13,96H179.56a144.3,144.3,0,0,0-21.35-66.36A84.22,84.22,0,0,1,211.13,116ZM128,207c-9.36-10.81-24.46-33.13-27.45-67h54.94a119.74,119.74,0,0,1-17.11,52.77A108.61,108.61,0,0,1,128,207Zm-27.45-91a119.74,119.74,0,0,1,17.11-52.77A108.61,108.61,0,0,1,128,49c9.36,10.81,24.46,33.13,27.45,67ZM97.79,49.64A144.3,144.3,0,0,0,76.44,116H44.87A84.22,84.22,0,0,1,97.79,49.64ZM44.87,140H76.44a144.3,144.3,0,0,0,21.35,66.36A84.22,84.22,0,0,1,44.87,140Zm113.34,66.36A144.3,144.3,0,0,0,179.56,140h31.57A84.22,84.22,0,0,1,158.21,206.36Z" />
    </svg>
  );
}

export function BrowserHoverButton({
  active,
  url,
  onClick,
}: {
  active: boolean;
  url: string | null | undefined;
  onClick?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    if (open) return;
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => {
      if (buttonRef.current) {
        setAnchorRect(buttonRef.current.getBoundingClientRect());
      }
      setOpen(true);
      openTimerRef.current = null;
    }, BROWSER_HOVER_OPEN_DELAY_MS);
  }, [open]);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, BROWSER_HOVER_CLOSE_DELAY_MS);
  }, []);

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, []);

  const popoverLeft = anchorRect
    ? Math.max(8, Math.min(anchorRect.right - BROWSER_HOVER_WIDTH, window.innerWidth - BROWSER_HOVER_WIDTH - 8))
    : 8;
  const popoverTop = anchorRect ? anchorRect.bottom + 6 : 50;

  return (
    <span
      onMouseEnter={scheduleOpen}
      onMouseLeave={scheduleClose}
      style={{ display: 'inline-flex', position: 'relative' }}
    >
      <motion.button
        ref={buttonRef}
        type="button"
        aria-label="Browser"
        title="Browser"
        onClick={() => {
          // Click commits — close the hover popover so the wide panel slot
          // isn't double-rendering the same iframe for a frame.
          clearOpenTimer();
          setOpen(false);
          onClick?.();
        }}
        initial={false}
        animate={active ? 'active' : 'rest'}
        whileHover="hover"
        variants={{
          rest: {
            background: 'var(--t-chrome-btn-bg)',
            boxShadow: 'var(--t-chrome-btn-shadow)',
            color: 'var(--t-text-secondary)',
          },
          hover: {
            background: 'var(--t-chrome-btn-hover-bg)',
            boxShadow: 'var(--t-chrome-btn-hover-shadow)',
            color: 'var(--t-text)',
          },
          active: {
            background: 'var(--t-chrome-btn-active-bg)',
            boxShadow: 'var(--t-chrome-btn-active-shadow)',
            color: 'var(--t-brand-orange, #FF5A1F)',
          },
        }}
        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          padding: 0,
          border: 'none',
          borderRadius: 7,
          cursor: 'pointer',
          flexShrink: 0,
          WebkitTapHighlightColor: 'transparent',
          ['WebkitAppRegion' as string]: 'no-drag',
        }}
      >
        <motion.span
          variants={{
            rest: { opacity: 1 },
            hover: { opacity: 1 },
            active: { opacity: 1 },
          }}
          transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: 'inline-flex' }}
        >
          <IconGlobeSimple size={16} color={active ? 'var(--t-brand-orange, #FF5A1F)' : 'currentColor'} />
        </motion.span>
      </motion.button>
      {open && typeof document !== 'undefined' ? createPortal(
        <div
          onMouseEnter={() => { clearCloseTimer(); }}
          onMouseLeave={scheduleClose}
          style={{
            position: 'fixed',
            top: popoverTop,
            left: popoverLeft,
            width: BROWSER_HOVER_WIDTH,
            height: BROWSER_HOVER_HEIGHT,
            borderRadius: 12,
            border: '1px solid var(--t-panel-border)',
            background: 'var(--t-panel-solid)',
            boxShadow: 'var(--t-panel-shadow)',
            overflow: 'hidden',
            zIndex: 9200,
            display: 'flex',
            flexDirection: 'column',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 8,
              paddingRight: 10,
              paddingBottom: 8,
              paddingLeft: 12,
              borderBottom: '1px solid var(--t-divider-subtle)',
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--t-text)',
            }}
          >
            <IconGlobeSimple size={12} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--t-text-muted)',
                fontFamily: '"SF Mono", ui-monospace, monospace',
                fontSize: 10.5,
                fontWeight: 500,
              }}
            >
              {url ?? 'No active preview'}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, background: 'var(--t-canvas-bg)' }}>
            {url ? (
              <iframe
                src={url}
                title="Browser preview"
                sandbox="allow-scripts allow-same-origin allow-forms"
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  display: 'block',
                }}
              />
            ) : (
              <div style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--t-text-muted)',
                fontSize: 12,
              }}>
                Open the Browser panel to start a preview
              </div>
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
