'use client';

import { motion } from 'framer-motion';
import { useChromeTooltip } from './chrome-tooltip';

/** Also registered as a global shortcut in dashboard/page.tsx — keep in sync. */
export const CANVAS_MODE_KEYBIND = '⌘⌥C';

/**
 * Canvas entry point, in the header beside the panel toggle.
 *
 * No trailing arrow (Q 2026-07-16). It carried real meaning — "this leaves the
 * view", Cursor's `IDE ↗` — but it pushed the canvas glyph off the button's
 * centre, and this button's neighbours all centre their icon. Against that
 * column the whole control read crooked. The tooltip already says where it
 * goes; the row's alignment is worth more than the hint.
 *
 * Motion per DESIGN.md §06.7 — bg + colour crossfade, no scale.
 */
export function CanvasModeButton({ onClick }: { onClick: () => void }) {
  const { ref, handlers, close, tooltip } = useChromeTooltip({
    label: 'Canvas mode',
    keybind: CANVAS_MODE_KEYBIND,
  });
  return (
    <motion.button
      ref={ref}
      type="button"
      aria-label="Canvas mode"
      onClick={() => { close(); onClick(); }}
      {...handlers}
      data-no-drag
      initial={false}
      animate="rest"
      whileHover="hover"
      variants={{
        rest: {
          background: 'var(--t-pill-rest-bg, transparent)',
          color: 'var(--t-text-secondary)',
        },
        hover: {
          background: 'var(--t-hover)',
          color: 'var(--t-text)',
        },
      }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        // 30 wide, matching RightPanelMorphButton exactly. These two swap places
        // as the header's rightmost control depending on whether the panel is
        // open, and the rightmost one carries the nudge that lands it on the
        // rail capsule's column. Equal widths mean ONE nudge works for either —
        // at 28 vs 30 they needed 5 and 4 (measured), which is two magic numbers
        // waiting to drift apart.
        minWidth: 30,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 8,
        paddingRight: 8,
        border: 'none',
        borderRadius: 7,
        cursor: 'pointer',
        flexShrink: 0,
        // Matches RightPanelMorphButton's optical lift exactly. Without it this
        // button's centre sits 1.5px below the panel toggle's (measured) — the
        // neighbour's negative margin shortens its margin box, so a plain
        // sibling rides low in the centred row.
        marginTop: -3,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {/* The canvas glyph — same rounded frame + four marks as the status bar's,
          drawn inline so it carries this button's colour, not its own. */}
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        style={{ display: 'block' }}
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="9" cy="9" r="0.5" />
        <circle cx="15" cy="9" r="0.5" />
        <circle cx="9" cy="15" r="0.5" />
        <circle cx="15" cy="15" r="0.5" />
      </svg>
      {tooltip}
    </motion.button>
  );
}
