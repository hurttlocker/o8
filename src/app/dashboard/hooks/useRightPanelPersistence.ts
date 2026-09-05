'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export type RightPanelKind = 'review' | 'o8';

const RIGHT_PANEL_VISIBLE_KEY = 'o8:right-panel:visible';
const RIGHT_PANEL_KIND_KEY = 'o8:right-panel:kind';

export function useRightPanelPersistence({
  chatVisible,
  rightPanelKind,
  setChatVisible,
  setRightPanelKind,
  suspendVisiblePersistence = false,
}: {
  chatVisible: boolean;
  rightPanelKind: RightPanelKind;
  setChatVisible: Dispatch<SetStateAction<boolean>>;
  setRightPanelKind: Dispatch<SetStateAction<RightPanelKind>>;
  suspendVisiblePersistence?: boolean;
}) {
  // Persistence starts only after the mount effect has applied the saved
  // values, otherwise the SSR-safe defaults can overwrite them during the
  // first effect pass.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let savedVisible = false;
    let savedKind: RightPanelKind = 'o8';
    try {
      const visible = window.localStorage.getItem(RIGHT_PANEL_VISIBLE_KEY);
      const kind = window.localStorage.getItem(RIGHT_PANEL_KIND_KEY);
      savedVisible = visible === '1';
      if (kind === 'o8' || kind === 'review') savedKind = kind;
    } catch { /* ignore */ }
    queueMicrotask(() => {
      if (cancelled) return;
      setChatVisible(savedVisible);
      setRightPanelKind(savedKind);
      setHydrated(true);
    });
    return () => { cancelled = true; };
  }, [setChatVisible, setRightPanelKind]);

  useEffect(() => {
    if (!hydrated || suspendVisiblePersistence) return;
    try {
      window.localStorage.setItem(RIGHT_PANEL_VISIBLE_KEY, chatVisible ? '1' : '0');
    } catch { /* ignore */ }
  }, [chatVisible, hydrated, suspendVisiblePersistence]);

  useEffect(() => {
    if (!hydrated) return;
    try { window.localStorage.setItem(RIGHT_PANEL_KIND_KEY, rightPanelKind); } catch { /* ignore */ }
  }, [hydrated, rightPanelKind]);
}
