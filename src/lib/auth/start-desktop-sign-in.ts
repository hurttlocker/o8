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
import { clearDesktopAuthError, reportDesktopAuthError } from '@/lib/auth/desktop-auth-error';
import { desktopAuthHandoffGeneration } from '@/lib/auth/desktop-auth-callback';
import { isTauri } from '@/lib/tauri/bridge';

export const O8_SIGN_IN_URL =
  process.env.NEXT_PUBLIC_O8_SIGN_IN_URL || 'https://o8.run/desktop/sign-in';

export const O8_AUTH_CALLBACK = 'o8://auth/callback';

/** sessionStorage key holding the CSRF state nonce between launch and callback. */
export const O8_AUTH_STATE_KEY = 'o8:auth-state';

function openHandoff(state: string): void {
  try { sessionStorage.setItem(O8_AUTH_STATE_KEY, state); } catch { /* native server validation remains mandatory */ }
  const url = `${O8_SIGN_IN_URL}?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(O8_AUTH_CALLBACK)}`;
  openExternalUrl(url);
}

export function startDesktopSignIn(): void {
  if (typeof window === 'undefined') return;
  clearDesktopAuthError();
  if (!isTauri()) {
    let state: string;
    try { state = crypto.randomUUID().replace(/-/g, ''); } catch {
      state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    openHandoff(state);
    return;
  }
  const generation = desktopAuthHandoffGeneration();
  void (async () => {
    const response = await fetch('/api/panel/auth/handoff?action=begin', { method: 'POST' });
    const data = await response.json();
    if (generation !== desktopAuthHandoffGeneration()) return;
    if (!response.ok || !data?.ok || typeof data.state !== 'string' || !data.state) throw new Error('Handoff unavailable');
    openHandoff(data.state);
  })().catch(() => {
    if (generation === desktopAuthHandoffGeneration()) reportDesktopAuthError('Sign-in could not be started. Try again.');
  });
}
