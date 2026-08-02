import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectionResult } from '@/components/desktop/setup-wizard/types';
import { loadSetupDetection } from '@/lib/setup/detection-cache';
import { normalizeDetection } from '../utils';

export function useSetupWizard() {
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupCheckComplete, setSetupCheckComplete] = useState(false);
  const [setupDetection, setSetupDetection] = useState<DetectionResult | null>(null);
  const [setupCompleteError, setSetupCompleteError] = useState<string | null>(null);
  const setupCheckedRef = useRef(false);

  useEffect(() => {
    if (setupCheckedRef.current) return;
    setupCheckedRef.current = true;
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        try {
          const rawDetection = await loadSetupDetection();
          if (rawDetection) {
            setSetupDetection(normalizeDetection(rawDetection as Record<string, unknown>));
          }
        } catch { /* detection is optional for onboarding */ }
        // Treat either flag as "done" — some older installs only have
        // completedAt because of the schema-drift bug fixed 2026-04-09.
        if (config.setupComplete || config.completedAt) return;
        // Show the onboarding screen immediately — detection runs in background
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
    } catch (error) {
      console.error('[setup]', error);
      setSetupCompleteError('Setup could not be saved. Try again to finish onboarding.');
      setSetupWizardOpen(true);
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
