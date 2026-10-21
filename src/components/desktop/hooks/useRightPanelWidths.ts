'use client';

import { useCallback, useEffect, useLayoutEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { O8Tab } from '../o8-panel/types';

export const MIN_RIGHT_PANEL_WIDTH = 240;
export const MAX_RIGHT_PANEL_WIDTH = 720;
export const MIN_O8_PANEL_WIDTH = 400;
export const MAX_O8_PANEL_WIDTH = 1200;

const DEFAULT_RIGHT_PANEL_WIDTH = 280;
const DEFAULT_O8_PANEL_WIDTH = 440;
const RIGHT_PANEL_WIDTH_CHAT_KEY = 'o8:right-panel:width-chat';
const RIGHT_PANEL_WIDTH_O8_KEY = 'o8:right-panel:width-o8';
const TOOL_WIDTHS_KEY = 'o8:right-panel:tool-widths';
const WIDE_TOOL_DEFAULTS = { spec: 600, device: 600, compare: 960 } as const;
type WideTool = keyof typeof WIDE_TOOL_DEFAULTS;

function readStoredWidth(key: string, min: number, max: number): number | null {
  try {
    const stored = Number(window.localStorage.getItem(key) ?? 0);
    if (Number.isFinite(stored) && stored >= min && stored <= max) return stored;
  } catch { /* ignore */ }
  return null;
}

export function useRightPanelWidths(tab?: O8Tab, secondaryTab?: O8Tab | null) {
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_PANEL_WIDTH);
  // Default 440px is a balance: wide enough for PRs/Activity content but
  // doesn't eat the workspace on a 1280px laptop viewport. User resizes
  // persist via the o8:right-panel:width-o8 key.
  const [preferredO8Width, setPreferredO8Width] = useState(DEFAULT_O8_PANEL_WIDTH);
  const [toolWidths, setToolWidths] = useState<Partial<Record<WideTool, number>>>({});
  const [hydrated, setHydrated] = useState(false);
  const wideTool: WideTool | null = tab === 'compare' || secondaryTab === 'compare' ? 'compare' : tab === 'spec' || secondaryTab === 'spec' ? 'spec' : tab === 'device' || secondaryTab === 'device' ? 'device' : null;
  const o8Width = wideTool ? toolWidths[wideTool] ?? Math.max(preferredO8Width, WIDE_TOOL_DEFAULTS[wideTool]) : preferredO8Width;
  const setO8Width: Dispatch<SetStateAction<number>> = useCallback((value) => {
    if (wideTool) setToolWidths((current) => ({ ...current, [wideTool]: typeof value === 'function' ? value(current[wideTool] ?? Math.max(preferredO8Width, WIDE_TOOL_DEFAULTS[wideTool])) : value }));
    else setPreferredO8Width(value);
  }, [preferredO8Width, wideTool]);

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
    if (storedO8Width !== null) setPreferredO8Width(storedO8Width);
    try {
      const parsed = JSON.parse(window.localStorage.getItem(TOOL_WIDTHS_KEY) ?? '{}');
      const saved: Partial<Record<WideTool, number>> = {};
      for (const key of ['spec', 'device', 'compare'] as const) {
        const width = parsed?.[key];
        if (typeof width === 'number' && Number.isFinite(width) && width >= MIN_O8_PANEL_WIDTH && width <= MAX_O8_PANEL_WIDTH) saved[key] = width;
      }
      setToolWidths(saved);
    } catch { /* Ignore invalid stored preferences. */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) try { window.localStorage.setItem(RIGHT_PANEL_WIDTH_CHAT_KEY, String(rightWidth)); } catch { /* ignore */ }
  }, [hydrated, rightWidth]);
  useEffect(() => {
    if (hydrated) try {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_O8_KEY, String(preferredO8Width));
      window.localStorage.setItem(TOOL_WIDTHS_KEY, JSON.stringify(toolWidths));
    } catch { /* ignore */ }
  }, [hydrated, preferredO8Width, toolWidths]);

  return {
    rightWidth,
    setRightWidth,
    o8Width,
    setO8Width,
  };
}
