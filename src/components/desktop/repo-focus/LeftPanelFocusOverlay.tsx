'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const repo = focus.focusedRepo;
  // Portal target — keeps the overlay outside the AgentPanel column's
  // overflow:hidden so the 440px detail surface can extend past the
  // narrow rail without getting clipped. SSR-safe via the mounted gate.
  const [mounted, setMounted] = useState(false);
  // SSR-safe portal gate. setMounted in useEffect runs only on the client;
  // the framer-motion entry animation needs the element in the tree from
  // first client paint or AnimatePresence's `initial={false}` swallows the
  // slide-in and the drawer appears stuck offscreen.
  useEffect(() => { setMounted(true); }, []);

  const content = repo ? (
    <div
      key={repo.localPath}
      style={{
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
        // No entry animation for now — framer-motion + portal interaction
        // under React 19 was leaving the drawer stuck at the initial frame.
        // Discrete appearance is reliable.
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
    </div>
  ) : null;

  if (!mounted || typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}
