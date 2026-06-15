'use client';

/**
 * WelcomeModal — the canvas first-run hero ("welcome to a shift in momentum").
 *
 * Reference: a creator's their product onboarding — a centered split card over a
 * dimmed + frosted canvas. Left pane carries the headline + a single CTA; right
 * pane is the brand glimpse (a mini canvas, so the very first thing you see is
 * what the surface IS). Shown once per browser (the page owns the localStorage
 * flag) and dismissed by Start / ✕ / Escape.
 *
 * Inline styles only. The card panes are deliberately HARD dark/light (not the
 * tone-aware --cnv-* tokens) so the modal reads with the same drama whether the
 * canvas is in light or dark tone — same call we make for portal popovers.
 */

import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT } from './ui';
import { O8Reel } from './welcome-reel';

const ACCENT = 'var(--t-brand-orange, #FF5A1F)';

export function WelcomeModal({ open, onClose, onStart, tone }: { open: boolean; onClose: () => void; onStart: () => void; tone: 'light' | 'dark' }) {
  const isDark = tone === 'dark';
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          // Full-viewport scrim — dims + frosts the whole canvas behind the card.
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(8, 10, 14, 0.42)',
            backdropFilter: 'blur(10px) saturate(1.1)',
            WebkitBackdropFilter: 'blur(10px) saturate(1.1)',
            fontFamily: FONT,
          }}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 18 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }}
            // Stop card clicks from bubbling to the scrim (which dismisses).
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'relative',
              display: 'flex',
              width: 'min(760px, calc(100vw - 80px))',
              maxHeight: 'calc(100vh - 120px)',
              borderRadius: 22,
              overflow: 'hidden',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              boxShadow: '0 40px 120px rgba(0, 0, 0, 0.5), 0 2px 0 rgba(255, 255, 255, 0.04) inset',
            }}
          >
            {/* ── Left pane — headline + CTA (dark glass) ─────────────── */}
            <div
              style={{
                flex: '0 0 46%',
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 38,
                paddingBottom: 34,
                paddingLeft: 34,
                paddingRight: 30,
                background: 'linear-gradient(155deg, rgba(24, 26, 32, 0.96), rgba(13, 15, 19, 0.97))',
                color: 'rgba(255, 255, 255, 0.92)',
              }}
            >
              {/* eyebrow — wordmark + beta pill */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 'auto' }}>
                <span style={{ fontSize: 14, fontWeight: 500, letterSpacing: '0.02em', color: '#fff' }}>o8</span>
                <span
                  style={{
                    fontSize: 8.5,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'rgba(150, 226, 168, 0.95)',
                    background: 'rgba(80, 200, 120, 0.14)',
                    border: '1px solid rgba(120, 210, 150, 0.28)',
                    paddingTop: 2,
                    paddingBottom: 2,
                    paddingLeft: 6,
                    paddingRight: 6,
                    borderRadius: 999,
                  }}
                >
                  Beta
                </span>
              </div>

              <h1
                style={{
                  margin: 0,
                  marginTop: 28,
                  fontSize: 31,
                  fontWeight: 300,
                  lineHeight: 1.12,
                  letterSpacing: '-0.02em',
                  color: '#fff',
                }}
              >
                Welcome to a shift
                <br />
                in momentum.
              </h1>

              <p
                style={{
                  margin: 0,
                  marginTop: 16,
                  fontSize: 13,
                  fontWeight: 300,
                  lineHeight: 1.55,
                  letterSpacing: '-0.1px',
                  color: 'rgba(255, 255, 255, 0.6)',
                }}
              >
                Your whole fleet on one surface. Drop in work, talk to the orchestrator,
                and watch agents ship — every move in view, every merge yours to call.
              </p>

              <button
                type="button"
                onClick={onStart}
                style={{
                  marginTop: 26,
                  alignSelf: 'flex-start',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  height: 38,
                  paddingLeft: 18,
                  paddingRight: 16,
                  borderRadius: 999,
                  borderWidth: 0,
                  background: ACCENT,
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 500,
                  letterSpacing: '0.01em',
                  cursor: 'pointer',
                  fontFamily: FONT,
                  boxShadow: '0 8px 24px rgba(255, 90, 31, 0.32)',
                  transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms cubic-bezier(0.22, 1, 0.36, 1)',
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.transform = 'translateY(-1px)';
                  event.currentTarget.style.boxShadow = '0 12px 30px rgba(255, 90, 31, 0.42)';
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.transform = 'translateY(0)';
                  event.currentTarget.style.boxShadow = '0 8px 24px rgba(255, 90, 31, 0.32)';
                }}
              >
                Start
                <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            </div>

            {/* ── Right pane — the Remotion reel (code-driven, themed, looping) ── */}
            <div
              style={{
                flex: '1 1 54%',
                position: 'relative',
                borderLeft: isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.05)',
                background: isDark ? '#191c24' : '#f2f2f0',
                overflow: 'hidden',
              }}
            >
              <O8Reel tone={tone} />
            </div>

            {/* dismiss — quiet, top-right */}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                position: 'absolute',
                top: 12,
                right: 12,
                width: 26,
                height: 26,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                borderWidth: 0,
                background: 'rgba(255, 255, 255, 0.1)',
                color: 'rgba(255, 255, 255, 0.7)',
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: FONT,
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'; event.currentTarget.style.color = '#fff'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; event.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)'; }}
            >
              ✕
            </button>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
