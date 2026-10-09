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
 * This primitive owns the portal, focus, anchor-rect
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
  /** Called once per open after the portal is positioned and visible. */
  onOpenReady?: () => void;
  /** Horizontal anchoring: 'end' right-aligns to the trigger, 'start' left-aligns. */
  align?: 'start' | 'end';
  children: ReactNode;
}

// Shared layer for every composer popover — matches the existing chip menus so
// they all stack consistently. Bump in ONE place if the layer ever moves.
const COMPOSER_OVERLAY_Z = 1000;
const GAP = 8;
const EDGE = 12;
const FOCUSABLE = 'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
const MENU_ITEM = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

function focusTrigger(anchor: HTMLElement | null) {
  const trigger = anchor?.matches(FOCUSABLE) ? anchor : anchor?.querySelector<HTMLElement>(FOCUSABLE);
  trigger?.focus({ preventScroll: true });
}

export function ComposerPopover({ anchorRef, open, onClose, onOpenReady, align = 'end', children }: ComposerPopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef(true);
  const focusedControlRef = useRef<HTMLElement | null>(null);
  // Keep onClose out of the effect deps so an inline arrow from the consumer
  // doesn't re-run the whole listener setup on every render.
  const onCloseRef = useRef(onClose);
  const onOpenReadyRef = useRef(onOpenReady);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    onOpenReadyRef.current = onOpenReady;
  }, [onClose, onOpenReady]);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    restoreFocusRef.current = true;
    focusedControlRef.current = null;
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    return () => {
      // React can remove the portal before layout cleanup. In that case the
      // browser has moved focus to body; remember which removed control owned it.
      const removedFocus = document.activeElement === document.body && focusedControlRef.current && !focusedControlRef.current.isConnected;
      if (restoreFocusRef.current && (panel?.contains(document.activeElement) || removedFocus)) focusTrigger(anchor);
    };
  }, [open, anchorRef]);

  const ready = open && pos !== null;
  useLayoutEffect(() => {
    if (!ready) return;
    onOpenReadyRef.current?.();
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    const target = panel.querySelector<HTMLElement>('input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), select:not(:disabled)')
      ?? panel.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled):not([aria-disabled="true"])')
      ?? panel.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }, [ready]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    if (!anchor) return;

    const place = () => {
      const root = document.documentElement;
      const configuredZoom = Number.parseFloat(getComputedStyle(root).getPropertyValue('--ui-zoom'));
      const zoom = Number.isFinite(configuredZoom) && configuredZoom > 0 ? configuredZoom : 1;
      const rect = anchor.getBoundingClientRect();
      // Rects are scaled screen pixels; fixed offsets and measured panel sizes
      // are document pixels under the root UI zoom. Keep one coordinate space.
      const a = { left: rect.left / zoom, right: rect.right / zoom, top: rect.top / zoom, bottom: rect.bottom / zoom };
      const viewportWidth = window.innerWidth / zoom;
      const viewportHeight = window.innerHeight / zoom;
      const panel = panelRef.current;
      const panelH = panel?.offsetHeight ?? 0;
      const panelW = panel?.offsetWidth ?? 0;
      // Open upward by default (composer sits at the viewport bottom); only
      // drop down when there genuinely isn't room above.
      const openUp = a.top >= panelH + GAP || a.top >= viewportHeight - a.bottom;
      const preferredTop = openUp ? a.top - panelH - GAP : a.bottom + GAP;
      const top = Math.max(EDGE, Math.min(preferredTop, viewportHeight - panelH - EDGE));
      const rawLeft = align === 'end' ? a.right - panelW : a.left;
      const left = Math.max(EDGE, Math.min(rawLeft, viewportWidth - panelW - EDGE));
      setPos((current) => current?.left === left && current.top === top ? current : { left, top });
    };

    place(); // measure-then-place: panel starts hidden off-screen, no flash
    const ro = new ResizeObserver(place);
    ro.observe(anchor); // composer grows when an image is attached → re-place
    if (panelRef.current) ro.observe(panelRef.current); // content height settles
    window.addEventListener('scroll', place, true); // capture: catch transcript scroll
    window.addEventListener('resize', place);
    // CSS zoom does not consistently emit resize or change observed layout size.
    const zoomObserver = new MutationObserver(place);
    zoomObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchor.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      restoreFocusRef.current = false;
      onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const panel = panelRef.current;
      const target = event.target;
      const inPanel = target instanceof Node && panel?.contains(target);
      if (event.key === 'Escape') {
        if (!inPanel && !(target instanceof Node && anchor.contains(target))) return;
        event.preventDefault();
        focusTrigger(anchor);
        onCloseRef.current();
        return;
      }
      if (!inPanel || !(target instanceof HTMLElement) || !target.matches(MENU_ITEM)) return;
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const menu = target.closest('[role="menu"]');
      if (!menu) return;
      const items = Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM))
        .filter((item) => !item.matches(':disabled, [aria-disabled="true"]'));
      if (!items.length) return;
      const index = items.indexOf(target);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      event.preventDefault();
      items[next].focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);

    return () => {
      ro.disconnect();
      zoomObserver.disconnect();
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
      onFocusCapture={(event) => { focusedControlRef.current = event.target; }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) focusedControlRef.current = null;
      }}
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
