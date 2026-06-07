'use client';

/**
 * <UpgradePrompt feature="..."> — a small, tasteful inline upgrade affordance
 * shown where a Pro/Team-only feature would otherwise render. Inline styles +
 * var(--t-*) tokens only (themed surfaces never get hardcoded rgba). Raw-SVG
 * lock glyph reused from settings/shared.tsx (no React icon components in the
 * Tauri webview).
 *
 * The Upgrade button is a stub for M2 — it deep-links to the Billing tab which
 * ships in M3. See onClick below.
 */

import { motion } from 'framer-motion';

import { LockIcon, THEME_ACCENT } from '@/components/desktop/settings/shared';

interface UpgradePromptProps {
  feature: string;
}

export function UpgradePrompt({ feature }: UpgradePromptProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={
        {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 8,
          paddingBottom: 8,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 10,
          backgroundColor: 'var(--t-bg-card)',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border, var(--t-divider-subtle))',
        } as React.CSSProperties
      }
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: THEME_ACCENT,
          flexShrink: 0,
        }}
      >
        <LockIcon />
      </span>
      <span
        style={{
          fontSize: 12.5,
          color: 'var(--t-text-muted)',
          lineHeight: 1.35,
        }}
      >
        <span style={{ color: 'var(--t-text)', fontWeight: 500 }}>{feature}</span>
        {' is a Pro feature.'}
      </span>
      <button
        type="button"
        onClick={() => {
          // TODO(M3): deep-link to the Billing tab (Settings → Billing) once it
          // lands. No-op for M2 — the entitlement rendering layer only.
        }}
        style={{
          appearance: 'none',
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 500,
          color: THEME_ACCENT,
          backgroundColor: 'transparent',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-panel-border, var(--t-divider-subtle))',
          borderRadius: 7,
          paddingTop: 4,
          paddingBottom: 4,
          paddingLeft: 10,
          paddingRight: 10,
          flexShrink: 0,
        }}
      >
        Upgrade
      </button>
    </motion.div>
  );
}
