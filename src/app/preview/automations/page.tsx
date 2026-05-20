'use client';

/**
 * /preview/automations — mounts the real AutomationsPage with live API data
 * so the operator can iterate on the surface without flipping nav-section.
 *
 * The actual list/modal logic lives in `AutomationsPage.tsx`; this route just
 * gives it a container and passes `currentOwner='operator'` (same default the
 * dashboard uses for the single-user model in P1).
 */

import { ThemeProvider } from '@/lib/theme/context';
import { AutomationsPage } from '@/components/desktop/AutomationsPage';

export default function AutomationsPreviewPage() {
  return (
    <ThemeProvider>
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--t-bg)' }}>
        <AutomationsPage currentOwner="operator" />
      </div>
    </ThemeProvider>
  );
}
