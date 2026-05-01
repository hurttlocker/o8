'use client';

import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { LeftPanelRepoFocus } from './LeftPanelRepoFocus';
import type { LeftPanelFocusState, RepoFocusDataProps } from './types';

interface LeftPanelFocusOverlayProps extends RepoFocusDataProps {
  focus: LeftPanelFocusState;
}

export function LeftPanelFocusOverlay({
  focus,
  packets,
  missionState,
  ideWorkspaceSessions,
  activeSessionKey,
  onSelectSession,
}: LeftPanelFocusOverlayProps) {
  const reducedMotion = useReducedMotion();
  const repo = focus.focusedRepo;

  return (
    <AnimatePresence initial={false}>
      {repo ? (
        <motion.div
          key={repo.localPath}
          initial={reducedMotion ? { opacity: 1 } : { x: '100%' }}
          animate={reducedMotion ? { opacity: 1 } : { x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { x: '100%' }}
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 400, damping: 30 }}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 4,
            display: 'flex',
            minHeight: '100%',
            overflow: 'hidden',
            background: 'var(--t-panel)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
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
          />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
