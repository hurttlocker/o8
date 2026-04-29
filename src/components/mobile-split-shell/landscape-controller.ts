'use client';

import { useEffect, useState } from 'react';

// Landscape split-view controller for the mobile PWA.
//
// Trigger: device is in landscape AND the viewport is at least 720px wide. The
// width gate keeps small devices in portrait layout when held landscape (the
// dev-host preview is unreadable below ~360px per pane).
//
// We subscribe to the same media query used in #779 spec; Mobile Safari and
// the iOS-installed PWA both honor `(orientation: landscape)` correctly, and
// `min-width` flips on rotation as expected.

export const LANDSCAPE_SPLIT_QUERY = '(orientation: landscape) and (min-width: 720px)';

function readMatch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia(LANDSCAPE_SPLIT_QUERY).matches;
  } catch {
    return false;
  }
}

export interface LandscapeSplitState {
  isSplit: boolean;
}

export function useLandscapeSplit(): LandscapeSplitState {
  // Start `false` on the server / first paint to match the existing portrait
  // layout. The hook flips to `true` after mount if the media query matches,
  // which avoids a hydration mismatch on the chat tree.
  const [isSplit, setIsSplit] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mql = window.matchMedia(LANDSCAPE_SPLIT_QUERY);

    const apply = () => {
      setIsSplit(mql.matches);
    };

    apply();

    // Safari < 14 only exposes addListener/removeListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', apply);
      return () => mql.removeEventListener('change', apply);
    }
    mql.addListener(apply);
    return () => mql.removeListener(apply);
  }, []);

  return { isSplit };
}

// Exposed for tests / SSR escape hatches that need the unbound check.
export function isLandscapeSplitNow(): boolean {
  return readMatch();
}
