'use client';

import { useState, type ReactNode } from 'react';
import type { OnboardingProject } from './onboarding-progress';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding-style';

function ProjectRow({ project, disabled, onOpen }: { project: OnboardingProject; disabled: boolean; onOpen: () => void }) {
  const [hovered, setHovered] = useState(false);
  const path = project.localPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  return <button type="button" aria-label={`Open ${project.name}`} disabled={disabled} onClick={onOpen}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    style={{ ...onboardingQuietButtonStyle, width: '100%', minHeight: 64, display: 'flex', alignItems: 'center', gap: 16, textAlign: 'left', background: hovered ? 'var(--t-hover)' : 'transparent', paddingLeft: 12, paddingRight: 12, opacity: disabled ? 0.5 : 1 }}>
    <svg aria-hidden width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: 'var(--t-text-muted)' }}><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
    <span style={{ flex: 1, minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</span>
      <span title={project.localPath} style={{ display: 'block', marginTop: 4, fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
    </span>
    <svg aria-hidden width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--t-text-muted)' }}><path d="m9 5 7 7-7 7" /></svg>
  </button>;
}

export function OnboardingOpen({ projects, loading, busy, status, tools, error, onRetry, onOpenFolder, onOpenProject, onClone, onExplore }: {
  projects: OnboardingProject[]; loading: boolean; busy: boolean; status: string;
  tools: ReactNode; error: string | null; onRetry: () => void;
  onOpenFolder: () => void; onOpenProject: (project: OnboardingProject) => void;
  onClone: () => void; onExplore: () => void;
}) {
  return <section aria-labelledby="onboarding-project-title" style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column' }}>
    <span aria-label="o8" style={{ fontSize: 28, fontWeight: 400, letterSpacing: '-2px', lineHeight: 1, marginBottom: 36 }}>o8<span aria-hidden style={{ color: 'var(--t-brand-orange)' }}>.</span></span>
    <h1 id="onboarding-project-title" style={{ margin: 0, fontSize: 'clamp(30px, 4vw, 40px)', fontWeight: 300, letterSpacing: '-1.2px', lineHeight: 1.15 }}>Open a project.</h1>
    <p style={{ marginTop: 14, marginBottom: 28, fontSize: 14, fontWeight: 300, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>Use your coding tools in one workspace.</p>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
      <button type="button" disabled={busy} onClick={onOpenFolder} style={{ ...onboardingButtonStyle, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 12, background: 'var(--t-text)', color: 'var(--t-chat-surface-bg)', borderColor: 'transparent', paddingLeft: 22, paddingRight: 22, opacity: busy ? 0.6 : 1 }}>
        <svg aria-hidden width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>
        Open a folder
      </button>
      <button type="button" disabled={busy} onClick={onClone} style={onboardingQuietButtonStyle}>Clone from GitHub</button>
    </div>
    <div role="status" aria-live="polite" style={{ minHeight: 22, marginTop: 12, fontSize: 12, color: 'var(--t-text-secondary)' }}>{busy ? status : loading ? 'Loading your projects…' : ''}</div>
    {error ? <div role="alert" style={{ marginTop: 4, marginBottom: 8, fontSize: 12, lineHeight: 1.5, color: 'var(--t-danger)' }}>{error} <button type="button" disabled={busy} onClick={onRetry} style={onboardingQuietButtonStyle}>Try again</button></div> : null}
    {projects.length > 0 ? <section aria-label="Your projects" style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 8, paddingLeft: 12, fontSize: 10, fontWeight: 300, color: 'var(--t-text-muted)', letterSpacing: '0.04em' }}>YOUR PROJECTS</div>
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>{projects.map((project) => <ProjectRow key={project.id} project={project} disabled={busy} onOpen={() => onOpenProject(project)} />)}</div>
    </section> : null}
    <div style={{ borderTop: '1px solid var(--t-divider)', marginTop: 28, paddingTop: 12 }}>{tools}</div>
    <button type="button" disabled={busy} onClick={onExplore} style={{ ...onboardingQuietButtonStyle, alignSelf: 'flex-start', marginTop: 12, paddingLeft: 0, color: 'var(--t-text-muted)', fontSize: 12 }}>Start without a project</button>
  </section>;
}
