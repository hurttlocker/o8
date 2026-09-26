'use client';
import { memo, useCallback, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { TelemetryConsentCard } from './TelemetryConsentCard';
import { OnboardingDispatchStep } from './onboarding/OnboardingDispatchStep';
import { OnboardingReposStep } from './onboarding/OnboardingReposStep';
import { OnboardingOpen } from './onboarding/OnboardingOpen';
import { OnboardingFirstTask } from './onboarding/OnboardingFirstTask';
import { useOnboardingGithub } from './onboarding/useOnboardingGithub';
import { ONBOARDING_STEPS, PROGRESS_KEY, browserProgressStorage, emptyProgress, readProgress, writeProgress, type OnboardingProgress, type OnboardingStep, type OnboardingTask, type ProgressStorage } from './onboarding/onboarding-progress';
import { onboardingButtonStyle } from './onboarding/onboarding-style';
import type { OnboardingRequest } from './onboarding/request';
export type { OnboardingStep } from './onboarding/onboarding-progress';
const LABELS = { open: 'Welcome', repos: 'Project', dispatch: 'Tools', privacy: 'Privacy', ready: 'First task' };

const OnboardingFlow = memo(function OnboardingFlow({ onComplete, completionError, initialStep, request = fetch, pickFolder, openExternal = openExternalUrl, storage }: {
  onComplete: (task?: OnboardingTask) => Promise<boolean | void> | boolean | void;
  completionError?: string | null; initialStep?: OnboardingStep; request?: OnboardingRequest;
  pickFolder?: () => Promise<string | null>; openExternal?: (url: string) => void; storage?: ProgressStorage | null;
}) {
  const [progressStorage] = useState(() => storage === undefined ? browserProgressStorage() : storage);
  const [progress, setProgress] = useState(() => initialStep ? emptyProgress(initialStep) : readProgress(progressStorage));
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const { githubFlow, githubDeviceFlowEnabled, startGithubFlow } = useOnboardingGithub(request, openExternal);
  const update = useCallback((patch: Partial<OnboardingProgress>) => {
    const next = { ...progress, ...patch };
    setProgress(next);
    setStorageError(!writeProgress(progressStorage, next));
  }, [progress, progressStorage]);
  const navigate = (step: OnboardingStep) => update({ step });
  const consentRequest = useCallback((init: RequestInit = {}) => request('/api/panel/operator-defaults?include=values', init), [request]);
  const complete = async (task?: OnboardingTask) => {
    const result = await onComplete(task);
    if (result === false) return false;
    try { progressStorage?.removeItem(PROGRESS_KEY); } catch { /* Completion is already durable on the server. */ }
    return true;
  };
  const stepIndex = ONBOARDING_STEPS.indexOf(progress.step);
  const renderButton = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => <button type="button" onClick={onClick} disabled={disabled} style={{ ...onboardingButtonStyle, background: 'var(--t-accent)', color: 'var(--t-success-contrast)', opacity: disabled ? 0.5 : 1 }}>{label}</button>;
  return <div style={{ position: 'fixed', inset: 0, zIndex: 99998, display: 'flex', flexDirection: 'column', background: 'var(--t-chat-surface-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div data-tauri-drag-region="" style={{ height: 52, flexShrink: 0 }} />
    {progress.step === 'open' ? <OnboardingOpen onSetup={() => navigate('repos')} onFastLane={() => navigate('privacy')} onPrivacy={() => openExternal('https://o8.run/privacy')} /> : <>
      <nav aria-label="Setup progress" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 16, padding: 16, flexShrink: 0 }}>
        <button type="button" disabled={busy} onClick={() => navigate(ONBOARDING_STEPS[stepIndex - 1])} style={{ ...onboardingButtonStyle, minHeight: 32 }}>Back</button>
        {ONBOARDING_STEPS.slice(1).map((step) => <span key={step} aria-current={step === progress.step ? 'step' : undefined} style={{ fontSize: 12, color: step === progress.step ? 'var(--t-text)' : 'var(--t-text-faint)', fontWeight: step === progress.step ? 500 : 300 }}>{LABELS[step]}</span>)}
      </nav>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 24, paddingBottom: 72, paddingLeft: 24, paddingRight: 24 }}>
        <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 20 }}>
          {progress.step === 'repos' ? <><h1 style={{ fontSize: 28, fontWeight: 400, margin: 0 }}>Where shall we start?</h1><OnboardingReposStep onBusyChange={setBusy} request={request} pickFolder={pickFolder} selectedProject={progress.project} deviceFlowEnabled={githubDeviceFlowEnabled} githubFlow={githubFlow} onConnectGithub={(onSuccess) => void startGithubFlow(onSuccess)} onSkip={() => update({ project: null, step: 'dispatch' })} onContinue={(project) => update({ project, step: 'dispatch' })} renderContinueButton={renderButton} /></> : null}
          {progress.step === 'dispatch' ? <OnboardingDispatchStep onBusyChange={setBusy} request={request} onContinue={() => update({ toolsConfigured: true, step: 'privacy' })} onSkip={() => update({ toolsConfigured: false, step: 'privacy' })} renderButton={renderButton} /> : null}
          {progress.step === 'privacy' ? <TelemetryConsentCard onBusyChange={setBusy} embedded request={consentRequest} onContinue={() => navigate('ready')} /> : null}
          {progress.step === 'ready' ? <OnboardingFirstTask onBusyChange={setBusy} progress={progress} request={request} onTaskChange={(task) => update({ task })} onNavigate={navigate} onComplete={complete} completionError={completionError} /> : null}
          {storageError ? <p role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>This session can continue, but progress could not be saved for a restart.</p> : null}
        </div>
      </div>
    </>}
    <div style={{ position: 'fixed', bottom: 14, left: 24, zIndex: 100000, display: 'flex', alignItems: 'center', gap: 12 }}>
      <button type="button" aria-expanded={supportOpen} onClick={() => setSupportOpen((value) => !value)} style={{ ...onboardingButtonStyle, minHeight: 32, fontSize: 11 }}>Get support</button>
      {supportOpen ? <><button type="button" onClick={() => window.dispatchEvent(new Event('o8:open-report'))} style={onboardingButtonStyle}>Report an issue</button><button type="button" onClick={() => openExternal('https://o8.run/docs')} style={onboardingButtonStyle}>Docs &amp; FAQ</button></> : null}
    </div>
  </div>;
});

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
/** Read local progress only after hydration so server markup never disagrees. */
export function Onboarding(props: ComponentProps<typeof OnboardingFlow>) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return hydrated ? <OnboardingFlow {...props} /> : <div role="status" style={{ position: 'fixed', inset: 0, zIndex: 99998, display: 'grid', placeItems: 'center', background: 'var(--t-chat-surface-bg)', color: 'var(--t-text-secondary)' }}>Loading setup…</div>;
}
