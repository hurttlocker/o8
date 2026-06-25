'use client';

/**
 * OnboardingOpen — the cinematic first beat, shared design language with the
 * canvas welcome (split-glass card: copy + dual-door CTA on the left, the brand
 * reveal on the right). The right pane is our Aurora ASCII o8 reveal.
 *
 * Dual-audience by design: a novice takes [Set up o8] (the guided path); a pro
 * takes [I already know o8] (the fast lane straight to the workspace). Free-
 * forever is stated up front; GitHub sign-in is quiet + optional.
 *
 * THEME-AWARE: card/ink/CTAs use --t-* tokens; the ASCII pane resolves its
 * colors from the live theme (re-resolved on theme toggle). Inline styles only
 * (Tauri/WebKit).
 */

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AsciiImage } from '@/app/preview/effects/AsciiImage';
import { playOnboardingCue } from './onboarding-sound';

const FONT = 'var(--font-sans-system)';
const ACCENT = 'var(--t-brand-orange, #FF5A1F)';

export interface GithubFlowLite {
  stage: 'idle' | 'waiting' | 'polling' | 'success' | 'error';
  userCode?: string;
  error?: string;
}

/** Resolve the ASCII stage colors from the live theme, re-reading on toggle. */
function useStageColors(): { bg: string; glyph: string } {
  const [colors, setColors] = useState<{ bg: string; glyph: string }>({ bg: '#08080b', glyph: '#ff7a18' });
  useEffect(() => {
    const lum = (c: string): number => {
      try {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.appendChild(el);
        const rgb = getComputedStyle(el).color;
        document.body.removeChild(el);
        const m = rgb.match(/(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)/);
        if (!m) return 0;
        return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
      } catch {
        return 0;
      }
    };
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const surface = cs.getPropertyValue('--t-chat-surface-bg').trim() || '#08080b';
      const dark = lum(surface) < 0.5;
      // Amber pops on dark; a deeper ember reads crisply on a paper surface.
      setColors({ bg: surface, glyph: dark ? '#ff7a18' : '#d65a12' });
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-palette', 'data-surface'] });
    return () => obs.disconnect();
  }, []);
  return colors;
}

