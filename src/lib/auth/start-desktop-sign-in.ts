/**
 * Desktop sign-in handoff entrypoint (shared by every UI surface).
 *
 * Opens o8.run's Clerk sign-in in the system browser with a CSRF `state` nonce +
 * the `o8://` callback, then awaits the deep-link return and exchanges the
 * one-time ticket for a Clerk session on localhost. The browser-open + ticket
 * exchange are wired in P1 (T4/T5); this module is the stable entrypoint the UI
 * calls today so the account surfaces can be built against it now.
 */

export const O8_SIGN_IN_URL =
  process.env.NEXT_PUBLIC_O8_SIGN_IN_URL || 'https://o8.run/desktop/sign-in';

export const O8_AUTH_CALLBACK = 'o8://auth/callback';

export function startDesktopSignIn(): void {
  // P1 (T5): generate + persist a state nonce, open the system browser via the
  // Tauri shell plugin to `${O8_SIGN_IN_URL}?state=<nonce>&redirect_uri=${O8_AUTH_CALLBACK}`,
  // catch the o8:// deep link, then consume the ticket via Clerk's ticket strategy.
  console.warn('[auth] startDesktopSignIn: desktop handoff not yet wired (P1 / T5)');
}
