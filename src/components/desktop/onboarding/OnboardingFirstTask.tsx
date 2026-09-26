'use client';
import { useEffect, useState } from 'react';
import { formatModelLabel } from '@/lib/format';
import { runtimeForLead } from '@/lib/setup/runtime-recommendation';
import { loadOnboardingRuntimeSelection, orchestratorBackendForRuntime, type OnboardingRuntimeSelection } from './onboarding-runtime-selection';
import { EXPLAIN_PROJECT, PLAN_CHANGE, isOnboardingProject, type OnboardingProgress, type OnboardingProject, type OnboardingStep, type OnboardingTask } from './onboarding-progress';
import type { OnboardingRequest } from './request';
import { onboardingButtonStyle } from './onboarding-style';

export function OnboardingFirstTask({ progress, request, onTaskChange, onNavigate, onComplete, completionError, onBusyChange }: {
  progress: OnboardingProgress; request: OnboardingRequest; onTaskChange: (text: string) => void;
  onNavigate: (step: OnboardingStep) => void; onComplete: (task?: OnboardingTask) => Promise<boolean | void> | boolean | void;
  completionError?: string | null; onBusyChange?: (busy: boolean) => void;
}) {
  const [verified, setVerified] = useState<{ project: OnboardingProject | null; setup: OnboardingRuntimeSelection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let active = true;
    void Promise.all([request('/api/panel/repos', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Could not verify your project.');
      const data = await response.json();
      return (Array.isArray(data.repos) ? data.repos : []).filter(isOnboardingProject) as OnboardingProject[];
    }), loadOnboardingRuntimeSelection(request, true)]).then(([projects, setup]) => {
      if (active) { setVerified({ project: projects.find((p) => p.id === progress.project?.id && p.localPath === progress.project.localPath) ?? null, setup }); setError(null); }
    }).catch(() => { if (active) setError('Could not verify setup. Check your connection and retry.'); });
    return () => { active = false; };
  }, [progress.project, request, revision]);
  const setup = verified?.setup;
  const lead = setup ? runtimeForLead(orchestratorBackendForRuntime(setup.orchestratorRuntime)) : null;
  const leadReady = Boolean(setup && (lead ? setup.inventory.some((item) => item.id === lead && item.available) : setup.recommendation.preserved));
  const workersReady = Boolean(setup?.workerRuntimes.length && setup.workerRuntimes.every((id) => setup.inventory.some((item) => item.id === id && item.available)));
  const toolsReady = progress.toolsConfigured && leadReady && workersReady;
  const canStart = Boolean(verified?.project && toolsReady && setup?.consentAnswered && progress.task.trim());
  const finish = async (withTask: boolean) => {
    if (busy || (withTask && !canStart) || !setup?.consentAnswered) return;
    setBusy(true); setError(null);
    try {
      const completed = await onComplete(withTask && verified?.project ? { project: verified.project, text: progress.task.trim() } : undefined);
      if (completed === false) setError('Setup could not be saved. Try again to finish.');
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open your task. Try again.'); }
    finally { setBusy(false); }
  };
  const change = (step: OnboardingStep, text: string) => <button type="button" disabled={busy} onClick={() => onNavigate(step)} style={{ ...onboardingButtonStyle, minHeight: 32, fontSize: 12 }}>{text}</button>;
  return <section style={{ width: '100%', maxWidth: 600, display: 'flex', flexDirection: 'column', gap: 18 }}>
    <div><h1 style={{ fontSize: 28, fontWeight: 400, margin: 0 }}>Your first task</h1><p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Open a draft with your lead. Review it, edit it, then send when you are ready.</p></div>
    <div style={{ border: '1px solid var(--t-divider)', borderRadius: 14, padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><span>Project: {verified?.project?.name ?? progress.project?.name ?? 'None selected'}</span>{change('repos', verified?.project ? 'Change project' : 'Choose a project')}</div>
      {progress.project && verified && !verified.project ? <span role="status" style={{ fontSize: 12 }}>This project is no longer registered. Choose it again to continue.</span> : null}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><span>Lead: {toolsReady ? setup?.inventory.find((item) => item.id === lead)?.label ?? setup?.orchestratorRuntime : 'Setup needed'}</span>{change('dispatch', toolsReady ? 'Change tools' : 'Set up tools')}</div>
      {toolsReady && setup ? <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{formatModelLabel(setup.recommendation.leadModel)} · Workers: {setup.workerRuntimes.map((id) => setup.inventory.find((item) => item.id === id)?.label ?? id).join(', ')} · {formatModelLabel(setup.recommendation.workerModel)}</span> : null}
      {!verified && !error ? <span role="status" style={{ fontSize: 12 }}>Checking project and tool readiness…</span> : null}
      {verified && !setup?.consentAnswered ? <div>Choose your privacy preferences before entering o8. {change('privacy', 'Review privacy')}</div> : null}
    </div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {[['Explain this project', EXPLAIN_PROJECT], ['Plan a change', PLAN_CHANGE], ['My own task', '']].map(([label, text]) => <button type="button" key={label} disabled={busy} onClick={() => onTaskChange(text)} style={onboardingButtonStyle}>{label}</button>)}
    </div>
    <label style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>Task draft
      <textarea aria-label="Task draft" value={progress.task} disabled={busy} maxLength={12000} onChange={(event) => onTaskChange(event.target.value)} rows={5} style={{ resize: 'vertical', width: '100%', boxSizing: 'border-box', border: '1px solid var(--t-divider-strong)', background: 'var(--t-input-bg)', color: 'var(--t-text)', borderRadius: 12, padding: 14, font: 'inherit', fontSize: 13, lineHeight: 1.6 }} />
    </label>
    {error || completionError ? <div role="alert" style={{ fontSize: 12, color: 'var(--t-danger)' }}>{error ?? completionError} <button type="button" onClick={() => { setVerified(null); setRevision((value) => value + 1); }}>Retry check</button></div> : null}
    <button type="button" disabled={!canStart || busy} onClick={() => void finish(true)} style={{ ...onboardingButtonStyle, background: 'var(--t-accent)', color: 'var(--t-success-contrast)', opacity: !canStart || busy ? 0.5 : 1 }}>{busy ? 'Opening workspace…' : 'Open first task'}</button>
    <button type="button" disabled={busy || !setup?.consentAnswered} onClick={() => void finish(false)} style={{ ...onboardingButtonStyle, border: 0 }}>Explore o8 first</button>
    <p style={{ fontSize: 11, color: 'var(--t-text-muted)', margin: 0 }}>Import conversation history later in Settings → Indexing. Connect optional features when you need them.</p>
  </section>;
}
