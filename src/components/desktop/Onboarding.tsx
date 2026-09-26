'use client';

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { TelemetryConsentCard } from './TelemetryConsentCard';
import { OnboardingDispatchStep } from './onboarding/OnboardingDispatchStep';
import { OnboardingReposStep } from './onboarding/OnboardingReposStep';
import { OnboardingPermissionsStep } from './onboarding/OnboardingPermissionsStep';
import { restartOnboardingAtPermissions } from './onboarding/permissions-check';
import { OnboardingOpen } from './onboarding/OnboardingOpen';
import { OnboardingFeedback } from './onboarding/OnboardingFeedback';
import { useAgentSetupRequest } from './onboarding/useAgentSetupRequest';
import type { AgentSetupRequest, SetupRequestStatus } from '@/lib/setup/agent-request';
import { useOnboardingGithub } from './onboarding/useOnboardingGithub';
import { PROGRESS_KEY, browserProgressStorage, emptyProgress, readProgress, writeProgress, type OnboardingProgress, type OnboardingStep, type OnboardingTask, type OnboardingProject, type ProgressStorage } from './onboarding/onboarding-progress';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding/onboarding-style';
import { loadOnboardingRuntimeSelection, onboardingSetupIsReady, persistOnboardingRuntimeSelection, type OnboardingRuntimeSelection } from './onboarding/onboarding-runtime-selection';
import { chooseOnboardingProject, loadOnboardingProjects } from './onboarding/onboarding-projects';
import type { OnboardingRequest } from './onboarding/request';
export type { OnboardingStep } from './onboarding/onboarding-progress';

