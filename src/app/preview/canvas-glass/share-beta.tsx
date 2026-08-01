'use client';

/**
 * ShareBetaModal — the beta referral surface. A glass split-card floating over
 * the canvas, rendered in o8's language (paper/ink/restraint).
 *
 * The mechanic:
 *  - the invite is a THING (a collectible "founding pass"), not a bare link;
 *  - status + scarcity framing ("five founding invites") over reward-bait;
 *  - one effortless primitive — Copy code — with instant "Copied ✓" feedback,
 *    plus a low-friction Copy invite link (o8.run/i/<code>) escape hatch;
 *  - a carousel of passes (‹ › flip) so different friends get different passes;
 *  - copying a pass marks it SENT, and the left pane counts down what's left.
 *
 * Data is REAL now (#beta-referral): passes load from the gated GET /api/invites
 * (generated + persisted in local SQLite), and Copy persists via POST
 * /api/invites/sent. A static FALLBACK set renders instantly + survives an API
 * hiccup. Cross-machine redemption + the o8.run landing are the central phase
 * for hosted invite registration when that optional service is configured.
 *
 * Modeled on WelcomeModal (same scrim / spring / two-pane / ✕ / Esc). Inline
 * styles only; the panes use HARD dark/light values (like WelcomeModal) so the
 * drama is identical in either canvas tone.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FONT } from './ui';

const ACCENT = 'var(--t-brand-orange, #FF5A1F)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';

type InviteStatus = 'available' | 'sent' | 'redeemed';

interface Pass {
  code: string;
  accent: string;
  position: number;
  status: InviteStatus;
}

/** Flip true to lock every pass to the one o8 orange (overrides server accents). */
const MONOCHROME = false;

/** Renders instantly + survives an API hiccup; replaced by GET /api/invites. */
const FALLBACK_PASSES: Pass[] = [
  { code: '528-191', accent: '#E2643B', position: 1, status: 'available' },
  { code: '128-304', accent: '#5B6CB8', position: 2, status: 'available' },
  { code: '291-817', accent: '#3E8E7E', position: 3, status: 'available' },
  { code: '195-009', accent: '#8A5A86', position: 4, status: 'available' },
  { code: '919-029', accent: '#B08534', position: 5, status: 'available' },
];

const PASS_W = 252;
const PASS_H = 332;

/** Directional slide for the carousel — `custom={dir}` resolves these (framer
 *  only passes custom data through NAMED variants, not inline prop functions). */
const passVariants = {
  enter: (d: number) => ({ x: d > 0 ? 64 : -64, opacity: 0, rotate: d > 0 ? 2.5 : -2.5 }),
  center: { x: 0, opacity: 1, rotate: 0 },
  exit: (d: number) => ({ x: d > 0 ? -64 : 64, opacity: 0, rotate: d > 0 ? -2.5 : 2.5 }),
};

