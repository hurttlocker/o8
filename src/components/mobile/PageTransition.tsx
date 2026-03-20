'use client';

import { useState, useEffect, useRef, type ReactNode } from 'react';

interface PageTransitionProps {
  activeKey: string;
  children: ReactNode;
}

/**
 * Crossfade + subtle slide transition between pages.
 * Renders current page immediately, fades out previous.
 */
export function PageTransition({ activeKey, children }: PageTransitionProps) {
  const [displayKey, setDisplayKey] = useState(activeKey);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const prevKeyRef = useRef(activeKey);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (activeKey === prevKeyRef.current) return;

    // Start exit
    setPhase('out');

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      // Swap content
      setDisplayKey(activeKey);
      prevKeyRef.current = activeKey;
      setPhase('in');

      // Clear enter animation
      timeoutRef.current = setTimeout(() => {
        setPhase('idle');
      }, 280);
    }, 150);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [activeKey]);

  const style: React.CSSProperties = {
    transition: phase === 'idle' ? 'none' : 'all 280ms cubic-bezier(0.32, 0.72, 0, 1)',
    opacity: phase === 'out' ? 0 : 1,
    transform: phase === 'out'
      ? 'translateY(-6px)'
      : phase === 'in'
        ? 'translateY(0)'
        : 'none',
  };

  return (
    <div style={style}>
      {children}
    </div>
  );
}
