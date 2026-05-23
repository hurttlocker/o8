'use client';

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
  const panelOpen = state !== 'collapsed';
  const label = panelOpen ? 'Close panel' : 'Open O8 panel';
  const handleClick = onToggleO8Panel;
  const restBackground = 'var(--t-chrome-btn-bg)';
  const hoverBackground = 'var(--t-chrome-btn-hover-bg)';
  const activeBackground = 'var(--t-chrome-btn-active-bg)';
  const restShadow = 'var(--t-chrome-btn-shadow)';
  const hoverShadow = 'var(--t-chrome-btn-hover-shadow)';
  const activeShadow = 'var(--t-chrome-btn-active-shadow)';

  return (
    <motion.button
      type="button"
      aria-label={label}
      title={`${label} (⌘⌥B)`}
      onClick={handleClick}
      initial={false}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 7,
        background: panelOpen ? activeBackground : restBackground,
        boxShadow: panelOpen ? activeShadow : restShadow,
        color: panelOpen ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        WebkitTapHighlightColor: 'transparent',
        transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1)',
        ['WebkitAppRegion' as string]: 'no-drag',
      }}
      onMouseEnter={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = hoverBackground;
          e.currentTarget.style.boxShadow = hoverShadow;
        }
      }}
      onMouseLeave={(e) => {
        if (!panelOpen) {
          e.currentTarget.style.background = restBackground;
          e.currentTarget.style.boxShadow = restShadow;
        }
      }}
    >
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
    </motion.button>
  );
}
