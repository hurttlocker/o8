'use client';

import { useEffect, useMemo, useState } from 'react';
import { Onboarding, type OnboardingStep } from '@/components/desktop/Onboarding';
import { TelemetryConsentCard } from '@/components/desktop/TelemetryConsentCard';
import type { OnboardingRequest } from '@/components/desktop/onboarding/request';

export type ConsentPreviewState = 'unanswered' | 'one-choice' | 'saving' | 'error';
type PreviewSurface = 'consent' | 'onboarding';

const ONBOARDING_STEPS: Array<{ value: OnboardingStep; label: string }> = [
  { value: 'open', label: 'Welcome' },
  { value: 'repos', label: 'Repositories' },
  { value: 'runtimes', label: 'Runtime scan' },
  { value: 'dispatch', label: 'Runtime choices' },
  { value: 'import', label: 'Memory import' },
  { value: 'ready', label: 'Ready' },
];

const CONSENT_STATES: Array<{ value: ConsentPreviewState; label: string }> = [
  { value: 'unanswered', label: 'Unanswered' },
  { value: 'one-choice', label: 'One choice made' },
  { value: 'saving', label: 'Saving' },
  { value: 'error', label: 'Save error' },
];

const ignorePreviewAction = () => {};
const cancelPreviewFolderPicker = async () => null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const previewOnboardingRequest: OnboardingRequest = async (input) => {
  const url = String(input);
  if (url.startsWith('/api/panel/github-status')) {
    return jsonResponse({ authenticated: false, deviceFlowEnabled: false });
  }
  if (url.startsWith('/api/panel/repos')) return jsonResponse({ repos: [] });
  if (url.startsWith('/api/setup/detect')) {
    return jsonResponse({
      tools: [{ id: 'local-preview', name: 'Local preview runtime', detected: true, ready: true, version: 'preview' }],
    });
  }
  if (url.startsWith('/api/panel/operator-defaults')) {
    return jsonResponse({ values: {}, dispatchableRuntimes: [] });
  }
  if (url.startsWith('/api/connectors/')) return jsonResponse({ profile: null });
  return jsonResponse({ error: 'Preview request is not stubbed.' }, 404);
};

export function createConsentPreviewRequest(state: ConsentPreviewState) {
  return async (init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return jsonResponse({ values: { telemetryConsentAnswered: false } });
    }
    if (state === 'saving') return new Promise<Response>(() => {});
    if (state === 'error') {
      return jsonResponse({ error: 'Preview: choices could not be saved.' }, 500);
    }
    return jsonResponse({ values: { telemetryConsentAnswered: true } });
  };
}

function ConsentScenario({ state }: { state: ConsentPreviewState }) {
  const request = useMemo(() => createConsentPreviewRequest(state), [state]);

  useEffect(() => {
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) callback();
      }, delay);
      timers.add(timer);
    };
    const findButton = (label: string) => Array.from(document.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === label) as HTMLButtonElement | undefined;
    const driveState = () => {
      const firstChoice = findButton('Share crash reports');
      if (!firstChoice) {
        later(driveState, 25);
        return;
      }
      if (state === 'unanswered') return;
      firstChoice.click();
      if (state === 'one-choice') return;
      later(() => {
        findButton('Keep product usage off')?.click();
        later(() => { findButton('Save both choices')?.click(); }, 25);
      }, 25);
    };
    driveState();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [state]);

  return <TelemetryConsentCard request={request} />;
}

const controlStyle: React.CSSProperties = {
  minHeight: 32,
  paddingTop: 5,
  paddingBottom: 5,
  paddingLeft: 10,
  paddingRight: 28,
  borderRadius: 8,
  border: '1px solid var(--t-divider-strong)',
  background: 'var(--t-chat-surface-bg)',
  color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
};

export function FirstRunPreview() {
  const [surface, setSurface] = useState<PreviewSurface>('consent');
  const [consentState, setConsentState] = useState<ConsentPreviewState>('unanswered');
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('open');

  return (
    <main style={{ position: 'fixed', inset: 0, overflow: 'hidden', background: 'var(--t-bg)' }}>
      {surface === 'consent' ? (
        <ConsentScenario key={consentState} state={consentState} />
      ) : (
        <Onboarding
          key={onboardingStep}
          initialStep={onboardingStep}
          request={previewOnboardingRequest}
          pickFolder={cancelPreviewFolderPicker}
          openExternal={ignorePreviewAction}
          onComplete={ignorePreviewAction}
        />
      )}

      <aside style={{
        position: 'fixed',
        top: 10,
        left: '50%',
        zIndex: 100001,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        maxWidth: 'calc(100vw - 24px)',
        paddingTop: 6,
        paddingBottom: 6,
        paddingLeft: 8,
        paddingRight: 8,
        borderRadius: 10,
        border: '1px solid var(--t-divider-strong)',
        background: 'var(--t-chat-surface-card-bg)',
        boxShadow: 'var(--t-glass-shadow)',
        fontFamily: 'var(--font-sans-system)',
      }}>
        <span style={{ paddingLeft: 3, fontSize: 9, fontWeight: 500, letterSpacing: '0.12em', color: 'var(--t-text-muted)', whiteSpace: 'nowrap' }}>
          DEV PREVIEW
        </span>
        <select
          aria-label="First-run surface"
          value={surface}
          onChange={(event) => setSurface(event.target.value as PreviewSurface)}
          style={controlStyle}
        >
          <option value="consent">Privacy consent</option>
          <option value="onboarding">Onboarding</option>
        </select>
        {surface === 'consent' ? (
          <select
            aria-label="Consent state"
            value={consentState}
            onChange={(event) => setConsentState(event.target.value as ConsentPreviewState)}
            style={controlStyle}
          >
            {CONSENT_STATES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <select
            aria-label="Onboarding step"
            value={onboardingStep}
            onChange={(event) => setOnboardingStep(event.target.value as OnboardingStep)}
            style={controlStyle}
          >
            {ONBOARDING_STEPS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        )}
        <span style={{ fontSize: 10, color: 'var(--t-text-faint)', whiteSpace: 'nowrap' }}>
          isolated state
        </span>
      </aside>
    </main>
  );
}
