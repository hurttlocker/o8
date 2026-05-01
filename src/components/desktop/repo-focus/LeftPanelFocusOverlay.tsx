'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { LeftPanelRepoFocus } from './LeftPanelRepoFocus';
import type { LeftPanelFocusState, RepoFocusDataProps } from './types';

interface LeftPanelFocusOverlayProps extends RepoFocusDataProps {
  focus: LeftPanelFocusState;
}

// Nav rail was retired — AgentPanel docks at left: 0 directly below the
// 44px TitleBar. The focus drawer covers the AgentPanel column AND
// extends 200px past it; the parent panel content is hidden via
// visibility:hidden in AgentPanel while focus is active so we don't
// double-render the multi-repo column underneath.
const PANEL_WIDTH = 440;
const TITLE_BAR_HEIGHT = 44;

export function LeftPanelFocusOverlay({
  focus,
  packets,
  missionState,
  ideWorkspaceSessions,
  activeSessionKey,
  onSelectSession,
  onSelectFile,
  onOpenSpecInWorkspace,
}: LeftPanelFocusOverlayProps) {
  const reducedMotion = useReducedMotion();
  const repo = focus.focusedRepo;
  // Portal target — keeps the overlay outside the AgentPanel column's
  // overflow:hidden so the 440px detail surface can extend past the
  // narrow rail without getting clipped. SSR-safe via the mounted gate.
  const [mounted, setMounted] = useState(false);
  // The portal target only exists after hydration; this gate prevents SSR
  // access to document while preserving the existing drawer animation.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setMounted(true); }, []);

  const content = (
    <AnimatePresence initial={false}>
      {repo ? (
        <motion.div
          key={repo.localPath}
          initial={reducedMotion ? { opacity: 1 } : { x: -PANEL_WIDTH }}
          animate={reducedMotion ? { opacity: 1 } : { x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { x: -PANEL_WIDTH }}
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
          style={{
            // Solid background so the drawer doesn't bleed the vibrancy
            // backdrop or the multi-repo column behind it. var(--t-bg) is
            // intentionally 62% opaque to mix with vibrancy — wrong for a
            // detail surface that needs to read as a discrete plane. We
            // pin to the dark / paper neutrals directly via the theme's
            // canvas token (added below if missing).
            position: 'fixed',
            top: TITLE_BAR_HEIGHT,
            bottom: 0,
            left: 0,
            width: PANEL_WIDTH,
            zIndex: 60,
            display: 'flex',
            background: 'var(--t-canvas-bg, var(--t-chat-surface-bg, #1a1e24))',
            borderRight: '1px solid var(--t-divider)',
            boxShadow: '4px 0 24px rgba(0, 0, 0, 0.28)',
          } as React.CSSProperties}
        >
          <LeftPanelRepoFocus
            repo={repo}
            onBack={focus.clearFocus}
            packets={packets}
            missionState={missionState}
            ideWorkspaceSessions={ideWorkspaceSessions}
            activeSessionKey={activeSessionKey}
            onSelectSession={onSelectSession}
            onSelectFile={onSelectFile}
            onOpenSpecInWorkspace={onOpenSpecInWorkspace}
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}
