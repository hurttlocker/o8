'use client';

/**
 * OnboardingOpen — the cinematic first beat, shared design language with the
 * canvas welcome (split-glass card: copy + dual-door CTA on the left, the brand
 * reveal on the right). The right pane is our Aurora ASCII o8 reveal.
 *
 * Dual-audience by design: a novice takes [Set up o8] (the guided path); a pro
 * takes [I already know o8] (the fast lane straight to the workspace). Free-
 * forever is stated up front; o8 account sign-in is quiet + optional.
 *
 * THEME-AWARE: card/ink/CTAs use --t-* tokens; the ASCII pane resolves its
 * colors from the live theme (re-resolved on theme toggle). Inline styles only
 * (Tauri/WebKit).
 */

import { AnimatePresence, motion } from 'framer-motion';
import { OnboardingReveal, useStageColors } from './kit/OnboardingReveal';
import { playOnboardingCue } from './onboarding-sound';
import { useO8Auth } from '@/components/auth/O8AuthProvider';

const FONT = 'var(--font-sans-system)';
const ACCENT = 'var(--t-brand-orange, #FF5A1F)';

export function OnboardingOpen({
  onSetup,
  onFastLane,
  onPrivacy,
}: {
  onSetup: () => void;
  onFastLane: () => void;
  onPrivacy: () => void;
}) {
  const stage = useStageColors();
  // The onboarding sign-in is the o8 ACCOUNT (Clerk via the o8:// ticket handoff)
  // — the identity that carries the founder badge, usage, and entitlement. It is
  // NOT the repo-access grant (that's the device flow, in the repo step, framed
  // as "Connect your GitHub repos"). One account sign-in here, one repo grant
  // there, so account identity and repository access remain distinct.
  const auth = useO8Auth();

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

            {/* quiet o8-account sign-in + privacy */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18, minHeight: 18 }}>
              {auth.signedIn ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t-accent)' }}>
                  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                  Signed in{auth.user?.name ? ` as ${auth.user.name}` : ''}
                </span>
              ) : auth.clerkEnabled ? (
                <button
                  type="button"
                  onClick={() => { playOnboardingCue('tick'); auth.signIn(); }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, border: 'none', background: 'transparent', color: 'var(--t-text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0 }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                  Sign in to o8
                </button>
              ) : null}
              <button type="button" onClick={onPrivacy} style={{ border: 'none', background: 'transparent', color: 'var(--t-text-faint)', fontSize: 12, cursor: 'pointer', fontFamily: FONT, padding: 0, textDecoration: 'underline', textUnderlineOffset: 3 }}>Privacy</button>
            </div>
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
            <OnboardingReveal bg={stage.bg} glyph={stage.glyph} />
          </div>
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

export default OnboardingOpen;
