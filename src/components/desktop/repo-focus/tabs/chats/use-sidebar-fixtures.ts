'use client';

import { useEffect, useState } from 'react';
import { sidebarFixturesSchema, type SidebarFixture } from '@/lib/ui/sidebar-fixtures';

const EMPTY: SidebarFixture[] = [];

export function useSidebarFixtures(enabled: boolean): SidebarFixture[] {
  const [fixtures, setFixtures] = useState<SidebarFixture[]>(EMPTY);
  useEffect(() => {
    if (!enabled || process.env.NODE_ENV !== 'development') return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/panel/sidebar-fixtures', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const payload = sidebarFixturesSchema.safeParse(await response.json());
        if (!controller.signal.aborted) setFixtures(payload.success ? payload.data.fixtures : EMPTY);
      } catch { /* Samples must never interrupt real conversations. */ }
    };
    void load();
    window.addEventListener('o8:chat-history-updated', load);
    window.addEventListener('focus', load);
    return () => {
      controller.abort();
      window.removeEventListener('o8:chat-history-updated', load);
      window.removeEventListener('focus', load);
    };
  }, [enabled]);
  return enabled ? fixtures : EMPTY;
}
