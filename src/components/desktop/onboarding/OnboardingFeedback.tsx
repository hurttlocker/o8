import type { ReactNode } from 'react';

export function OnboardingCheck({ size = 16 }: { size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></svg>;
}

export function OnboardingReady({ label }: { label: string }) {
  return <span role="status" aria-label={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0, minHeight: 32, paddingTop: 4, paddingBottom: 4, paddingLeft: 11, paddingRight: 12, borderRadius: 20, border: '1px solid var(--t-success-border)', background: 'var(--t-success-soft)', color: 'var(--t-success)', fontSize: 11, fontWeight: 300 }}><OnboardingCheck />Ready</span>;
}

export function OnboardingFeedback({ title, children, tone = 'success', action }: {
  title: string; children?: ReactNode; tone?: 'success' | 'error' | 'neutral'; action?: ReactNode;
}) {
  const success = tone === 'success';
  return <div role={tone === 'error' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingTop: 14, paddingBottom: 14, paddingLeft: 16, paddingRight: 16, borderRadius: 12, border: `1px solid ${success ? 'var(--t-success-border)' : 'var(--t-divider)'}`, background: success ? 'var(--t-success-soft)' : 'var(--t-bg-card)', color: success ? 'var(--t-success)' : tone === 'error' ? 'var(--t-danger)' : 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>
    {success ? <OnboardingCheck size={20} /> : null}
    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 300, lineHeight: 1.5 }}>{title}</div>{children ? <div style={{ marginTop: 4, fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{children}</div> : null}{action ? <div style={{ marginTop: 8 }}>{action}</div> : null}</div>
  </div>;
}
