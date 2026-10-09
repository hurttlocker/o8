'use client';

import { useState } from 'react';

export function SendPill({ canSubmit, working, onSubmit, onStop, targetLabel = 'orchestrator' }: {
  canSubmit: boolean;
  working: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  targetLabel?: string;
}) {
  const [pressed, setPressed] = useState(false);
  const canStop = working && Boolean(onStop);
  const interactive = canStop || (!working && canSubmit);
  const title = working ? canStop ? `Stop ${targetLabel}` : `${targetLabel} working…` : canSubmit ? 'Send (Enter)' : 'Type to send';
  return <button type="button" data-testid="composer-send-control" onClick={canStop ? onStop : onSubmit} disabled={!interactive} title={title} aria-label={title}
    onPointerDown={() => { if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) setPressed(true); }}
    onPointerUp={() => setPressed(false)} onPointerCancel={() => setPressed(false)} onPointerLeave={() => setPressed(false)} onBlur={() => setPressed(false)}
    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box', width: 32, minWidth: 32, maxWidth: 32, height: 32, minHeight: 32, padding: 0, borderRadius: '50%', borderWidth: 0, background: interactive ? 'var(--t-accent)' : 'color-mix(in srgb, var(--t-text) 14%, transparent)', color: interactive ? 'var(--t-accent-contrast, #fff)' : 'var(--t-text-secondary)', cursor: interactive ? 'pointer' : 'default', flex: '0 0 32px', opacity: working && !canStop ? 0.7 : 1 }}>
    {working ? <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ transform: pressed ? 'scale(.88)' : undefined }}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
      : <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ transform: pressed ? 'translateY(-1px)' : undefined, transition: pressed ? 'transform 120ms cubic-bezier(.22,1,.36,1)' : undefined }}><path d="M12 19V5m-6 6 6-6 6 6" /></svg>}
  </button>;
}
