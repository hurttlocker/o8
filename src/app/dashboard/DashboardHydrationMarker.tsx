'use client';

import { useEffect } from 'react';

export function DashboardHydrationMarker() {
  useEffect(() => {
    document.documentElement.removeAttribute('data-o8-dashboard-hydrated');
    const handle = window.setTimeout(() => {
      if (document.documentElement.getAttribute('data-o8-mount-error') === '1') {
        return;
      }
      document.documentElement.setAttribute('data-o8-dashboard-hydrated', '1');
    }, 0);

    return () => window.clearTimeout(handle);
  }, []);

  return null;
}
