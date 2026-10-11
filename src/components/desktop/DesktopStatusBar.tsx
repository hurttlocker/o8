'use client';

/**
 * DesktopStatusBar — the optional View-as-free development indicator.
 *
 * Uses the composer slot when available without reserving a workspace footer.
 */

import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ParkedLane } from './merge-beacon/derive';
import { ViewAsFreeIndicator } from './ViewAsFreeIndicator';
import { getRegisteredComposerCenter, subscribeToComposerCenter } from './composer-center-registry';
import { useEntitlement } from '@/lib/entitlement/context';

interface DesktopStatusBarProps {
  /** Retained for the caller; merge state is no longer displayed in this chrome. */
  branchName: string | null;
  repoName: string | null;
  repoRemoteUrl?: string | null;
  defaultBranch?: string | null;
  /** Width of the right panel column when visible, in CSS px. */
  rightColumnWidth?: number;
  /** Narrow desktop mode: keep durable status text and collapse action chrome. */
  compact?: boolean;
  /** Glass surface active: leave the left utility rail transparent. */
  glassSurface?: boolean;
  parkedLanes?: ParkedLane[];
  onOpenReviewLane?: (lane: ParkedLane) => void;
  onOpenAwaitingMerge?: () => void;
}

function DesktopStatusBarBase({
  compact = false,
}: DesktopStatusBarProps) {
  const { overrideActive } = useEntitlement();

  // The composer card registers its status slot so small utility controls can
  // follow it without painting a second bar underneath the input.
  const [composerSlot, setComposerSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    const measure = () => {
      const el = getRegisteredComposerCenter();
      const slot = el?.closest<HTMLElement>('[data-o8-composer-root]')?.querySelector<HTMLElement>('[data-o8-composer-status-slot]') ?? null;
      setComposerSlot((prev) => prev === slot ? prev : slot);
    };
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(measure);
    };
    const unsubscribe = subscribeToComposerCenter(schedule);
    schedule();
    window.addEventListener('resize', schedule);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
      unsubscribe();
    };
  }, []);

  if (!overrideActive || compact) return null;

  if (composerSlot) {
    return createPortal(
      <div data-o8-composer-chrome="" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
        <ViewAsFreeIndicator palette="chrome" />
      </div>,
      composerSlot,
    );
  }

  return (
    <div data-mcp-scope="desktop-status-bar" style={{ position: 'absolute', right: 12, bottom: 6, zIndex: 190 }}>
      <ViewAsFreeIndicator palette="chrome" />
    </div>
  );
}

export const DesktopStatusBar = memo(DesktopStatusBarBase);
