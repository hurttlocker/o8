import { useCallback, useEffect, useRef, useState } from 'react';
import type { DetectionResult } from '@/components/desktop/SetupWizard';
import { normalizeDetection } from '../utils';

export function useSetupWizard() {
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupDetection, setSetupDetection] = useState<DetectionResult | null>(null);
  const setupCheckedRef = useRef(false);

  useEffect(() => {
    if (setupCheckedRef.current) return;
    setupCheckedRef.current = true;
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config');
        if (!configRes.ok) return;
        const config = await configRes.json();
        // Treat either flag as "done" — some older installs only have
        // completedAt because of the schema-drift bug fixed 2026-04-09.
        if (config.setupComplete || config.completedAt) return;
        // Show the onboarding screen immediately — detection runs in background
        setSetupWizardOpen(true);
        try {
          const detectRes = await fetch('/api/setup/detect');
          if (detectRes.ok) {
            const rawDetection = await detectRes.json() as Record<string, unknown>;
            setSetupDetection(normalizeDetection(rawDetection));
          }
        } catch { /* detection is optional for onboarding */ }
      } catch { /* silent — don't block dashboard */ }
    })();
  }, []);

  const handleSetupComplete = useCallback(async () => {
    setSetupWizardOpen(false);
    try {
      await fetch('/api/setup/config', {
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
    } catch { /* silent */ }
  }, []);

  // Dev: trigger onboarding from settings without resetting config
  useEffect(() => {
    const handler = () => setSetupWizardOpen(true);
    window.addEventListener('cortex-trigger-onboarding', handler);
    return () => window.removeEventListener('cortex-trigger-onboarding', handler);
  }, []);

  return {
    handleSetupComplete,
    setupDetection,
    setupWizardOpen,
    setSetupWizardOpen,
  };
}
