'use client';

import { useEffect, useRef, useState } from 'react';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import type { RuntimeSignInInfo } from '@/lib/setup/runtime-sign-in';
import { OnboardingSignInTerminal } from './OnboardingSignInTerminal';
import { onboardingButtonStyle, onboardingQuietButtonStyle } from './onboarding-style';
import { RuntimeIdentity } from './RuntimeIdentity';

export function OnboardingSignIn({ runtime, info, loading, scanError, disabled, allowTerminal, onRefresh, onClose }: {
  runtime: SetupRuntime; info: RuntimeSignInInfo; loading: boolean; scanError: string | null;
  disabled?: boolean; allowTerminal: boolean; onRefresh: () => void; onClose: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const terminalButtonRef = useRef<HTMLButtonElement>(null);
  const restoreTerminalFocus = useRef(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => { headingRef.current?.focus(); }, []);
  useEffect(() => {
    if (!terminalOpen && restoreTerminalFocus.current) {
      (terminalButtonRef.current ?? headingRef.current)?.focus(); restoreTerminalFocus.current = false;
    }
  }, [terminalOpen]);
  const ready = runtime.available && !loading && !scanError;
  return <section aria-labelledby="onboarding-sign-in-title" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <RuntimeIdentity runtime={runtime.id} />
      <h1 ref={headingRef} id="onboarding-sign-in-title" tabIndex={-1} style={{ margin: 0, fontSize: 28, fontWeight: 300, outline: 'none' }}>Sign in to {runtime.label}</h1>
    </div>
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{info.instruction} Come back here to check it. Your project and tool choices stay selected.</p>
    {info.command ? <>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <code style={{ flex: 1, minWidth: 0, padding: 12, borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 12, overflowWrap: 'anywhere', userSelect: 'text' }}>{info.command}</code>
        <button type="button" aria-label={`Copy ${runtime.label} sign-in command`} disabled={disabled || copying} style={onboardingButtonStyle} onClick={async () => {
          setCopying(true); setCopied(false); setCopyError(false);
          try { await navigator.clipboard.writeText(info.command!); setCopied(true); }
          catch { setCopyError(true); }
          finally { setCopying(false); }
        }}>{copying ? 'Copying…' : copied ? 'Copied' : 'Copy command'}</button>
      </div>
      {copyError ? <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>Clipboard unavailable. Select the command above to copy it manually.</p> : null}
      {copied ? <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>{runtime.label} sign-in command copied. Run it in your terminal, then check sign-in.</p> : null}
      {terminalOpen ? <OnboardingSignInTerminal command={info.command} onClose={() => { restoreTerminalFocus.current = true; setTerminalOpen(false); }} /> : allowTerminal && !ready ? <button ref={terminalButtonRef} type="button" disabled={disabled} onClick={() => setTerminalOpen(true)} style={{ ...onboardingButtonStyle, alignSelf: 'flex-start' }}>Open sign-in terminal</button> : null}
    </> : null}
    <div role="status" aria-live="polite" aria-atomic="true" style={{ padding: 12, borderRadius: 10, background: 'var(--t-input-bg)', fontSize: 12, lineHeight: 1.5, color: ready ? 'var(--t-success)' : 'var(--t-text-secondary)' }}>
      {loading ? 'Checking sign-in…' : scanError ? 'Could not check sign-in. Your instructions and selections are kept. Try again.' : ready ? `${runtime.label} is ready. Continue with your setup below.` : 'Sign-in is not confirmed yet. Finish the tool’s instructions, then check again.'}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" disabled={disabled || loading} onClick={onRefresh} style={onboardingButtonStyle}>{loading ? 'Checking sign-in…' : 'Check sign-in'}</button>
      <button type="button" disabled={disabled} onClick={onClose} style={onboardingQuietButtonStyle}>Back to tools</button>
    </div>
  </section>;
}
