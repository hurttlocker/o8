'use client';

/**
 * AccountTab — identity & sign-in management (Clerk).
 *
 * Distinct from the GitHub (Connectors) tab, which manages the `gh` CLI used for
 * repo access. This tab is about WHO YOU ARE: sign in with GitHub via Clerk, see
 * your profile, manage the account, sign out. Optional by design — o8 runs fully
 * account-less with your own API keys; signing in unlocks managed tokens + Pro.
 */

import { type ReactNode } from 'react';

import { useO8Auth } from '@/components/auth/O8AuthProvider';
import {
  APP_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  RamsButton,
  SectionLabel,
  TabBreadcrumb,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';

export function AccountTab() {
  const auth = useO8Auth();

  let body: ReactNode;
  if (!auth.clerkEnabled) {
    body = (
      <div style={{ paddingTop: 16, borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 560, margin: 0 }}>
          Sign-in isn’t configured in this build. o8 is running in local account-less mode — everything works with your
          own API keys. Hosted sign-in activates in a future release.
        </p>
      </div>
    );
  } else if (!auth.isLoaded) {
    body = (
      <div style={{ paddingTop: 16, color: 'var(--t-text-muted)', fontSize: 13 }}>Checking session…</div>
    );
  } else if (!auth.signedIn) {
    body = (
      <div style={{ paddingTop: 16, borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 560, margin: 0, marginBottom: 16 }}>
          You’re not signed in. Continue with GitHub to create or access your o8 account.
        </p>
        <RamsButton variant="primary" onClick={auth.signIn}>Sign in with GitHub</RamsButton>
      </div>
    );
  } else {
    const user = auth.user;
    const displayName = user?.name || user?.email || 'Signed in';
    body = (
      <div style={{ paddingTop: 16, borderTop: `1px solid ${RAMS_HAIRLINE_SOFT}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
          {user?.avatarUrl ? (
            <div
              aria-hidden="true"
              style={{
                width: 52,
                height: 52,
                borderRadius: 999,
                flexShrink: 0,
                backgroundImage: `url("${user.avatarUrl}")`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                border: `1px solid ${RAMS_HAIRLINE_SOFT}`,
              }}
            />
          ) : null}
          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20, fontWeight: 300, color: 'var(--t-text)', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {displayName}
              </span>
              <BracketLabel tone="accent">signed in</BracketLabel>
            </div>
            {user?.email ? (
              <span style={{ fontFamily: APP_FONT_STACK, fontSize: 12, color: RAMS_INK_QUIET, letterSpacing: '-0.01em' }}>{user.email}</span>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <RamsButton variant="primary" onClick={auth.openManageAccount}>Manage account</RamsButton>
          <RamsButton variant="ghost" onClick={() => { void auth.signOut(); }}>Sign out</RamsButton>
        </div>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 8, paddingLeft: 8, paddingRight: 32, paddingBottom: 40, maxWidth: SETTINGS_CONTENT_MAX_WIDTH, fontFamily: APP_FONT_STACK }}>
      <TabBreadcrumb tab="account" />
      <TabHeading
        title="account"
        subtitle="Sign in with GitHub to sync your identity across desktop and (soon) the web. Optional — o8 runs fully with your own API keys and no account; signing in unlocks managed tokens and Pro."
      />
      <section>
        <SectionLabel number="01">IDENTITY</SectionLabel>
        {body}
      </section>
    </div>
  );
}
