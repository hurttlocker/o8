'use client';

import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { NavSection } from '@/app/dashboard/types';

export function useSettingsOverlayDismiss({
  activeNavSection,
  panelRef,
  setActiveNavSection,
}: {
  activeNavSection: NavSection;
  panelRef: RefObject<HTMLDivElement | null>;
  setActiveNavSection: Dispatch<SetStateAction<NavSection>>;
}) {
  const closeSettingsOverlay = useCallback(() => {
    setActiveNavSection((current) => current === 'settings' ? 'agents' : current);
  }, [setActiveNavSection]);

  const toggleSettingsOverlay = useCallback(() => {
    setActiveNavSection((current) => current === 'settings' ? 'agents' : 'settings');
  }, [setActiveNavSection]);

  useEffect(() => {
    if (activeNavSection !== 'settings') return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      const targetElement = target instanceof Element ? target : null;
      if (targetElement?.closest('[aria-label="Settings"]')) return;
      // Settings pickers portal to document.body, so they sit outside panelRef
      // and this capture-phase handler used to close the whole overlay on the
      // first click into a menu -- which read as "the setting will not change".
      // Any portaled settings surface opts back in with this attribute (#1685).
      if (targetElement?.closest('[data-o8-settings-portal]')) return;
      const panel = panelRef.current;
      if (panel && target && panel.contains(target)) return;
      closeSettingsOverlay();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeSettingsOverlay();
    };

    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [activeNavSection, closeSettingsOverlay, panelRef]);

  return {
    closeSettingsOverlay,
    toggleSettingsOverlay,
  };
}
