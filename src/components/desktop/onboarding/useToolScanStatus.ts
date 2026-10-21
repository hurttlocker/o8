'use client';

import { useEffect, useState } from 'react';

export function useToolScanStatus(loading: boolean): string {
  const [slow, setSlow] = useState(false);
  const [previousLoading, setPreviousLoading] = useState(loading);
  if (previousLoading !== loading) { setPreviousLoading(loading); setSlow(false); }
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setSlow(true), 3_000);
    return () => clearTimeout(timer);
  }, [loading]);
  return slow ? 'Still checking installed tools and local sign-in. You can choose a project while this finishes.' : 'Checking your coding tools…';
}
