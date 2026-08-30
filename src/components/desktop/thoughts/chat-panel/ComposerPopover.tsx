'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * ComposerPopover — the ONE way a composer control opens a floating panel.
 *
 * Why this exists: the composer card is `overflow: hidden` (it clips its own
 * rounded corners + the attachment thumbnail strip). Any popover positioned
 * *inside* that card with `position: absolute` gets clipped by the rim and
 * reads as a detached, half-cut layer (the file-attach panel bug, 2026-06-15).
 * Portaling to document.body is the only escape that is immune to EVERY
 * ancestor's overflow (the chat transcript above the composer is itself a
 * scroll container, so merely dropping the card's overflow would not help).
 *
 * This primitive is positional-only: it owns the portal, anchor-rect
 * positioning (with a viewport-bottom-aware up-flip — the composer lives at
 * the bottom, so menus open upward by default), the shared z-layer, and the
 * click-outside / Escape / scroll-resize lifecycle. Consumers bring their own
 * panel chrome (border / background / radius / shadow) as `children`, so each
 * keeps its exact look while sharing one correct layering path.
 *
 * Convention (the "never clip again" rule): composer popovers go through here.
 * A hand-rolled `position: absolute` panel inside the row will clip — don't.
 */
interface ComposerPopoverProps {
  /** The trigger element the panel anchors to (the button that opened it). */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  /** Horizontal anchoring: 'end' right-aligns to the trigger, 'start' left-aligns. */
  align?: 'start' | 'end';
  children: ReactNode;
}

// Shared layer for every composer popover — matches the existing chip menus so
// they all stack consistently. Bump in ONE place if the layer ever moves.
const COMPOSER_OVERLAY_Z = 1000;
const GAP = 8;
const EDGE = 12;

export function ComposerPopover({ anchorRef, open, onClose, align = 'end', children }: ComposerPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Keep onClose out of the effect deps so an inline arrow from the consumer
  // doesn't re-run the whole listener setup on every render.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const panel = panelRef.current;
      const panelH = panel?.offsetHeight ?? 0;
      const panelW = panel?.offsetWidth ?? 0;
      // Open upward by default (composer sits at the viewport bottom); only
      // drop down when there genuinely isn't room above.
      const openUp = a.top >= panelH + GAP || a.top >= window.innerHeight - a.bottom;
      const top = openUp ? Math.max(EDGE, a.top - panelH - GAP) : a.bottom + GAP;
      const rawLeft = align === 'end' ? a.right - panelW : a.left;
      const left = Math.max(EDGE, Math.min(rawLeft, window.innerWidth - panelW - EDGE));
      setPos({ left, top });
    };

    place(); // measure-then-place: panel starts hidden off-screen, no flash
    const ro = new ResizeObserver(place);
    ro.observe(anchor); // composer grows when an image is attached → re-place
    if (panelRef.current) ro.observe(panelRef.current); // content height settles
    window.addEventListener('scroll', place, true); // capture: catch transcript scroll
    window.addEventListener('resize', place);

    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);

    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, anchorRef, align]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      data-composer-overlay=""
      style={{
        position: 'fixed',
        left: pos ? pos.left : -9999,
        top: pos ? pos.top : -9999,
        zIndex: COMPOSER_OVERLAY_Z,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
