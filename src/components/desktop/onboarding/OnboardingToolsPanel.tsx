'use client';

import { useEffect, useRef, useState } from 'react';
import type { SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { getRuntimeInstallInfo } from '@/lib/setup/runtime-install';
import { getRuntimeSignInInfo, type RuntimeSignInInfo } from '@/lib/setup/runtime-sign-in';
import { OnboardingSignIn } from './OnboardingSignIn';
import { onboardingButtonStyle } from './onboarding-style';
import { runtimeReadinessLabel } from './AgentReadiness';
import { RuntimeIdentity } from './RuntimeIdentity';
import { ExternalLink } from '../lucide-shims';
import { useToolScanStatus } from './useToolScanStatus';

export function OnboardingToolsPanel({ inventory, loading, disabled, scanError = null, allowTerminal = true, onRefresh, onRecoveryStart, onRecoveryEnd }: {
  inventory: readonly SetupRuntime[];
  loading: boolean;
  disabled?: boolean;
  scanError?: string | null;
  allowTerminal?: boolean;
  onRefresh: () => void;
  onRecoveryStart: () => void;
  onRecoveryEnd: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{ runtime: SetupRuntime; info: RuntimeSignInInfo } | null>(null);
  const recoveryButtons = useRef(new Map<string, HTMLButtonElement>());
  const restoreFocus = useRef<string | null>(null);
  useEffect(() => {
    if (recovery || !restoreFocus.current) return;
    const target = recoveryButtons.current.get(restoreFocus.current)
      ?? document.querySelector<HTMLButtonElement>('[data-onboarding-agent-setup] [data-onboarding-back-to-choices]');
    target?.focus(); restoreFocus.current = null;
  }, [recovery]);
  const scanStatus = useToolScanStatus(loading);
  if (recovery) return <section id="onboarding-tool-setup" aria-label="Tool setup">
    <OnboardingSignIn runtime={inventory.find((item) => item.id === recovery.runtime.id) ?? recovery.runtime} info={recovery.info}
      loading={loading} disabled={disabled} scanError={scanError} allowTerminal={allowTerminal} onRefresh={onRefresh} onClose={() => {
        restoreFocus.current = recovery.runtime.id; setRecovery(null); onRecoveryEnd();
      }} />
  </section>;
  return <section id="onboarding-tool-setup" aria-label="Tool setup" aria-busy={loading} style={{ display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--font-sans-system)' }}>
    <div style={{ maxHeight: 'clamp(160px, calc(100dvh - 520px), 320px)', overflowY: 'auto', border: '1px solid var(--t-divider)', borderRadius: 12, background: 'var(--t-bg-card)' }}>
      {inventory.map((item, index) => {
        const info = getRuntimeInstallInfo(item.id);
        const command = item.unavailableReason === 'not_installed' ? info?.command : undefined;
        const signIn = getRuntimeSignInInfo(item);
        return <div key={item.id} style={{ padding: 16, borderTop: index ? '1px solid var(--t-divider)' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <RuntimeIdentity runtime={item.id} />
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 300, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>{item.label}</span>
            <span style={{ fontSize: 11, color: item.available ? 'var(--t-success)' : 'var(--t-text-muted)' }}>{runtimeReadinessLabel(item)}</span>
          </div>
          {!item.available ? <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)', overflowWrap: 'anywhere' }}>{item.fix || info?.hint || item.detail}</p>
            {signIn ? <button ref={(element) => { if (element) recoveryButtons.current.set(item.id, element); else recoveryButtons.current.delete(item.id); }} type="button" disabled={disabled || loading}
              style={{ ...onboardingButtonStyle, alignSelf: 'flex-start' }} onClick={() => {
                onRecoveryStart(); setRecovery({ runtime: item, info: signIn });
              }}>Sign in to {item.label}</button> : null}
            {command ? <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <code style={{ flex: 1, minWidth: 0, padding: 12, borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', fontSize: 12, overflowWrap: 'anywhere' }}>{command}</code>
              <button type="button" aria-label={`Copy ${item.label} install command`} disabled={disabled || copying !== null} style={onboardingButtonStyle} onClick={async () => {
                setCopying(item.id); setCopied(null); setCopyError(null);
                try { await navigator.clipboard.writeText(command); setCopied(item.id); }
                catch { setCopyError(item.label); }
                finally { setCopying(null); }
              }}>{copying === item.id ? 'Copying…' : copied === item.id ? 'Copied' : 'Copy command'}</button>
            </div> : null}
            {info?.link ? <a href={info.link} target="_blank" rel="noopener noreferrer" style={{ ...onboardingButtonStyle, alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', textDecoration: 'none', gap: 8 }}>Open {item.label} setup instructions<ExternalLink size={14} aria-hidden="true" /></a> : null}
          </div> : null}
        </div>;
      })}
      {!inventory.length ? <p style={{ padding: 16, margin: 0, fontSize: 12, color: 'var(--t-text-secondary)' }}>No tool inventory was returned. Refresh to try again.</p> : null}
    </div>
    {copyError ? <p role="alert" style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>Clipboard unavailable for {copyError}. Select the command above to copy it, or use the tool’s setup instructions.</p> : null}
    <div role="status" aria-live="polite" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{loading ? scanStatus : copied ? `${inventory.find((item) => item.id === copied)?.label ?? 'Tool'} install command copied.` : 'Finish the tool’s setup, then refresh to check it. Your project, agent, and workers stay selected.'}</div>
  </section>;
}
