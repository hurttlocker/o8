'use client';

import { useEffect, useState } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { clearDesktopAuthError, getDesktopAuthError, subscribeDesktopAuthError, type DesktopAuthError } from '@/lib/auth/desktop-auth-error';
import { SignInErrorCard } from '@/components/desktop/SignInErrorCard';
import { SignInDisclosure } from '@/components/auth/SignInDisclosure';
import { APP_FONT_STACK, RamsButton, SETTINGS_CONTENT_MAX_WIDTH, TabHeading } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';

function AccountIcon() {
  return <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></svg>;
}

/** Optional account controls, kept out of the workspace and quick settings. */
export function AccountTab() {
  const auth = useO8Auth();
  const [authError, setAuthError] = useState<DesktopAuthError | null>(() => getDesktopAuthError());
  const [signingOut, setSigningOut] = useState(false);
  const [waitingForSignOut, setWaitingForSignOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [accountReadTimedOut, setAccountReadTimedOut] = useState(false);

  useEffect(() => {
    // Native engine recovery hands off to a separate SDK session read.
    setAccountReadTimedOut(false);
    if (auth.isLoaded) {
      return;
    }
    const timer = window.setTimeout(() => setAccountReadTimedOut(true), 8000);
    return () => window.clearTimeout(timer);
  }, [auth.isLoaded, auth.accountConnection]);

  useEffect(() => subscribeDesktopAuthError(() => setAuthError(getDesktopAuthError())), []);
  useEffect(() => {
    if (auth.isLoaded && auth.signedIn && authError) clearDesktopAuthError();
  }, [auth.isLoaded, auth.signedIn, authError]);
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
  const signedIn = auth.isLoaded && auth.signedIn;
  const unavailable = auth.accountConnection ? auth.accountConnection === 'unavailable' : !auth.isLoaded && accountReadTimedOut;
  const identity = signedIn ? auth.user?.name || auth.user?.email || 'Signed in' : auth.isLoaded ? 'Local desktop profile' : unavailable ? 'Account unavailable' : 'Loading account…';

  return (
    <div style={{ maxWidth: SETTINGS_CONTENT_MAX_WIDTH, padding: 8, fontFamily: APP_FONT_STACK }}>
      <TabHeading title="Account" subtitle="Your o8 profile and sign-in." />
      <SettingsGroup header="Profile" footnote={auth.localWorkspaceOnly
        ? 'Your local workspace is available. Use the desktop app or a development account configuration to sign in.'
        : 'Sign-in is optional. Your local workspace remains available without an account.'}>
        <SettingsRow
          icon={<AccountIcon />}
          label={identity}
          subtitle={signedIn ? auth.user?.email : 'Connect your account to sync across devices.'}
          divider={signedIn}
          accessory={<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', maxWidth: '60%', minWidth: 0 }}>
            {signedIn ? <RamsButton onClick={auth.openManageAccount}>Manage account</RamsButton>
              : auth.accountConnection ? <RamsButton disabled={!unavailable} onClick={auth.retryAccountConnection}>{unavailable ? 'Retry account connection' : 'Connecting account…'}</RamsButton>
              : auth.clerkEnabled ? <><RamsButton aria-describedby="account-sign-in-disclosure" onClick={auth.signIn}>Sign in to o8</RamsButton><SignInDisclosure id="account-sign-in-disclosure" /></> : <ValuePill>Local</ValuePill>}
          </div>}
        />
        {signedIn ? <SettingsRow icon={<AccountIcon />} label="Session" subtitle="Sign out of this o8 account." accessory={<RamsButton disabled={signingOut} onClick={() => { void signOut(); }}>{signingOut ? waitingForSignOut ? 'Waiting for sign-out…' : 'Signing out…' : 'Sign out'}</RamsButton>} /> : null}
      </SettingsGroup>
      {unavailable ? <div role="status" style={{ color: 'var(--t-text-secondary)', fontSize: 12, paddingTop: 8, paddingRight: 8, paddingBottom: 8, paddingLeft: 8 }}>We could not confirm your account status. Your workspace remains available; {auth.accountConnection ? 'retry the connection when ready.' : 'sign in to reconnect.'}</div> : null}
      {signOutError ? <div role="alert" style={{ color: 'var(--t-text-muted)', fontSize: 12, padding: 8 }}>{signOutError}</div> : null}
      {!auth.signedIn && authError ? <div style={{ marginTop: 16 }}><SignInErrorCard key={authError.id} authError={authError} onRetry={auth.signIn} /></div> : null}
    </div>
  );
}
