import { useCallback, useEffect, useRef, useState } from 'react';
import { hasPermissionsResume } from '@/components/desktop/onboarding/permissions-check';
import { browserProgressStorage } from '@/components/desktop/onboarding/onboarding-progress';
import type { DetectionResult } from '@/components/desktop/setup-wizard/types';

export function useSetupWizard() {
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupCheckComplete, setSetupCheckComplete] = useState(false);
  const [setupDetection] = useState<DetectionResult | null>(null);
  const [setupCompleteError, setSetupCompleteError] = useState<string | null>(null);
  const setupCheckedRef = useRef(false);

  useEffect(() => {
    if (setupCheckedRef.current) return;
    setupCheckedRef.current = true;
    if (hasPermissionsResume(browserProgressStorage())) {
      setSetupWizardOpen(true);
      setSetupCheckComplete(true);
      return;
    }
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        // A completed install must not run the full CLI/auth detector during
        // dashboard startup. That route probes several local binaries and can
        // hold the server event loop long enough to delay UI chunks. Detection
        // remains part of the onboarding and explicit settings paths.
        if (config.setupComplete || config.completedAt) return;
        // The combined tools step owns discovery when the user reaches it.
        setSetupWizardOpen(true);
      } catch { /* silent — don't block dashboard */ }
      finally { setSetupCheckComplete(true); }
    })();
  }, []);

  const handleSetupComplete = useCallback(async () => {
    setSetupCompleteError(null);
    try {
      const res = await fetch('/api/setup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Write BOTH the canonical flag and the display timestamp.
        // Previously only `completedAt` was written, leaving `setupComplete`
        // stuck at its default `false` forever and making any code that
        // gated on the canonical flag think onboarding never finished.
        body: JSON.stringify({
          setupComplete: true,
          completedAt: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`Setup completion save failed (${res.status})`);
      setSetupWizardOpen(false);
      return true;
    } catch (error) {
      console.error('[setup]', error);
      setSetupCompleteError('Setup could not be saved. Try again to finish onboarding.');
      setSetupWizardOpen(true);
      return false;
    }
  }, []);

  // Dev: trigger onboarding from settings without resetting config
  useEffect(() => {
    const handler = () => setSetupWizardOpen(true);
    window.addEventListener('o8-trigger-onboarding', handler);
    return () => window.removeEventListener('o8-trigger-onboarding', handler);
  }, []);

  return {
    handleSetupComplete,
    setupCompleteError,
    setupCheckComplete,
    setupDetection,
    setupWizardOpen,
    setSetupWizardOpen,
  };
}
