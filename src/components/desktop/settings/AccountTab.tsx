'use client';

/**
 * AccountTab — identity & sign-in management (Clerk).
 *
 * Distinct from the GitHub (Connectors) tab, which manages the `gh` CLI used for
 * repo access. This tab is about WHO YOU ARE: sign in with GitHub via Clerk, see
 * your profile, manage the account, sign out. Optional by design — o8 runs fully
 * account-less with your own API keys; signing in unlocks managed tokens + Pro.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';

import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { useEntitlement } from '@/lib/entitlement/context';
import { isTelemetryOptedOut, setTelemetryOptOut } from '@/lib/analytics/track';
import {
  APP_FONT_STACK,
  RAMS_HAIRLINE_SOFT,
  RAMS_INK_QUIET,
  BracketLabel,
  RamsButton,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';

// No "privacy/share" glyph exists in shared.tsx yet — minimal 16px stroke icon.
function ShieldIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

// "View as" — an eye glyph for the founder-only dev switch.
function EyeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function AccountTab() {
  const auth = useO8Auth();
  const { founder, actualFounder, overrideActive } = useEntitlement();

  // Usage-data sharing (telemetry). Default on; the toggle persists an opt-out
  // flag honored by track() (analytics epic #1249). Read on mount so the switch
  // reflects the stored preference.
  const [shareUsage, setShareUsage] = useState(true);
  useEffect(() => {
    setShareUsage(!isTelemetryOptedOut());
  }, []);

  // "View as Free" dev switch (#1517) — Founding Operator #1 only (Q ruling).
  // The route enforces the same gate server-side; this only hides the control.
  // Stays visible while an override is active so the switch can always be turned
  // OFF even though the effective plan then reads free.
  const canDevSwitch = actualFounder?.operatorNumber === 1 || overrideActive;
  const [viewAsBusy, setViewAsBusy] = useState(false);
  const [viewAsError, setViewAsError] = useState<string | null>(null);
  const setViewAsFree = useCallback(async (next: boolean) => {
    if (viewAsBusy) return;
    setViewAsBusy(true);
    setViewAsError(null);
    try {
      const res = await fetch('/api/panel/entitlement/override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next ? { plan: 'free' } : { clear: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (data && data.ok === false) {
        setViewAsError(data.reason ?? 'Could not update view-as.');
        return;
      }
      // Flip every surface live (chrome pill, canvas, sibling gates).
      window.dispatchEvent(new Event('o8:entitlement-refresh'));
    } catch {
      setViewAsError('Could not update view-as.');
    } finally {
      setViewAsBusy(false);
    }
  }, [viewAsBusy]);

  let body: ReactNode;
  if (!auth.clerkEnabled) {
    body = (
      <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
        <p style={{ fontSize: 13, color: 'var(--t-text-secondary)', lineHeight: 1.55, maxWidth: 560, margin: 0 }}>
          Sign-in isn’t configured in this build. o8 is running in local account-less mode — everything works with your
          own API keys. Hosted sign-in activates in a future release.
        </p>
      </div>
    );
  } else if (!auth.isLoaded) {
    body = (
      <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14, color: 'var(--t-text-muted)', fontSize: 13 }}>
        Checking session…
      </div>
    );
  } else if (!auth.signedIn) {
    body = (
      <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
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
      <div style={{ paddingTop: 14, paddingBottom: 14, paddingLeft: 14, paddingRight: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 20 }}>
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
              {founder ? (
                <BracketLabel tone="accent">
                  founding operator · no. {String(founder.operatorNumber).padStart(2, '0')}
                </BracketLabel>
              ) : null}
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
      <TabHeading
        title="account"
        subtitle="Sign in with GitHub to sync your identity across desktop and (soon) the web. Optional — o8 runs fully with your own API keys and no account; signing in unlocks managed tokens and Pro."
      />
      <section>
        <SettingsGroup header="Identity">
          {body}
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Privacy"
          footnote="Coarse counts only — which features get used, and how often. Never your code, prompts, repo names, or file contents."
        >
          <SettingsRow
            icon={<ShieldIcon />}
            label="Share usage data"
            subtitle="Helps us improve o8"
            checked={shareUsage}
            onToggle={(next) => { setShareUsage(next); setTelemetryOptOut(!next); }}
          />
        </SettingsGroup>
      </section>

      {canDevSwitch ? (
        <section style={{ marginTop: 28 }}>
          <SettingsGroup
            header="Developer"
            footnote={
              viewAsError
                ? viewAsError
                : 'Downgrades this machine to the free experience so you can dogfood it. Local-only, reversible, never touches your license — flip it off to return.'
            }
          >
            <SettingsRow
              icon={<EyeIcon />}
              label="View as Free"
              subtitle="Preview the free experience on this machine"
              checked={overrideActive}
              disabled={viewAsBusy}
              onToggle={(next) => { void setViewAsFree(next); }}
            />
          </SettingsGroup>
        </section>
      ) : null}
    </div>
  );
}
