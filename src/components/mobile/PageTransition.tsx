'use client';

import type { ReactNode } from 'react';

interface PageTransitionProps {
  activeKey: string;
  children: ReactNode;
}

/**
 * Crossfade + subtle slide transition between pages.
 * Renders current page immediately, fades out previous.
 */
export function PageTransition({ activeKey, children }: PageTransitionProps) {
  return (
    <div
      key={activeKey}
      style={{
        animation: 'page-transition-in 280ms cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      <style>{`@keyframes page-transition-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      {children}
    </div>
  );
}
