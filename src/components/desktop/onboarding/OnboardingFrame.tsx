'use client';

import type { CSSProperties, ReactNode } from 'react';
import type { OnboardingProgress } from './onboarding-progress';
import { useOnboardingMotion } from './OnboardingExperience';

const frameInset: CSSProperties = { paddingTop: 'clamp(20px, 3vh, 32px)', paddingBottom: 'clamp(20px, 3vh, 32px)',
  paddingLeft: 'clamp(20px, 4vw, 32px)', paddingRight: 'clamp(20px, 4vw, 32px)' };

export function OnboardingFrame({ progress, agentReady, children }: {
  progress: OnboardingProgress;
  agentReady: boolean;
  children: ReactNode;
}) {
  const motionRef = useOnboardingMotion(progress.step);
  const current = progress.step === 'dispatch' ? 1 : ['privacy', 'permissions', 'mobile'].includes(progress.step) ? 2 : 0;
  const workspaceDetail = progress.step === 'permissions' ? 'Optional voice setup' : progress.step === 'mobile' ? 'Optional iPhone app' : 'Privacy choices';
  const projectChosen = Boolean(progress.project);
  const steps = [
    { label: 'Project', detail: projectChosen ? progress.project!.name : current === 2 ? 'Optional' : 'Choose a folder', done: projectChosen },
    { label: 'Agent', detail: agentReady ? 'Ready' : current === 1 ? 'Choose a tool' : 'Check readiness', done: agentReady },
    { label: 'Workspace', detail: current === 2 ? workspaceDetail : 'Next', done: false },
  ];
  return <div style={{ width: '100%', maxWidth: 800, border: '1px solid var(--t-divider)', borderRadius: 16, background: 'var(--t-onboarding-bg)' }}>
    <header style={{ ...frameInset, paddingBottom: 20, borderBottom: '1px solid var(--t-divider)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <span aria-label="o8" style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-2px', lineHeight: 1 }}>o8<span aria-hidden style={{ color: 'var(--t-brand-orange)' }}>.</span></span>
        <span style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)' }}>Local workspace</span>
      </div>
      <nav aria-label="Setup progress">
        <ol style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, listStyle: 'none', margin: 0, padding: 0 }}>
          {steps.map((step, index) => <li key={step.label} aria-current={index === current ? 'step' : undefined} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, color: index === current ? 'var(--t-text)' : 'var(--t-text-muted)' }}>
            <span aria-hidden style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, flexShrink: 0, borderRadius: '50%', border: '1px solid var(--t-divider-strong)', fontSize: 11, background: index === current ? 'var(--t-input-bg)' : 'transparent' }}>{step.done && index !== current ? '✓' : index + 1}</span>
            <span style={{ minWidth: 0 }}><span style={{ display: 'block', fontSize: 12, fontWeight: 300 }}>{step.label}</span><span title={step.detail} style={{ display: 'block', marginTop: 4, fontSize: 10, fontWeight: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step.detail}</span></span>
          </li>)}
        </ol>
      </nav>
    </header>
    <div ref={motionRef} style={{ ...frameInset, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {children}
    </div>
  </div>;
}
