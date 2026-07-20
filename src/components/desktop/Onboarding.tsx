'use client';

/**
 * Onboarding — Full-screen multi-step first-run experience.
 *
 * 6 steps, same glass theme throughout:
 *   1. Welcome + GitHub sign-in (feature carousel)
 *   2. Repo picker (select which repos to manage)
 *   3. Runtime detection (auto-scan installed tools)
 *   4. Orchestrator and worker runtime selection
 *   5. Bring Your Brain (ChatGPT/Claude import)
 *   6. Ready (summary + enter dashboard)
 *
 * Design ref: Conductor-style glass + feature carousel.
 * Full-screen takeover, frosted glass background, no sidebar.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractedProfile, ImportProgress } from '@/lib/connectors/chatgpt/types';
import { OnboardingDispatchStep } from './onboarding/OnboardingDispatchStep';
import { OnboardingRuntimeStep, type DetectedRuntime } from './onboarding/OnboardingRuntimeStep';
import { OnboardingReposStep, type DeviceFlowState } from './onboarding/OnboardingReposStep';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { OnboardingOpen } from './onboarding/OnboardingOpen';
import { playOnboardingCue } from './onboarding/onboarding-sound';

// ── Shared constants ──

type OnboardingStep = 'open' | 'repos' | 'runtimes' | 'dispatch' | 'import' | 'ready';

const STEP_ORDER: OnboardingStep[] = ['open', 'repos', 'runtimes', 'dispatch', 'import', 'ready'];

const FONT = 'var(--font-sans-system)';

// ── Shared UI helpers ──

function GlassCard({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement> & { style?: React.CSSProperties }) {
  return (
    <div
      {...props}
      style={{
        padding: '16px 20px',
        borderRadius: 14,
        background: 'var(--t-glass-muted-strong)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid var(--t-glass-border-strong)',
        ...style,
      } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

function GlassButton({ children, style, primary, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      {...props}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        paddingTop: 12,
        paddingBottom: 12,
        paddingLeft: 18,
        paddingRight: 22,
        borderRadius: 12,
        border: primary ? 'none' : '1px solid var(--t-glass-border-strong)',
        background: primary ? 'var(--t-accent)' : 'var(--t-glass-muted-strong)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        color: primary ? '#ffffff' : 'var(--t-text-strong)',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: FONT,
        cursor: props.disabled ? 'default' : 'pointer',
        letterSpacing: '-0.01em',
        transition: 'background 200ms cubic-bezier(0.22, 1, 0.36, 1), transform 100ms cubic-bezier(0.22, 1, 0.36, 1)',
        opacity: props.disabled ? 0.5 : 1,
        ...style,
      } as React.CSSProperties}
    >
      {children}
    </button>
  );
}

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: '2px solid var(--t-text-faint)',
      borderTopColor: 'var(--t-accent)',
      animation: 'spin 1s linear infinite',
      flexShrink: 0,
    }} />
  );
}

function StepIndicator({ steps, current }: { steps: OnboardingStep[]; current: OnboardingStep }) {
  const idx = steps.indexOf(current);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {steps.map((s, i) => (
        <div
          key={s}
          style={{
            width: i === idx ? 20 : 8,
            height: 8,
            borderRadius: 4,
            background: i < idx ? 'var(--t-accent)' : i === idx ? 'var(--t-text-secondary)' : 'var(--t-text-faint)',
            transition: 'width 300ms cubic-bezier(0.22, 1, 0.36, 1), background 300ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      ))}
    </div>
  );
}

// ── GitHub device flow state (DeviceFlowState imported from OnboardingReposStep) ──

// ════════════════════════════════════════════════════════════
// ── Main Component ──
// ════════════════════════════════════════════════════════════

export const Onboarding = memo(function Onboarding({ onComplete, completionError }: { onComplete: () => void; completionError?: string | null }) {
  const [step, setStep] = useState<OnboardingStep>('open');

  // "Get support" popover (bottom-left). Report-an-issue works during
  // onboarding because ReportIssueHost is mounted in the same dashboard tree.
  const [supportOpen, setSupportOpen] = useState(false);

  // GitHub sign-in (used by the open step)
  const [githubFlow, setGithubFlow] = useState<DeviceFlowState>({ stage: 'idle' });
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flowIdRef = useRef<string | null>(null);

  // Step 2: Repos — the repos step owns its own fetch/selection state; the parent
  // only keeps the final configured count for the "ready" summary.
  const [configuredRepoCount, setConfiguredRepoCount] = useState(0);

  // Step 3: Runtimes
  const [runtimes, setRuntimes] = useState<DetectedRuntime[]>([]);

  // Step 4: Import
  const [importStatus, setImportStatus] = useState<ImportProgress['stage']>('uploading');
  const [importProfile, setImportProfile] = useState<ExtractedProfile | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Step navigation ──
  const goNext = useCallback(() => {
    const idx = STEP_ORDER.indexOf(step);
    if (idx < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[idx + 1]);
    }
  }, [step]);

  // ── Cleanup timers ──
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  // ── Gate GitHub device CTA unless the bundled app has OAuth configured ──
  useEffect(() => {
    fetch('/api/panel/github-status')
      .then(r => r.ok ? r.json() : null)
      .then(status => setGithubDeviceFlowEnabled(Boolean(status?.deviceFlowEnabled)))
      .catch(() => setGithubDeviceFlowEnabled(false));
  }, []);

  // ── GitHub auth ──
  const csrfTokenRef = useRef<string | null>(null);
  // Hard-cap device-code polling so a wedged endpoint (persistent 5xx/429,
  // network silently dropping requests) can't leak the interval forever.
  // 5s interval × 120 attempts = 10 min — matches GitHub's device flow expiry.
  const pollAttemptsRef = useRef(0);
  const MAX_POLL_ATTEMPTS = 120;
  const startGithubFlow = useCallback(async (onSuccess?: () => void) => {
    setGithubFlow({ stage: 'waiting' });
    pollAttemptsRef.current = 0;
    try {
      const res = await fetch('/api/panel/github-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setGithubFlow({ stage: 'error', error: d.error || `Auth failed (${res.status})` });
        return;
      }
      const d = await res.json();
      flowIdRef.current = d.flowId;
      csrfTokenRef.current = d.csrfToken ?? null;
      setGithubFlow({ stage: 'polling', userCode: d.userCode, verificationUrl: d.verificationUriComplete || d.verificationUri });
      if (d.verificationUriComplete || d.verificationUri) openExternalUrl(d.verificationUriComplete || d.verificationUri);
      pollTimerRef.current = setInterval(async () => {
        if (!flowIdRef.current) return;
        pollAttemptsRef.current += 1;
        if (pollAttemptsRef.current > MAX_POLL_ATTEMPTS) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setGithubFlow({ stage: 'error', error: 'Authorization timed out. Try again.' });
          return;
        }
        try {
          const pr = await fetch('/api/panel/github-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'poll', flowId: flowIdRef.current, csrfToken: csrfTokenRef.current }) });
          if (!pr.ok) return;
          const pd = await pr.json();
          if (pd.status === 'complete') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGithubFlow({ stage: 'success' });
            // From the open step, advance forward; from the repos step, the caller
            // passes onSuccess (re-fetch repos + stay put).
            if (onSuccess) setTimeout(() => onSuccess(), 1000);
            else setTimeout(() => goNext(), 1000);
          } else if (pd.status === 'expired' || pd.error) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setGithubFlow({ stage: 'error', error: pd.error || 'Expired. Try again.' });
          }
        } catch { /* keep polling — but the attempt counter still ticks, so we'll bail at the cap */ }
      }, 5000);
    } catch {
      setGithubFlow({ stage: 'error', error: 'Network error.' });
    }
  }, [goNext]);

  // ── Import ──
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportStatus('parsing');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/connectors/chatgpt', { method: 'POST', body: formData });
      if (!res.ok) {
        setImportStatus('error');
        return;
      }
      const data = await res.json();
      setImportProfile(data.profile ?? null);
      setImportStatus('done');
    } catch {
      setImportStatus('error');
    }
  }, []);

  // ═════════════════════════════════════════
  // ── Render ──
  // ═════════════════════════════════════════

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 99998, display: 'flex', flexDirection: 'column', background: 'var(--t-chat-surface-bg)' }}
    >
      {/* Drag region */}
      <div data-tauri-drag-region="" style={{ height: 44, flexShrink: 0, WebkitAppRegion: 'drag' as unknown as string } as React.CSSProperties} />

      {/* Content */}
      <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 48px 48px', minHeight: 0, overflow: 'auto' }}>

        {step === 'open' ? (
          <OnboardingOpen
            onSetup={goNext}
            onFastLane={onComplete}
            onPrivacy={() => openExternalUrl('https://o8.run/privacy')}
          />
        ) : (
        <>

        {/* Logo — always visible */}
        <div style={{ marginBottom: 36, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--t-text-strong)', fontFamily: FONT }}>o8</div>
          <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>
            {step === 'repos' ? 'Choose your repositories'
              : step === 'runtimes' ? 'Your assistant engine'
              : step === 'dispatch' ? 'Choose your runtimes'
              : step === 'import' ? 'Make o8 yours'
              : 'You\'re all set'}
          </div>
        </div>

        {/* ── Step 2: Repo Picker ── */}
        {step === 'repos' && (
          <OnboardingReposStep
            deviceFlowEnabled={githubDeviceFlowEnabled}
            githubFlow={githubFlow}
            onConnectGithub={(onSuccess) => { void startGithubFlow(onSuccess); }}
            onSkip={goNext}
            onContinue={(count) => { setConfiguredRepoCount(count); goNext(); }}
            renderContinueButton={({ label, onClick, disabled }) => (
              <GlassButton primary onClick={onClick} disabled={disabled}>
                {label}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </GlassButton>
            )}
          />
        )}

        {/* ── Step 3: Runtime Detection ── */}
        {step === 'runtimes' && (
          <OnboardingRuntimeStep
            runtimes={runtimes}
            onRuntimesChange={setRuntimes}
            onContinue={goNext}
            renderButton={({ label, onClick }) => (
              <GlassButton primary onClick={onClick}>
                {label}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </GlassButton>
            )}
          />
        )}

        {/* ── Step 4: Orchestrator + worker runtime selection ── */}
        {step === 'dispatch' && (
          <OnboardingDispatchStep
            onContinue={goNext}
            onSkip={goNext}
            renderButton={({ label, onClick, disabled }) => (
              <GlassButton primary onClick={onClick} disabled={disabled}>
                {label}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </GlassButton>
            )}
          />
        )}

        {/* ── Step 5: Bring Your Brain ── */}
        {step === 'import' && (
          <div style={{ maxWidth: 560, width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5, textAlign: 'center' }}>
              Import your AI conversation history so o8 already knows you.
            </div>

            {importStatus === 'uploading' && !importProfile && (
              <>
                {/* ChatGPT import card */}
                <GlassCard
                  style={{ cursor: 'pointer', textAlign: 'center', padding: '32px 24px' }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div style={{ fontSize: 28, marginBottom: 12 }}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                    </svg>
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', marginBottom: 4 }}>Upload ChatGPT Export</div>
                  <div style={{ fontSize: 12, color: 'var(--t-text-muted)', lineHeight: 1.5 }}>
                    Go to ChatGPT Settings &rarr; Data Controls &rarr; Export data.
                    <br />Upload the ZIP file here.
                  </div>
                </GlassCard>

                <input ref={fileInputRef} type="file" accept=".zip,.json" onChange={handleImportFile} style={{ display: 'none' }} />
              </>
            )}

            {importStatus === 'parsing' && (
              <GlassCard style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: 24 }}>
                <Spinner size={18} />
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-text)' }}>Analyzing your conversations...</div>
              </GlassCard>
            )}

            {importStatus === 'error' && (
              <GlassCard style={{ textAlign: 'center', padding: 24 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#ef4444', marginBottom: 8 }}>Import failed</div>
                <div style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>The file may be corrupted or in an unexpected format.</div>
                <GlassButton style={{ marginTop: 16 }} onClick={() => { setImportStatus('uploading'); setImportProfile(null); }}>Try again</GlassButton>
              </GlassCard>
            )}

            {importStatus === 'done' && importProfile && (
              <GlassCard style={{ padding: 24 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-text)', marginBottom: 12 }}>Here&apos;s what we learned</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>
                    Analyzed <strong style={{ color: 'var(--t-text)' }}>{importProfile.conversationCount}</strong> conversations
                  </div>
                  {importProfile.topics.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>Interests</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {importProfile.topics.slice(0, 8).map(t => (
                          <span key={t.name} style={{ fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 999, background: 'var(--t-accent-soft)', color: 'var(--t-accent)', border: '1px solid var(--t-accent-border)' }}>{t.name}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {importProfile.tools.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>Tools</div>
                      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{importProfile.tools.slice(0, 6).map(t => t.name).join(', ')}</div>
                    </div>
                  )}
                  {importProfile.unfinishedThreads.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--t-text-muted)', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>Unfinished projects</div>
                      <div style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>{importProfile.unfinishedThreads.length} conversations where you started building something</div>
                    </div>
                  )}
                </div>
              </GlassCard>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <button type="button" onClick={goNext} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0 }}>Skip</button>
              {(importStatus === 'done' || importStatus === 'uploading') && (
                <GlassButton primary onClick={goNext}>
                  {importStatus === 'done' ? 'Continue' : 'Skip import'}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                </GlassButton>
              )}
            </div>
          </div>
        )}

        {/* ── Step 6: Ready ── */}
        {step === 'ready' && (
          <div style={{ maxWidth: 480, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24 }}>
            <GlassCard style={{ width: '100%', padding: 28, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-text)', marginBottom: 8 }}>Ready to go</div>
              <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.6 }}>
                {configuredRepoCount > 0 && <>{configuredRepoCount} repo{configuredRepoCount > 1 ? 's' : ''} connected. </>}
                {runtimes.filter(r => r.detected).length > 0 && <>{runtimes.filter(r => r.detected).length} runtime{runtimes.filter(r => r.detected).length > 1 ? 's' : ''} detected. </>}
                {importProfile && <>{importProfile.topics.length} topics imported. </>}
                {!configuredRepoCount && !runtimes.filter(r => r.detected).length && !importProfile && <>You can configure everything from the dashboard.</>}
              </div>
            </GlassCard>

            {/* Free-forever + optional Founding Operator close (never gating) */}
            <div style={{ width: '100%', paddingTop: 16, paddingBottom: 16, paddingLeft: 18, paddingRight: 18, borderRadius: 14, border: '1px solid var(--t-glass-border-strong)', background: 'var(--t-glass-muted)', display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)' }}>o8 is free, forever.</div>
              <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', lineHeight: 1.55 }}>
                Your keys, your machine. If it earns a place in your stack, back the build as a Founding Operator — lifetime managed inference and your own operator number. Optional, always.
              </div>
              <button
                type="button"
                onClick={() => openExternalUrl('https://o8.run/founding')}
                style={{ alignSelf: 'flex-start', marginTop: 4, border: 'none', background: 'transparent', color: 'var(--t-brand-orange, #FF5A1F)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: FONT, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                Become a Founding Operator
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 18 6-6-6-6" /></svg>
              </button>
            </div>

            <GlassButton primary onClick={() => { playOnboardingCue('complete'); onComplete(); }} style={{ paddingLeft: 28, paddingRight: 28 }}>
              Enter o8
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </GlassButton>
            {completionError ? (
              <div style={{ maxWidth: 420, textAlign: 'center', fontSize: 12, lineHeight: 1.5, color: 'var(--t-brand-red)' }}>
                {completionError}
              </div>
            ) : null}
          </div>
        )}

        {/* Step indicator */}
        <div style={{ marginTop: 32, flexShrink: 0 }}>
          <StepIndicator steps={STEP_ORDER} current={step} />
        </div>
        </>
        )}
      </div>

      {/* Support link — beta report 1523575745765703752: this was a dead div.
          Now a popover: report an issue (opens the report modal with a window
          capture attached) + docs. The report path is the direct support line. */}
      <div style={{ position: 'fixed', bottom: 16, left: 24, zIndex: 40 }}>
        {supportOpen && (
          <div
            style={{
              position: 'absolute',
              bottom: 34,
              left: 0,
              width: 264,
              padding: 6,
              borderRadius: 14,
              background: 'var(--t-glass-muted-strong)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid var(--t-glass-border-strong)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.18)',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            } as React.CSSProperties}
          >
            <button
              type="button"
              onClick={() => { setSupportOpen(false); window.dispatchEvent(new Event('o8:open-report')); }}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', border: 'none', background: 'transparent', borderRadius: 10, paddingTop: 9, paddingBottom: 9, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', fontFamily: FONT, textAlign: 'left' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-glass-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t-text)' }}>Report an issue</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>Sends a note + screenshot straight to the team</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => { setSupportOpen(false); openExternalUrl('https://o8.run/docs'); }}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', border: 'none', background: 'transparent', borderRadius: 10, paddingTop: 9, paddingBottom: 9, paddingLeft: 10, paddingRight: 10, cursor: 'pointer', fontFamily: FONT, textAlign: 'left' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--t-glass-muted)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--t-text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t-text)' }}>Docs &amp; FAQ</span>
                <span style={{ fontSize: 11, color: 'var(--t-text-muted)', lineHeight: 1.45 }}>Guides at o8.run/docs</span>
              </span>
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setSupportOpen((v) => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: supportOpen ? 'var(--t-text-secondary)' : 'var(--t-text-faint)', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: FONT, padding: 0 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Get support
        </button>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
});
