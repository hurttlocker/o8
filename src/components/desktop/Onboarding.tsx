'use client';

/**
 * Onboarding — Full-screen multi-step first-run experience.
 *
 * 6 steps, same glass theme throughout:
 *   1. Welcome + GitHub sign-in (feature carousel)
 *   2. Repo picker (select which repos to manage)
 *   3. Runtime detection (auto-scan installed tools)
 *   4. Default dispatch runtime (Codex / Claude Code / Gemini)
 *   5. Bring Your Brain (ChatGPT/Claude import)
 *   6. Ready (summary + enter dashboard)
 *
 * Design ref: Conductor-style glass + feature carousel.
 * Full-screen takeover, frosted glass background, no sidebar.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtractedProfile, ImportProgress } from '@/lib/connectors/chatgpt/types';
import { OnboardingDispatchStep } from './onboarding/OnboardingDispatchStep';
import { OnboardingRuntimeStep, type DetectedRuntime } from './onboarding/OnboardingRuntimeStep';
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

// ── GitHub device flow state ──

interface DeviceFlowState {
  stage: 'idle' | 'waiting' | 'polling' | 'success' | 'error';
  userCode?: string;
  verificationUrl?: string;
  error?: string;
}

// ── Repo types ──

interface GithubRepo {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
}

// ════════════════════════════════════════════════════════════
// ── Main Component ──
// ════════════════════════════════════════════════════════════

export const Onboarding = memo(function Onboarding({ onComplete, completionError }: { onComplete: () => void; completionError?: string | null }) {
  const [step, setStep] = useState<OnboardingStep>('open');

  // GitHub sign-in (used by the open step)
  const [githubFlow, setGithubFlow] = useState<DeviceFlowState>({ stage: 'idle' });
  const [githubDeviceFlowEnabled, setGithubDeviceFlowEnabled] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flowIdRef = useRef<string | null>(null);

  // Step 2: Repos
  const [githubRepos, setGithubRepos] = useState<GithubRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
  const [repoSearch, setRepoSearch] = useState('');

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
      const nextStep = STEP_ORDER[idx + 1];
      if (nextStep === 'repos') setReposLoading(true);
      setStep(nextStep);
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

  // ── Fetch repos when entering step 2 ──
  useEffect(() => {
    if (step !== 'repos') return;
    fetch('/api/panel/github-status')
      .then(r => r.json())
      .then(async (status) => {
        if (!status.authenticated) { setReposLoading(false); return; }
        // Fetch repos via gh CLI
        try {
          const res = await fetch('/api/panel/repos?source=github&limit=50');
          if (res.ok) {
            const data = await res.json();
            setGithubRepos(Array.isArray(data.repos) ? data.repos : Array.isArray(data) ? data : []);
          }
        } catch { /* silent */ }
        setReposLoading(false);
      })
      .catch(() => setReposLoading(false));
  }, [step]);

  // ── GitHub auth ──
  const csrfTokenRef = useRef<string | null>(null);
  // Hard-cap device-code polling so a wedged endpoint (persistent 5xx/429,
  // network silently dropping requests) can't leak the interval forever.
  // 5s interval × 120 attempts = 10 min — matches GitHub's device flow expiry.
  const pollAttemptsRef = useRef(0);
  const MAX_POLL_ATTEMPTS = 120;
  const startGithubFlow = useCallback(async () => {
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
            setTimeout(() => goNext(), 1000);
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

  // ── Repo selection ──
  const toggleRepo = useCallback((fullName: string) => {
    setSelectedRepos(prev => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }, []);

  const filteredRepos = useMemo(() => {
    if (!repoSearch.trim()) return githubRepos;
    const q = repoSearch.toLowerCase();
    return githubRepos.filter(r => r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
  }, [githubRepos, repoSearch]);

  const saveSelectedRepos = useCallback(async () => {
    // Register selected repos via the registry API
    for (const fullName of selectedRepos) {
      const repo = githubRepos.find(r => r.full_name === fullName);
      if (!repo) continue;
      try {
        await fetch('/api/panel/repos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cloneUrl: repo.clone_url, name: repo.name }),
        });
      } catch { /* silent */ }
    }
    goNext();
  }, [selectedRepos, githubRepos, goNext]);

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
            onSignIn={startGithubFlow}
            signInEnabled={githubDeviceFlowEnabled}
            githubFlow={githubFlow}
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
              : step === 'dispatch' ? 'Default dispatch runtime'
              : step === 'import' ? 'Make o8 yours'
              : 'You\'re all set'}
          </div>
        </div>

        {/* ── Step 2: Repo Picker ── */}
        {step === 'repos' && (
          <div style={{ maxWidth: 640, width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.5, textAlign: 'center' }}>
              Select the repositories you want o8 to manage. You can always add more later.
            </div>

            {/* Search */}
            <input
              type="text"
              value={repoSearch}
              onChange={(e) => setRepoSearch(e.target.value)}
              placeholder="Search repos..."
              style={{
                width: '100%',
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 14,
                paddingRight: 14,
                borderRadius: 10,
                border: '1px solid var(--t-glass-border-strong)',
                background: 'var(--t-glass-muted)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                color: 'var(--t-text)',
                fontSize: 13,
                fontFamily: FONT,
                outline: 'none',
                boxSizing: 'border-box',
              } as React.CSSProperties}
            />

            {/* Repo list */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              maxHeight: 340,
              overflowY: 'auto',
              paddingRight: 4,
            }}>
              {reposLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 20, justifyContent: 'center', color: 'var(--t-text-secondary)', fontSize: 13 }}>
                  <Spinner /> Loading your repositories...
                </div>
              ) : filteredRepos.length === 0 ? (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--t-text-muted)', fontSize: 13 }}>
                  {githubRepos.length === 0 ? 'No repos found. You can add repos manually from the dashboard.' : 'No repos match your search.'}
                </div>
              ) : (
                filteredRepos.map((repo) => {
                  const selected = selectedRepos.has(repo.full_name);
                  return (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => toggleRepo(repo.full_name)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 14px',
                        borderRadius: 10,
                        border: selected ? '1px solid var(--t-accent-border)' : '1px solid transparent',
                        background: selected ? 'var(--t-accent-soft)' : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontFamily: FONT,
                        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                    >
                      {/* Checkbox */}
                      <div style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: selected ? '2px solid var(--t-accent)' : '2px solid var(--t-text-faint)',
                        background: selected ? 'var(--t-accent)' : 'transparent',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'all 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}>
                        {selected && (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{repo.full_name}</div>
                        {repo.description && (
                          <div style={{ fontSize: 11, color: 'var(--t-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{repo.description}</div>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                        {repo.language && <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--t-text-faint)' }}>{repo.language}</span>}
                        {repo.private && <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 999, background: 'var(--t-divider)', color: 'var(--t-text-muted)' }}>Private</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
              <button type="button" onClick={goNext} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0 }}>Skip</button>
              <GlassButton primary onClick={saveSelectedRepos} disabled={selectedRepos.size === 0}>
                {selectedRepos.size > 0 ? `Continue with ${selectedRepos.size} repo${selectedRepos.size > 1 ? 's' : ''}` : 'Select repos to continue'}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
              </GlassButton>
            </div>
          </div>
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

        {/* ── Step 4: Default dispatch runtime ── */}
        {step === 'dispatch' && (
          <OnboardingDispatchStep
            runtimes={runtimes}
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
                {selectedRepos.size > 0 && <>{selectedRepos.size} repo{selectedRepos.size > 1 ? 's' : ''} connected. </>}
                {runtimes.filter(r => r.detected).length > 0 && <>{runtimes.filter(r => r.detected).length} runtime{runtimes.filter(r => r.detected).length > 1 ? 's' : ''} detected. </>}
                {importProfile && <>{importProfile.topics.length} topics imported. </>}
                {!selectedRepos.size && !runtimes.filter(r => r.detected).length && !importProfile && <>You can configure everything from the dashboard.</>}
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

      {/* Support link */}
      <div style={{ position: 'fixed', bottom: 16, left: 24, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--t-text-faint)' }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Get support
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes spin { to { transform: rotate(360deg); } }
      `}} />
    </div>
  );
});
