'use client';

import { useEffect, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { clearDesktopAuthError, getDesktopAuthError, subscribeDesktopAuthError, type DesktopAuthError } from '@/lib/auth/desktop-auth-error';
import { useEntitlement } from '@/lib/entitlement/context';
import { PLAN_LABELS } from '@/lib/entitlement/display';
import { SignInErrorCard } from '@/components/desktop/SignInErrorCard';
import { APP_FONT_STACK, RamsButton, SETTINGS_CONTENT_MAX_WIDTH, TabHeading } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

function AccountIcon() {
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>;
}

/** Optional account controls, kept out of the workspace and quick settings. */
export function AccountTab() {
  const auth = useO8Auth();
  const { founder } = useEntitlement();
  const [authError, setAuthError] = useState<DesktopAuthError | null>(() => getDesktopAuthError());
  const [signingOut, setSigningOut] = useState(false);
  const [waitingForSignOut, setWaitingForSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  useEffect(() => subscribeDesktopAuthError(() => setAuthError(getDesktopAuthError())), []);
  useEffect(() => {
    if (auth.signedIn && authError) clearDesktopAuthError();
  }, [auth.signedIn, authError]);
  useEffect(() => {
    if (!signingOut) return;
    const timer = window.setTimeout(() => setWaitingForSignOut(true), 3000);
    return () => window.clearTimeout(timer);
  }, [signingOut]);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setWaitingForSignOut(false);
    setSignOutError(null);
    try { await auth.signOut(); } catch {
      setSignOutError('Sign-out could not be saved. Try again.');
    } finally {
      setSigningOut(false);
    }
  };
  const identity = auth.signedIn ? auth.user?.name || auth.user?.email || 'Signed in' : auth.isLoaded ? 'Local desktop profile' : 'Loading account…';
  const serial = founder ? String(founder.operatorNumber).padStart(3, '0') : null;

  return (
    <div style={{ maxWidth: SETTINGS_CONTENT_MAX_WIDTH, padding: 8, fontFamily: APP_FONT_STACK }}>
      <TabHeading title="Account" subtitle="Your o8 profile and sign-in." />
      <SettingsGroup header="Profile" footnote="Sign-in is optional. Your local workspace remains available without an account.">
        <SettingsRow
          icon={<AccountIcon />}
          label={identity}
          subtitle={auth.signedIn ? auth.user?.email : 'Connect your account to sync across devices.'}
          divider={auth.signedIn}
          accessory={<div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {serial ? <span title={`${PLAN_LABELS.founder} · No. ${serial}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--t-text-muted)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}><span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--t-brand-orange)' }} />{serial}</span> : null}
            {auth.signedIn ? <RamsButton onClick={auth.openManageAccount}>Manage account</RamsButton> : auth.clerkEnabled ? <RamsButton onClick={auth.signIn}>Sign in to o8</RamsButton> : <ValuePill>Local</ValuePill>}
          </div>}
        />
        {auth.signedIn ? <SettingsRow icon={<AccountIcon />} label="Session" subtitle="Sign out of this o8 account." accessory={<RamsButton disabled={signingOut} onClick={() => { void signOut(); }}>{signingOut ? waitingForSignOut ? 'Waiting for sign-out…' : 'Signing out…' : 'Sign out'}</RamsButton>} /> : null}
      </SettingsGroup>
      {signOutError ? <div role="alert" style={{ color: 'var(--t-text-muted)', fontSize: 12, padding: 8 }}>{signOutError}</div> : null}
      {!auth.signedIn && authError ? <div style={{ marginTop: 16 }}><SignInErrorCard key={authError.id} authError={authError} onRetry={auth.signIn} /></div> : null}
    </div>
  );
}
