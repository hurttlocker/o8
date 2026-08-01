'use client';

/**
 * CanvasTour — the guided coach-mark tour.
 *
 * Walks a new operator through the canvas by SPOTLIGHTING the real chrome —
 * the composer, the MODE chip, the spawn rail, the review action — one at a
 * time: everything else dims, the target gets a ring + soft orange glow, and a
 * coach card explains it with Skip / Back / Next. Launches off the welcome
 * modal's Start; the page owns the "seen" flag.
 *
 * Targets resolve by the aria-labels already in the DOM, re-measured on step
 * change + resize (+ a slow poll) so the spotlight tracks layout. Inline styles
 * only; framer-motion for the moves; reduced-motion safe.
 */

import { useEffect, useLayoutEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { FONT } from './ui';

const ACCENT = '#FF5A1F';
const PAD = 8;
const CARD_W = 322;

interface TourStep {
  sel: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    sel: 'textarea[aria-label="Orchestrator composer"]',
    title: 'Talk to the orchestrator',
    body: 'Describe what you want built. The orchestrator plans it, dispatches the agents, and reports back right here.',
  },
  {
    sel: 'button[aria-label="Orchestration mode"]',
    title: 'Choose how it runs',
    body: 'Fleet dispatches agents in isolated worktrees · Single keeps it solo, no dispatch · Fusion goes deep.',
  },
  {
    sel: 'button[aria-label="Spawn browser"]',
    title: 'Drop anything on the canvas',
    body: 'Spawn browsers, terminals, and files — or drop in images and video. Every object sits on the board, in view.',
  },
  {
    sel: 'button[aria-label="Review diffs"]',
    title: 'Review, then ship',
    body: 'See every diff before it lands. Nothing merges without your approval — the canvas keeps you in control.',
  },
];

export function CanvasTour({ open, onClose, onComplete }: { open: boolean; onClose: () => void; onComplete?: () => void }) {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);

  // Reset to step 0 whenever the tour (re)opens.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  // Track the current target — measure on step change + resize, and poll slowly
  // so the spotlight stays glued if the layout shifts under it.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = document.querySelector(STEPS[step]?.sel ?? '') as HTMLElement | null;
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    measure();
    window.addEventListener('resize', measure);
    const id = window.setInterval(measure, 500);
    return () => { window.removeEventListener('resize', measure); window.clearInterval(id); };
  }, [open, step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === 'ArrowRight' || event.key === 'Enter') next();
      else if (event.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  const isLast = step >= STEPS.length - 1;
  // Reaching "Done" (vs Skip/Esc, which call onClose directly) hands off to
  // onComplete — the end-of-welcome beat where we surface the beta invite.
  const finish = () => { onComplete?.(); onClose(); };
  const next = () => (isLast ? finish() : setStep((s) => s + 1));

  if (!open) return null;
  const current = STEPS[step];

  // Coach-card placement: above the target when it sits low (our targets cluster
  // at the bottom), below when it's high. Anchor by `bottom` for above-placement
  // so we never need the card's measured height.
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const placeAbove = rect ? rect.top > vh * 0.5 : true;
  const cardLeft = rect
    ? Math.max(16, Math.min(rect.left + rect.width / 2 - CARD_W / 2, vw - CARD_W - 16))
    : vw / 2 - CARD_W / 2;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 250, fontFamily: FONT }}>
      {/* click catcher — blocks canvas interaction while the tour runs */}
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, cursor: 'default' }} />

      {/* spotlight — the dim-everywhere-but-here hole + ring + glow */}
      {rect ? (
        <motion.div
          aria-hidden
          initial={false}
          animate={{ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
          transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 34 }}
          style={{
            position: 'absolute',
            borderRadius: 12,
            boxShadow: '0 0 0 9999px rgba(8,10,14,0.4), 0 0 0 1.5px rgba(255,255,255,0.5), 0 0 30px 4px rgba(255,90,31,0.3)',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'rgba(8,10,14,0.4)', pointerEvents: 'none' }} />
      )}

      {/* coach card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: placeAbove ? 10 : -10, scale: 0.98 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          style={{
            position: 'absolute',
            left: cardLeft,
            width: CARD_W,
            ...(rect
              ? placeAbove
                ? { bottom: vh - (rect.top - PAD) + 14 }
                : { top: rect.top + rect.height + PAD + 14 }
              : { top: vh / 2 - 90 }),
            paddingTop: 16,
            paddingBottom: 14,
            paddingLeft: 16,
            paddingRight: 16,
            borderRadius: 16,
            // Translucent glass — the spotlit canvas fogs through behind it.
            background: 'linear-gradient(155deg, rgba(28,30,38,0.6), rgba(16,18,24,0.66))',
            backdropFilter: 'blur(30px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(30px) saturate(1.4)',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 24px 60px rgba(0,0,0,0.4)',
            color: '#fff',
          }}
        >
          {/* progress pills */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 12 }}>
            {STEPS.map((_, n) => (
              <div
                key={n}
                style={{
                  width: n === step ? 18 : 6,
                  height: 5,
                  borderRadius: 999,
                  background: n === step ? ACCENT : 'rgba(255,255,255,0.22)',
                  transition: 'width 220ms ease, background 220ms ease',
                }}
              />
            ))}
          </div>

          <div style={{ fontSize: 15, fontWeight: 500, letterSpacing: '-0.01em', color: '#fff', marginBottom: 6 }}>{current.title}</div>
          <div style={{ fontSize: 12, fontWeight: 300, lineHeight: 1.5, letterSpacing: '-0.1px', color: 'rgba(255,255,255,0.62)' }}>{current.body}</div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16 }}>
            <button
              type="button"
              onClick={onClose}
              style={{ borderWidth: 0, background: 'transparent', color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: 400, cursor: 'pointer', fontFamily: FONT, padding: 4 }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.5)'; }}
            >
              Skip
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {step > 0 ? (
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  style={{ borderWidth: 0, background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: 12.5, fontWeight: 400, cursor: 'pointer', fontFamily: FONT, paddingTop: 7, paddingBottom: 7, paddingLeft: 10, paddingRight: 10, borderRadius: 999 }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; }}
                >
                  Back
                </button>
              ) : null}
              <button
                type="button"
                onClick={next}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  borderWidth: 0,
                  background: ACCENT,
                  color: '#fff',
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: FONT,
                  paddingTop: 8,
                  paddingBottom: 8,
                  paddingLeft: 14,
                  paddingRight: 12,
                  borderRadius: 999,
                  boxShadow: '0 6px 18px rgba(255,90,31,0.32)',
                }}
              >
                {isLast ? 'Done' : 'Next'}
                {isLast ? null : (
                  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
