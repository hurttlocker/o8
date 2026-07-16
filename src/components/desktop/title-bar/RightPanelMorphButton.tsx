'use client';

import { motion } from 'framer-motion';
import { IconColumns, IconGitDiff, IconPanelRightCollapse } from './icons';
import { useChromeTooltip } from './chrome-tooltip';

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

  const { ref: btnRef, handlers: tipHandlers, close: closeTip, tooltip } = useChromeTooltip({
    label,
    keybind: '⌘⌥B',
  });

  return (
    <motion.button
      ref={btnRef}
      type="button"
      aria-label={label}
      onClick={() => { closeTip(); handleClick?.(); }}
      {...tipHandlers}
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
      {tooltip}
    </motion.button>
  );
}
