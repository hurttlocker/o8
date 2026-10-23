'use client';

import { useCallback, useEffect } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';

/** Keep service-license ownership aligned with the current account.
 * Funded services and relay still use the legacy license until their migration.
 * This component carries no edition state and grants no local feature access.
 */
export function AccountAuthorizationSync({ children }: { children: React.ReactNode }) {
  const auth = useO8Auth();
  const activeSubject = auth.user?.id ?? null;
  const signedOut = auth.clerkEnabled && auth.isLoaded && !auth.signedIn;

  const validate = useCallback(async () => {
    if (signedOut) return;
    try {
      const url = activeSubject
        ? `/api/panel/entitlement?subject=${encodeURIComponent(activeSubject)}`
        : '/api/panel/entitlement';
      // The route checks the cached license subject under the account lease.
      // It preserves unknown subjects and evicts a known different account.
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) console.error('[entitlement] account validation failed:', response.status);
    } catch {
      console.error('[entitlement] account validation unavailable');
    }
  }, [activeSubject, signedOut]);

  useEffect(() => { void validate(); }, [validate]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ signedOut?: boolean }>).detail;
      if (detail?.signedOut === true) return;
      void validate();
    };
    window.addEventListener('o8:entitlement-refresh', refresh);
    return () => window.removeEventListener('o8:entitlement-refresh', refresh);
  }, [validate]);

  return children;
}