const OnboardingFlow = memo(function OnboardingFlow({ onComplete, completionError, initialStep, request = fetch, pickFolder, openExternal = openExternalUrl, storage }: {
  onComplete: (task?: OnboardingTask) => Promise<boolean | void> | boolean | void;
  completionError?: string | null; initialStep?: OnboardingStep; request?: OnboardingRequest;
  pickFolder?: () => Promise<string | null>; openExternal?: (url: string) => void; storage?: ProgressStorage | null;
}) {
  const [progressStorage] = useState(() => storage === undefined ? browserProgressStorage() : storage);
  const [progress, setProgress] = useState(() => initialStep ? emptyProgress(initialStep) : readProgress(progressStorage));
  const progressRef = useRef(progress);
  const [projects, setProjects] = useState<OnboardingProject[]>([]);
  const [setup, setSetup] = useState<OnboardingRuntimeSelection | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [childBusy, setChildBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [setupSaved, setSetupSaved] = useState(false);
  const actionLock = useRef(false);
  const agentRequest = useRef<AgentSetupRequest | null>(null);
  const continueAfterTools = useRef(false);
  const [storageError, setStorageError] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const busy = actionBusy || childBusy;
  const { githubFlow, githubDeviceFlowEnabled, startGithubFlow } = useOnboardingGithub(request, openExternal);
  const update = useCallback((patch: Partial<OnboardingProgress>) => {
    const next = { ...progressRef.current, ...patch };
    progressRef.current = next;
    setProgress(next);
    setStorageError(!writeProgress(progressStorage, next));
  }, [progressStorage]);
  const navigate = (step: OnboardingStep) => { setError(null); setSetupSaved(false); update({ step }); };
  const consentRequest = useCallback((init: RequestInit = {}) => request('/api/panel/operator-defaults?include=values', init), [request]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.allSettled([loadOnboardingProjects(request), loadOnboardingRuntimeSelection(request, revision > 0)]).then(([projectResult, setupResult]) => {
      if (!active) return;
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value);
      if (setupResult.status === 'fulfilled') setSetup(setupResult.value);
      else setSetup(null);
      setDiscoveryError(projectResult.status === 'rejected' ? 'Could not load your projects. You can still open a folder.'
        : setupResult.status === 'rejected' ? 'Could not check your tools. Try again or open tool settings.' : null);
      setLoading(false);
    });
    return () => { active = false; };
  }, [request, revision]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
    const heading = contentRef.current?.querySelector<HTMLElement>('h1, h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
  }, [progress.step]);

  const acknowledgeAgent = async (project: OnboardingProject | null, result: SetupRequestStatus, message?: string) => {
    const pending = agentRequest.current;
    if (!pending || pending.project.id !== project?.id) return;
    const response = await request('/api/setup/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ack', requestId: pending.id, status: result, claimId: pending.claimId, ...(message ? { error: message.slice(0, 1000) } : {}) }),
    });
    if (!response.ok) throw new Error('The workspace result could not be confirmed to your agent. Read setup status before retrying.');
    if (result === 'opened') agentRequest.current = null;
  };

  // Opening and consent are user actions. Discovery itself never saves settings.
  const enter = async (project: OnboardingProject | null, fromPicker = false, incoming?: AgentSetupRequest) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setError(null);
    setDiscoveryError(null);
    setStatus(fromPicker ? 'Choosing a folder…' : 'Checking your workspace…');
    let renewal: ReturnType<typeof setInterval> | undefined;
    const renewClaim = async () => {
      const current = agentRequest.current;
      if (!current) return;
      const response = await request('/api/setup/agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'renew', requestId: current.id, claimId: current.claimId }),
      });
      if (!response.ok) throw new Error('Your agent’s setup request was interrupted. Read status before retrying.');
    };
    try {
      if (fromPicker) {
        project = await chooseOnboardingProject(request, pickFolder);
        if (!project) return;
        setProjects((current) => [project!, ...current.filter((item) => item.id !== project!.id)]);
      }
      agentRequest.current = null;
      if (project) {
        const receipt = incoming ?? await request('/api/setup/agent?view=request', { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) throw new Error('Could not check your agent’s setup request. Try again.');
            return (await response.json() as { request?: AgentSetupRequest }).request;
          });
        if (receipt?.project.id === project.id && !['opened', 'cancelled'].includes(receipt.status)) {
          const response = await request('/api/setup/agent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'claim', requestId: receipt.id }),
          });
          if (!response.ok) throw new Error('This setup request changed or is already being handled. Read its status before retrying.');
          agentRequest.current = (await response.json() as { request: AgentSetupRequest }).request;
          renewal = setInterval(() => { void renewClaim().catch(() => {}); }, 15_000);
        }
      }
      update({ project });
      setStatus('Checking project and tools…');
      const [currentProjects, currentSetup] = await Promise.all([project ? loadOnboardingProjects(request) : Promise.resolve([]), loadOnboardingRuntimeSelection(request, true)]);
      setSetup(currentSetup);
      if (project) {
        const registered = currentProjects.find((item) => item.id === project!.id && item.localPath === project!.localPath);
        if (!registered) {
          update({ project: null, step: 'open' });
          setProjects(currentProjects);
          throw new Error('This project is no longer available. Open its folder again.');
        }
        project = registered;
        update({ project });
        if (!onboardingSetupIsReady(currentSetup)) {
          continueAfterTools.current = true;
          update({ step: 'dispatch' });
          await acknowledgeAgent(project, 'needs_tools');
          return;
        }
        if (!currentSetup.recommendation.preserved) {
          setStatus('Preparing your tools…');
          await persistOnboardingRuntimeSelection({ ...currentSetup, leadModel: currentSetup.recommendation.leadModel, workerModel: currentSetup.recommendation.workerModel }, request);
        }
        update({ toolsConfigured: true });
      }
      if (!currentSetup.consentAnswered) { update({ step: 'privacy' }); await acknowledgeAgent(project, 'needs_privacy'); return; }
      await renewClaim();
      setStatus(project ? `Opening ${project.name}…` : 'Opening workspace…');
      const completed = await onComplete(project ? { project, text: progressRef.current.task } : undefined);
      if (completed === false) throw new Error('Could not open the workspace. Try again.');
      await acknowledgeAgent(project, 'opened');
      try { progressStorage?.removeItem(PROGRESS_KEY); } catch { /* Completion is already saved on the server. */ }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Could not open the workspace. Try again.';
      setError(message);
      await acknowledgeAgent(project, 'error', message).catch(() => {});
    } finally {
      clearInterval(renewal);
      actionLock.current = false;
      setActionBusy(false);
      setStatus('');
    }
  };

  useAgentSetupRequest(request, async (pending) => {
    if (!childBusy) await enter(pending.project, false, pending);
  });

  const ready = setup && onboardingSetupIsReady(setup);
  const leadLabel = setup?.inventory.find((item) => item.id === setup.orchestratorRuntime)?.label ?? setup?.orchestratorRuntime;
  const tools = <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 300, color: 'var(--t-text-secondary)' }}>
      <span aria-hidden style={{ width: 5, height: 5, borderRadius: '50%', background: ready ? 'var(--t-text-secondary)' : 'var(--t-text-faint)' }} />
      {loading ? 'Finding your tools…' : ready ? `${setup?.recommendation.preserved ? 'Using' : 'Suggested lead:'} ${leadLabel}` : 'Connect a tool when you’re ready'}
    </span>
    <button type="button" disabled={busy} onClick={() => { continueAfterTools.current = false; navigate('dispatch'); }} style={{ ...onboardingQuietButtonStyle, fontSize: 12 }}>{ready ? 'Change' : 'Set up tools'}</button>
  </div>;
  const renderButton = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => <button type="button" onClick={onClick} disabled={disabled} style={{ ...onboardingButtonStyle, background: 'var(--t-text)', color: 'var(--t-onboarding-bg)', opacity: disabled ? 0.5 : 1 }}>{label}</button>;
  const home = progress.step === 'open';
  return <div data-o8-onboarding="" style={{ position: 'fixed', inset: 0, zIndex: 99998, display: 'flex', flexDirection: 'column', background: 'var(--t-onboarding-bg)', color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)' }}>
    <div data-tauri-drag-region="" style={{ height: 52, flexShrink: 0 }} />
    <div ref={contentRef} role="region" aria-label="Setup content" tabIndex={0} style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingTop: 24, paddingBottom: 24, paddingLeft: 32, paddingRight: 32 }}>
      <div style={{ minHeight: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'safe center', gap: 20 }}>
        {!home ? <div style={{ width: '100%', maxWidth: progress.step === 'privacy' ? 760 : 640 }}><button type="button" disabled={busy} onClick={() => { continueAfterTools.current = false; navigate('open'); }} style={{ ...onboardingQuietButtonStyle, paddingLeft: 0 }}>← Projects</button></div> : null}
        {!home && progress.project ? <div style={{ width: '100%', maxWidth: progress.step === 'privacy' ? 760 : 640, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>Setting up <span style={{ color: 'var(--t-text)' }}>{progress.project.name}</span><div style={{ marginTop: 4, fontSize: 11, color: 'var(--t-text-muted)' }}>Your project stays selected as you finish these choices.</div></div> : null}
        {home && setupSaved ? <div style={{ width: '100%', maxWidth: 520 }}><OnboardingFeedback title="Setup saved">Your lead and worker choices are saved. Open a project when you’re ready.</OnboardingFeedback></div> : null}
        {home ? <OnboardingOpen projects={projects} loading={loading} busy={busy} status={status} tools={tools} error={error ?? discoveryError ?? completionError ?? null} onRetry={() => setRevision((value) => value + 1)} onOpenFolder={() => void enter(null, true)} onOpenProject={(project) => void enter(project)} onClone={() => navigate('repos')} onPermissions={() => navigate('permissions')} onExplore={() => void enter(null)} /> : null}
        {progress.step === 'repos' ? <><h1 style={{ fontSize: 28, fontWeight: 300, margin: 0 }}>Choose a project</h1><OnboardingReposStep initialShowGithub onBusyChange={setChildBusy} request={request} pickFolder={pickFolder} selectedProject={progress.project} deviceFlowEnabled={githubDeviceFlowEnabled} githubFlow={githubFlow} onConnectGithub={(onSuccess) => void startGithubFlow(onSuccess)} onSkip={() => navigate('open')} onContinue={(project) => enter(project)} renderContinueButton={renderButton} /></> : null}
        {progress.step === 'dispatch' ? <OnboardingDispatchStep onBusyChange={setChildBusy} request={request} onContinue={() => {
          setRevision((value) => value + 1);
          if (continueAfterTools.current) { continueAfterTools.current = false; return enter(progressRef.current.project); }
          else { navigate('open'); setSetupSaved(true); }
        }} onSkip={() => navigate('open')} renderButton={renderButton} /> : null}
        {progress.step === 'permissions' ? <OnboardingPermissionsStep storage={progressStorage} onBusyChange={setChildBusy} onRestart={() => restartOnboardingAtPermissions(progressStorage, progressRef.current)} onContinue={() => navigate('open')} /> : null}
        {progress.step === 'privacy' ? <TelemetryConsentCard onBusyChange={setChildBusy} embedded request={consentRequest} onContinue={() => enter(progressRef.current.project)} /> : null}
        {!home && actionBusy ? <div role="status" style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{status}</div> : null}
        {!home && (error || completionError) ? <div style={{ width: '100%', maxWidth: 640 }}><OnboardingFeedback tone="error" title={error ?? completionError ?? ''}>{storageError ? 'Keep this window open while you retry.' : 'Your saved choices are kept. You can retry or return to projects.'}</OnboardingFeedback></div> : null}
        {storageError ? <p role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>Progress could not be saved for a restart. You can still continue.</p> : null}
      </div>
    </div>
    <footer style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingLeft: 24, paddingRight: 24, paddingBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" aria-expanded={supportOpen} onClick={() => setSupportOpen((value) => !value)} style={{ ...onboardingQuietButtonStyle, fontSize: 11 }}>Help</button>
        {supportOpen ? <><button type="button" onClick={() => window.dispatchEvent(new Event('o8:open-report'))} style={onboardingQuietButtonStyle}>Report an issue</button><button type="button" onClick={() => openExternal('https://o8.run/docs')} style={onboardingQuietButtonStyle}>Docs &amp; FAQ</button></> : null}
      </div>
      <button type="button" onClick={() => openExternal('https://o8.run/privacy')} style={{ ...onboardingQuietButtonStyle, fontSize: 11 }}>Privacy</button>
    </footer>
  </div>;
});

const subscribeHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
/** Read local progress only after hydration so server markup never disagrees. */
export function Onboarding(props: ComponentProps<typeof OnboardingFlow>) {
  const hydrated = useSyncExternalStore(subscribeHydration, clientSnapshot, serverSnapshot);
  return hydrated ? <OnboardingFlow {...props} /> : <div role="status" style={{ position: 'fixed', inset: 0, zIndex: 99998, display: 'grid', placeItems: 'center', background: 'var(--t-onboarding-bg)', color: 'var(--t-text-secondary)' }}>Loading setup…</div>;
}
