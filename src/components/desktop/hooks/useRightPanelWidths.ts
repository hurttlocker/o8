'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

export const MIN_RIGHT_PANEL_WIDTH = 240;
export const MAX_RIGHT_PANEL_WIDTH = 720;
export const MIN_O8_PANEL_WIDTH = 400;
export const MAX_O8_PANEL_WIDTH = 1200;

const DEFAULT_RIGHT_PANEL_WIDTH = 280;
const DEFAULT_O8_PANEL_WIDTH = 440;
const RIGHT_PANEL_WIDTH_CHAT_KEY = 'o8:right-panel:width-chat';
const RIGHT_PANEL_WIDTH_O8_KEY = 'o8:right-panel:width-o8';

function readStoredWidth(key: string, min: number, max: number): number | null {
  try {
    const stored = Number(window.localStorage.getItem(key) ?? 0);
    if (Number.isFinite(stored) && stored >= min && stored <= max) return stored;
  } catch { /* ignore */ }
  return null;
}

export function useRightPanelWidths() {
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  // Default 440px is a balance: wide enough for PRs/Activity content but
  // doesn't eat the workspace on a 1280px laptop viewport. User resizes
  // persist via the o8:right-panel:width-o8 key.
  const [o8Width, setO8Width] = useState(DEFAULT_O8_PANEL_WIDTH);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const storedRightWidth = readStoredWidth(
      RIGHT_PANEL_WIDTH_CHAT_KEY,
      MIN_RIGHT_PANEL_WIDTH,
      MAX_RIGHT_PANEL_WIDTH,
    );
    const storedO8Width = readStoredWidth(
      RIGHT_PANEL_WIDTH_O8_KEY,
      MIN_O8_PANEL_WIDTH,
      MAX_O8_PANEL_WIDTH,
    );
    // These mount-only updates restore external state before the browser paints.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (storedRightWidth !== null) setRightWidth(storedRightWidth);
    if (storedO8Width !== null) setO8Width(storedO8Width);
  }, []);

  useEffect(() => {
    try { window.localStorage.setItem(RIGHT_PANEL_WIDTH_CHAT_KEY, String(rightWidth)); } catch { /* ignore */ }
  }, [rightWidth]);
  useEffect(() => {
    try { window.localStorage.setItem(RIGHT_PANEL_WIDTH_O8_KEY, String(o8Width)); } catch { /* ignore */ }
  }, [o8Width]);

  return {
    rightWidth,
    setRightWidth,
    o8Width,
    setO8Width,
  };
}
