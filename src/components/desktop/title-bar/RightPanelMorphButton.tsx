'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { IconColumns, IconGitDiff, IconPanelRightCollapse } from './icons';

export function RightPanelMorphButton({
  workspacePanelVisible,
  o8PanelVisible,
  onToggleO8Panel,
}: {
  workspacePanelVisible: boolean;
  o8PanelVisible: boolean;
  onToggleO8Panel?: () => void;
}) {
  // 3-state model kept for visual transitions, but the click action is now
  // a 2-state toggle: O8 ⇄ collapsed. The review/workspace side panel
  // surfaces (Changes / Git Log) open via repo-focus or commit clicks; the
  // header button is dedicated to O8 so first-click never lands on the
  // narrow rail by accident.
  const state: 'collapsed' | 'review' | 'o8' = o8PanelVisible
    ? 'o8'
    : workspacePanelVisible
      ? 'review'
      : 'collapsed';
  const label = state === 'collapsed' ? 'Open O8 panel' : 'Close panel';
  const handleClick = onToggleO8Panel;

  // Custom portal tooltip instead of the native `title`. This button lives in
  // the topmost header strip, so a native tooltip (or any overflow:hidden
  // ancestor) clips it off the top edge — operator saw "Open O…". We portal to
  // document.body and open DOWNWARD, right-anchored (it's the rightmost
  // control), so the label is always fully visible.
  const btnRef = useRef<HTMLButtonElement>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const [tip, setTip] = useState<{ top: number; right: number } | null>(null);

  const openTip = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTip({ top: r.bottom + 6, right: Math.max(6, window.innerWidth - r.right) });
  };
  const scheduleTip = () => {
    window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(openTip, 320);
  };
  const closeTip = () => {
    window.clearTimeout(showTimer.current);
    setTip(null);
  };
  useEffect(() => () => window.clearTimeout(showTimer.current), []);

  return (
    <motion.button
      ref={btnRef}
      type="button"
      aria-label={label}
      onClick={() => { closeTip(); handleClick?.(); }}
      onMouseEnter={scheduleTip}
      onMouseLeave={closeTip}
      onFocus={openTip}
      onBlur={closeTip}
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
        // Matched to HeaderIconPill: 26 tall, 7px radius, flat hover.
        // The state indicator is the icon morph, not the button bg.
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: 26,
        minWidth: 26,
        paddingLeft: 7,
        paddingRight: 7,
        borderRadius: 7,
        borderWidth: 0,
        cursor: 'pointer',
        flexShrink: 0,
        marginTop: -3,
        WebkitTapHighlightColor: 'transparent',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
    >
      {/* Transparent hit-extender — ~44px tall click target, visible pill
          unchanged (#1259). Upward-dominant so it never steals content clicks. */}
      <span aria-hidden style={{ position: 'absolute', top: -14, bottom: -4, left: 0, right: 0 }} />
      <span style={{ position: 'relative', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* Review (changes) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'review' ? 1 : 0,
            scale: state === 'review' ? 1 : 0.72,
            rotate: state === 'review' ? 0 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconGitDiff />
        </motion.span>
        {/* O8 (columns) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'o8' ? 1 : 0,
            scale: state === 'o8' ? 1 : 0.72,
            rotate: state === 'o8' ? 0 : state === 'review' ? 12 : -12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconColumns />
        </motion.span>
        {/* Collapsed (panel) icon */}
        <motion.span
          initial={false}
          animate={{
            opacity: state === 'collapsed' ? 1 : 0,
            scale: state === 'collapsed' ? 1 : 0.72,
            rotate: state === 'collapsed' ? 0 : 12,
          }}
          transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          style={{ position: 'absolute', inset: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IconPanelRightCollapse />
        </motion.span>
      </span>
      {tip && typeof document !== 'undefined'
        ? createPortal(
            <div
              role="tooltip"
              style={{
                position: 'fixed',
                top: tip.top,
                right: tip.right,
                zIndex: 2147483000,
                pointerEvents: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                whiteSpace: 'nowrap',
                background: 'var(--t-bg-card)',
                color: 'var(--t-text)',
                borderWidth: '0.5px',
                borderStyle: 'solid',
                borderColor: 'var(--t-border)',
                borderRadius: 8,
                paddingTop: 4,
                paddingBottom: 4,
                paddingLeft: 8,
                paddingRight: 8,
                fontFamily: 'var(--font-sans-system)',
                fontSize: 11,
                fontWeight: 400,
                lineHeight: 1.3,
                letterSpacing: '-0.1px',
                boxShadow: 'var(--t-glass-shadow, 0 8px 20px rgba(15, 23, 42, 0.22))',
              }}
            >
              <span>{label}</span>
              <span style={{ color: 'var(--t-text-muted)' }}>⌘⌥B</span>
            </div>,
            document.body,
          )
        : null}
    </motion.button>
  );
}
