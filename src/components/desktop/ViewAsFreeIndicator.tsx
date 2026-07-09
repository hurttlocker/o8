'use client';

/**
 * ViewAsFreeIndicator — the persistent "Viewing as Free" chrome pill (#1517).
 *
 * When the dev view-as override is active, this renders a calm-but-unmissable
 * amber pill in the chrome. Clicking it opens an inline confirm strip
 * (Revert / Cancel — the STYLEGUIDE confirm-strip pattern, no dropdown) that
 * clears the override in one confirmed click.
 *
 * SELF-CONTAINED BY DESIGN. It fetches its own override state (GET
 * /api/panel/entitlement/override) and re-fetches on `o8:entitlement-refresh`,
 * so it renders identically on the dashboard (wrapped by EntitlementProvider)
 * AND on the canvas (which is NOT wrapped) with one code path. Renders null
 * unless the override is active. The amber accent follows the FoundingStatusBadge
 * precedent (a hardcoded accent tint for these serial chips); structural colors
 * use the surface's own theme tokens via the `palette` prop.
 */

import { useCallback, useEffect, useState } from 'react';

const AMBER = '#e0932f';
const AMBER_BG = 'rgba(224, 147, 47, 0.11)';
const AMBER_BORDER = 'rgba(224, 147, 47, 0.30)';

type Palette = 'chrome' | 'canvas';

interface PaletteTokens {
  label: string;
  faint: string;
  hover: string;
}

const PALETTES: Record<Palette, PaletteTokens> = {
  chrome: { label: 'var(--t-text-muted)', faint: 'var(--t-text-faint)', hover: 'var(--t-hover)' },
  canvas: { label: 'var(--cnv-ink-muted)', faint: 'var(--cnv-ink-muted)', hover: 'var(--cnv-tint)' },
};

interface OverrideState {
  active?: unknown;
}

export function ViewAsFreeIndicator({ palette = 'chrome' }: { palette?: Palette }) {
  const [active, setActive] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/panel/entitlement/override', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as OverrideState;
      setActive(data.active === true);
    } catch {
      /* leave prior state — this is an ambient indicator, never crash chrome */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onRefresh = () => { void refresh(); };
    window.addEventListener('o8:entitlement-refresh', onRefresh);
    return () => window.removeEventListener('o8:entitlement-refresh', onRefresh);
  }, [refresh]);

  const revert = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await fetch('/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: true }),
      });
      setActive(false);
      setConfirming(false);
      // Flip every other surface (context, sibling indicator) live.
      window.dispatchEvent(new Event('o8:entitlement-refresh'));
    } catch {
      /* stay in confirm state; the user can retry */
    } finally {
      setBusy(false);
    }
  }, [busy]);

  if (!active) return null;

  const tokens = PALETTES[palette];

  const shell: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    height: 22,
    paddingLeft: 9,
    paddingRight: 9,
    borderRadius: 6,
    background: AMBER_BG,
    borderWidth: '0.5px',
    borderStyle: 'solid',
    borderColor: AMBER_BORDER,
    fontFamily: 'var(--font-sans-system)',
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.11em',
    textTransform: 'uppercase',
    color: tokens.label,
    userSelect: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  };

  if (confirming) {
    return (
      <div style={shell} role="group" aria-label="Exit view-as-free">
        <span style={{ letterSpacing: '0.04em' }}>Exit free view?</span>
        <button
          type="button"
          onClick={() => { void revert(); }}
          disabled={busy}
          aria-label="Revert to your plan"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 16,
            paddingLeft: 6,
            paddingRight: 6,
            borderWidth: 0,
            borderRadius: 4,
            background: 'transparent',
            color: AMBER,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: busy ? 'default' : 'pointer',
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? '…' : 'Revert'}
        </button>
        <span style={{ color: tokens.faint, letterSpacing: 0 }}>·</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          aria-label="Stay in free view"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 16,
            paddingLeft: 4,
            paddingRight: 4,
            borderWidth: 0,
            borderRadius: 4,
            background: 'transparent',
            color: tokens.faint,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setConfirming(true)}
      title="You're previewing the free experience on this machine. Click to revert."
      aria-label="Viewing as Free — click to revert"
      style={{ ...shell, cursor: 'pointer', transition: 'background 120ms ease' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.hover; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = AMBER_BG; }}
    >
      <span
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: AMBER, flexShrink: 0 }}
      />
      <span>Viewing as</span>
      <span style={{ color: AMBER, letterSpacing: '0.06em' }}>Free</span>
    </button>
  );
}
