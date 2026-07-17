'use client';

/**
 * Global not-found — a dead route in the desktop shell must never strand the
 * operator on Next's bare 404 (#1573: no chrome, no way back, and the detour
 * destroys live panel state). Any unknown path lands back on the dashboard.
 * Client component so SPA pushes to dead routes (o8:// links, agent-driven
 * navigate, stale bookmarks) recover too, not just hard loads.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function NotFound() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--t-bg-gradient, var(--t-bg, #1c1c1e))',
        color: 'var(--t-text-muted, #64748b)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 13,
      }}
    >
      Returning to the dashboard…
    </main>
  );
}