export function ShareBetaModal({
  open,
  onClose,
  tone,
  inviterHandle = 'operator',
}: {
  open: boolean;
  onClose: () => void;
  tone: 'light' | 'dark';
  inviterHandle?: string;
}) {
  const isDark = tone === 'dark';
  const [passes, setPasses] = useState<Pass[]>(FALLBACK_PASSES);
  const [owner, setOwner] = useState(inviterHandle);
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [copied, setCopied] = useState<null | 'code' | 'link'>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the real invite set on first open (GET ensures + returns it). The
  // FALLBACK stands in until this resolves, and stays if the API errors.
  useEffect(() => {
    if (!open || loaded) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/invites', { headers: { accept: 'application/json' } });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive || !Array.isArray(data?.invites) || data.invites.length === 0) return;
        setPasses(data.invites as Pass[]);
        if (typeof data.owner === 'string' && data.owner) setOwner(data.owner);
      } catch {
        /* keep the fallback set */
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [open, loaded]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') flip(1);
      if (event.key === 'ArrowLeft') flip(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  const flip = useCallback((delta: number) => {
    setDir(delta);
    setIndex((prev) => (prev + delta + FALLBACK_PASSES.length) % FALLBACK_PASSES.length);
  }, []);

  const markCopied = useCallback((what: 'code' | 'link') => {
    setCopied(what);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1500);
  }, []);

  // Mark a pass handed out — optimistic local flip + persist to the ledger.
  const sendInvite = useCallback((code: string) => {
    setPasses((prev) => prev.map((p) => (p.code === code && p.status === 'available' ? { ...p, status: 'sent' } : p)));
    void fetch('/api/invites/sent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    }).catch(() => {});
  }, []);

  const total = passes.length;
  const idx = total > 0 ? ((index % total) + total) % total : 0;
  const pass = passes[idx] ?? FALLBACK_PASSES[0];
  const accent = MONOCHROME ? ACCENT : pass.accent;
  const link = `o8.run/i/${pass.code}`;
  const remaining = passes.filter((p) => p.status === 'available').length;

  const copyCode = useCallback(() => {
    void navigator.clipboard?.writeText(pass.code).catch(() => {});
    markCopied('code');
    sendInvite(pass.code);
  }, [pass.code, markCopied, sendInvite]);

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(`https://${link}`).catch(() => {});
    markCopied('link');
    sendInvite(pass.code);
  }, [link, pass.code, markCopied, sendInvite]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          onClick={onClose}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(8, 10, 14, 0.18)',
            backdropFilter: 'blur(6px) saturate(1.1)',
            WebkitBackdropFilter: 'blur(6px) saturate(1.1)',
            fontFamily: FONT,
          }}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 18 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 8 }}
            transition={{ type: 'spring', stiffness: 360, damping: 28 }}
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
            {/* ── Left pane — framing + scarcity (dark glass, like WelcomeModal) ── */}
            <div
              style={{
                flex: '0 0 46%',
                display: 'flex',
                flexDirection: 'column',
                paddingTop: 38,
                paddingBottom: 34,
                paddingLeft: 34,
                paddingRight: 30,
                background: 'linear-gradient(155deg, rgba(28, 30, 38, 0.55), rgba(15, 17, 23, 0.62))',
                backdropFilter: 'blur(32px) saturate(1.4)',
                WebkitBackdropFilter: 'blur(32px) saturate(1.4)',
                color: 'rgba(255, 255, 255, 0.92)',
              }}
            >
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

              <h1 style={{ margin: 0, marginTop: 28, fontSize: 31, fontWeight: 300, lineHeight: 1.12, letterSpacing: '-0.02em', color: '#fff' }}>
                Five founding
                <br />
                invites.
              </h1>

              <p style={{ margin: 0, marginTop: 16, fontSize: 13, fontWeight: 300, lineHeight: 1.55, letterSpacing: '-0.1px', color: 'rgba(255, 255, 255, 0.6)' }}>
                Bring five people into o8 before launch. Each is a one-time founding
                pass — hand them to the builders who should be here first.
              </p>

              {/* scarcity made visible — a dot per pass, hollow once it's sent. */}
              <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 9 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {passes.map((p) => {
                    const live = p.status === 'available';
                    return (
                      <span
                        key={p.code}
                        aria-hidden
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: live ? (MONOCHROME ? ACCENT : p.accent) : 'transparent',
                          border: live ? '1px solid transparent' : '1px solid rgba(255,255,255,0.35)',
                          transition: 'background 200ms ease, border-color 200ms ease',
                        }}
                      />
                    );
                  })}
                </div>
                <span style={{ fontSize: 11, fontWeight: 400, color: 'rgba(255,255,255,0.55)', fontFamily: MONO }}>
                  {remaining} of {passes.length} left
                </span>
              </div>
            </div>

            {/* ── Right pane — the pass + the copy controls ──────────────── */}
            <div
              style={{
                flex: '1 1 54%',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 18,
                paddingTop: 30,
                paddingBottom: 30,
                borderLeft: isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(15,23,42,0.05)',
                background: isDark ? '#191c24' : '#eceae6',
                overflow: 'hidden',
              }}
            >
              {/* carousel — two static ghosts behind the animated front pass. */}
              <div style={{ position: 'relative', width: PASS_W, height: PASS_H }}>
                <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: isDark ? '#23262f' : '#f4f2ee', border: '1px solid rgba(0,0,0,0.06)', transform: 'rotate(-4deg) translate(-10px, 8px)', boxShadow: '0 8px 22px rgba(0,0,0,0.18)' }} />
                <div aria-hidden style={{ position: 'absolute', inset: 0, borderRadius: 16, background: isDark ? '#262932' : '#f7f5f1', border: '1px solid rgba(0,0,0,0.06)', transform: 'rotate(3deg) translate(9px, 5px)', boxShadow: '0 8px 22px rgba(0,0,0,0.18)' }} />
                <AnimatePresence custom={dir} initial={false}>
                  <motion.div
                    key={pass.code}
                    custom={dir}
                    variants={passVariants}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    style={{ position: 'absolute', inset: 0 }}
                  >
                    <InvitePass code={pass.code} n={pass.position} total={passes.length} accent={accent} handle={owner} sent={pass.status !== 'available'} />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* segmented control — ‹  Copy code  ›. */}
              <div style={{ display: 'flex', alignItems: 'center', height: 40, borderRadius: 999, background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.05)', border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(15,23,42,0.08)', padding: 3 }}>
                <ChevronButton dir="left" isDark={isDark} onClick={() => flip(-1)} />
                <button
                  type="button"
                  onClick={copyCode}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    height: 34,
                    minWidth: 138,
                    paddingLeft: 16,
                    paddingRight: 16,
                    borderRadius: 999,
                    borderWidth: 0,
                    background: copied === 'code' ? accent : (isDark ? 'rgba(255,255,255,0.92)' : '#16181d'),
                    color: copied === 'code' ? '#fff' : (isDark ? '#16181d' : '#fff'),
                    fontSize: 12.5,
                    fontWeight: 500,
                    letterSpacing: '0.01em',
                    cursor: 'pointer',
                    fontFamily: FONT,
                    transition: 'background 160ms ease, color 160ms ease',
                  }}
                >
                  {copied === 'code' ? (
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
                  ) : (
                    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
                  )}
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </button>
                <ChevronButton dir="right" isDark={isDark} onClick={() => flip(1)} />
              </div>

              {/* low-friction escape hatch — the link, for friends who won't hunt
                  for a code field. */}
              <button
                type="button"
                onClick={copyLink}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  borderWidth: 0,
                  background: 'transparent',
                  cursor: 'pointer',
                  fontFamily: MONO,
                  fontSize: 11.5,
                  color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.5)',
                  transition: 'color 140ms ease',
                }}
                onMouseEnter={(event) => { event.currentTarget.style.color = isDark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.85)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.5)'; }}
              >
                {copied === 'link' ? 'Link copied ✓' : `Copy invite link · ${link}`}
              </button>
            </div>

            {/* dismiss — quiet, top-right (matches WelcomeModal) */}
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

