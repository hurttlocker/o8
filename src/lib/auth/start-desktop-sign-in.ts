/**
 * Desktop sign-in handoff entrypoint (shared by every UI surface).
 *
 * Opens o8.run's Clerk sign-in in the system browser with a CSRF `state` nonce +
 * the `o8://` callback. The website authenticates with GitHub, mints a one-time
 * Clerk sign-in ticket, and redirects to `o8://auth/callback?ticket=...&state=...`.
 * The Tauri shell catches that deep link (RunEvent::Opened → `o8:auth-callback`
 * event / `take_pending_auth_callbacks`), and DesktopAuthCallbackHandler exchanges
 * the ticket for a session after verifying the `state` matches the nonce below.
 */

import { openExternalUrl } from '@/lib/desktop/open-external';

export const O8_SIGN_IN_URL =
  process.env.NEXT_PUBLIC_O8_SIGN_IN_URL || 'https://o8.run/desktop/sign-in';

export const O8_AUTH_CALLBACK = 'o8://auth/callback';

/** sessionStorage key holding the CSRF state nonce between launch and callback. */
export const O8_AUTH_STATE_KEY = 'o8:auth-state';

function randomState(): string {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  }
}

export function startDesktopSignIn(): void {
  if (typeof window === 'undefined') return;
  const state = randomState();
  try {
    sessionStorage.setItem(O8_AUTH_STATE_KEY, state);
  } catch {
    /* private mode / storage disabled — the callback simply skips the CSRF check */
  }
  const url = `${O8_SIGN_IN_URL}?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(O8_AUTH_CALLBACK)}`;
  openExternalUrl(url);
}