export function OnboardingOpen({
  onSetup,
  onFastLane,
  onSignIn,
  signInEnabled,
  githubFlow,
  onPrivacy,
}: {
  onSetup: () => void;
  onFastLane: () => void;
  onSignIn: () => void;
  signInEnabled: boolean;
  githubFlow: GithubFlowLite;
  onPrivacy: () => void;
}) {
  const stage = useStageColors();
  const signedIn = githubFlow.stage === 'success';
  const signingIn = githubFlow.stage === 'waiting' || githubFlow.stage === 'polling';

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--t-chat-surface-bg)',
        fontFamily: FONT,
      }}
    >
      <AnimatePresence>
        <motion.div
          initial={{ scale: 0.94, opacity: 0, y: 16 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 360, damping: 28 }}
          style={{
            position: 'relative',
            display: 'flex',
            width: 'min(820px, calc(100vw - 96px))',
            maxHeight: 'calc(100vh - 140px)',
            borderRadius: 24,
            overflow: 'hidden',
            border: '1px solid var(--t-glass-border-strong)',
            boxShadow: 'var(--t-glass-shadow, 0 40px 120px rgba(0, 0, 0, 0.4))',
          }}
        >
          {/* ── Left pane — copy + dual-door CTA (themed glass) ──────────── */}
          <div
            style={{
              flex: '0 0 48%',
              display: 'flex',
              flexDirection: 'column',
              paddingTop: 40,
              paddingBottom: 36,
              paddingLeft: 38,
              paddingRight: 34,
              background: 'var(--t-glass-muted-strong)',
              backdropFilter: 'blur(32px) saturate(1.4)',
              WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
              color: 'var(--t-text)',
            }}
          >
            {/* eyebrow — wordmark + free-forever pill */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 'auto' }}>
              <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '0.02em', color: 'var(--t-text-strong)' }}>o8</span>
              <span
                style={{
                  fontSize: 8.5,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--t-brand-orange, #FF5A1F)',
                  background: 'color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 14%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--t-brand-orange, #FF5A1F) 32%, transparent)',
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingLeft: 6,
                  paddingRight: 6,
                  borderRadius: 999,
                }}
              >
                Free forever
              </span>
            </div>

            <h1
              style={{
                margin: 0,
                marginTop: 26,
                fontSize: 30,
                fontWeight: 300,
                lineHeight: 1.14,
                letterSpacing: '-0.02em',
                color: 'var(--t-text-strong)',
              }}
            >
              Run an AI engineering
              <br />
              team. Keep control.
            </h1>

            <p
              style={{
                margin: 0,
                marginTop: 16,
                fontSize: 13,
                fontWeight: 400,
                lineHeight: 1.6,
                letterSpacing: '-0.1px',
                color: 'var(--t-text-secondary)',
              }}
            >
              o8 sends coding agents to work in an isolated copy of your repo — you
              review and approve every merge. It runs on your machine, with your own
              tools. Free, always.
            </p>

            {/* dual-door CTAs */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 28 }}>
              <button
                type="button"
                onClick={() => { playOnboardingCue('advance'); onSetup(); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  height: 42,
                  paddingLeft: 20,
                  paddingRight: 18,
                  borderRadius: 999,
                  borderWidth: 0,
                  background: ACCENT,
                  color: '#fff',
                  fontSize: 13.5,
                  fontWeight: 600,
                  letterSpacing: '0.01em',
                  cursor: 'pointer',
                  fontFamily: FONT,
                  boxShadow: '0 8px 24px rgba(255, 90, 31, 0.32)',
                  transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 12px 30px rgba(255, 90, 31, 0.42)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 90, 31, 0.32)'; }}
              >
                Set up o8
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>

              <button
                type="button"
                onClick={() => { playOnboardingCue('tick'); onFastLane(); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 7,
                  height: 40,
                  paddingLeft: 18,
                  paddingRight: 16,
                  borderRadius: 999,
                  border: '1px solid var(--t-glass-border-strong)',
                  background: 'var(--t-glass-muted)',
                  color: 'var(--t-text-strong)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  transition: 'background 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
              >
                I already know o8 — take me in
              </button>
            </div>

            {/* quiet sign-in + privacy */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, minHeight: 18 }}>
              {signedIn ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t-accent)' }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                  Signed in
                </span>
              ) : signInEnabled ? (
                <button
                  type="button"
                  onClick={() => { playOnboardingCue('tick'); onSignIn(); }}
                  disabled={signingIn}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', fontSize: 12, cursor: signingIn ? 'default' : 'pointer', fontFamily: FONT, padding: 0 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" /></svg>
                  {signingIn ? `Connecting…${githubFlow.userCode ? ` (${githubFlow.userCode})` : ''}` : 'Sign in with GitHub'}
                </button>
              ) : null}
              <button type="button" onClick={onPrivacy} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0, textDecoration: 'underline', textUnderlineOffset: 3 }}>Privacy</button>
            </div>
            {githubFlow.stage === 'error' && githubFlow.error ? (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--t-brand-red, #ef9a9a)' }}>{githubFlow.error}</div>
            ) : null}
          </div>

          {/* ── Right pane — Aurora ASCII o8 reveal (theme-resolved) ─────── */}
          <div
            style={{
              flex: '1 1 52%',
              position: 'relative',
              borderLeft: '1px solid var(--t-glass-border-strong)',
              background: stage.bg,
              overflow: 'hidden',
            }}
          >
            <AsciiImage
              text="o8"
              color={stage.glyph}
              backgroundColor={stage.bg}
              cellSize={11}
              speed={1}
              baseLevel={0.42}
              waveBoost={0.95}
              contrast={1.25}
              cursorRipple={26}
              cursorRadius={0.22}
              width="100%"
              height="100%"
            />
          </div>
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export default OnboardingOpen;