function ChevronButton({ dir, isDark, onClick }: { dir: 'left' | 'right'; isDark: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={dir === 'left' ? 'Previous invite' : 'Next invite'}
      onClick={onClick}
      style={{
        width: 34,
        height: 34,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        borderWidth: 0,
        background: 'transparent',
        color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(15,23,42,0.55)',
        cursor: 'pointer',
        transition: 'background 140ms ease, color 140ms ease',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.07)'; event.currentTarget.style.color = isDark ? '#fff' : '#16181d'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(15,23,42,0.55)'; }}
    >
      <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
      </svg>
    </button>
  );
}

/** The founding pass — a paper/ink collectible. Sprocket strip + big code +
 *  ghost numeral + serial line. One accent, paper stays neutral (Rams × Swiss). */
function InvitePass({ code, n, total, accent, handle, sent }: { code: string; n: number; total: number; accent: string; handle: string; sent: boolean }) {
  const ink = '#1a1c22';
  const muted = 'rgba(26,28,34,0.5)';
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        borderRadius: 16,
        overflow: 'hidden',
        background: 'linear-gradient(168deg, #fbfaf7 0%, #f3f1ec 100%)',
        border: '1px solid rgba(26,28,34,0.1)',
        boxShadow: '0 18px 44px rgba(0,0,0,0.28)',
        fontFamily: FONT,
        opacity: sent ? 0.86 : 1,
        transition: 'opacity 200ms ease',
      }}
    >
      {/* ghost serial numeral — the collectible index, behind the content */}
      <span aria-hidden style={{ position: 'absolute', top: -18, right: 4, fontSize: 150, fontWeight: 700, lineHeight: 1, color: accent, opacity: 0.12, fontFamily: MONO, letterSpacing: '-0.04em' }}>
        {String(n).padStart(2, '0')}
      </span>

      {/* left sprocket strip — the ticket nod */}
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly', paddingTop: 26, paddingBottom: 26 }} aria-hidden>
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} style={{ width: 4, height: 4, borderRadius: 999, background: 'rgba(26,28,34,0.18)' }} />
        ))}
      </div>

      {/* content column, right of the sprocket */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', paddingTop: 22, paddingBottom: 20, paddingLeft: 40, paddingRight: 22 }}>
        {/* top row — wordmark + label */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: '0.01em', color: ink }}>o8</span>
          <span style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: muted }}>Founding Invite</span>
        </div>
        {/* accent rule */}
        <div style={{ marginTop: 12, width: 40, height: 2.5, borderRadius: 2, background: accent }} />

        <div style={{ flex: 1 }} />

        {/* hero — the code */}
        <div>
          <div style={{ fontSize: 8.5, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: muted, marginBottom: 7 }}>Access code</div>
          <div style={{ fontSize: 33, fontWeight: 500, letterSpacing: '0.01em', color: ink, fontFamily: MONO }}>{code}</div>
        </div>

        {/* footer — serial + inviter, over a hairline */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(26,28,34,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontFamily: MONO, fontSize: 9.5, color: muted }}>
          <span>No. {String(n).padStart(2, '0')} / {String(total).padStart(2, '0')}</span>
          <span>via @{handle}</span>
        </div>
      </div>

      {/* SENT overprint — a soft stamp once the pass has been handed out */}
      {sent ? (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 64,
            right: 18,
            transform: 'rotate(-9deg)',
            paddingTop: 3,
            paddingBottom: 3,
            paddingLeft: 9,
            paddingRight: 9,
            borderRadius: 5,
            border: `1.5px solid ${accent}`,
            color: accent,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            opacity: 0.85,
          }}
        >
          Sent
        </span>
      ) : null}
    </div>
  );
}
