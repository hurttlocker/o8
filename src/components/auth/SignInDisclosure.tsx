import { O8_SIGN_IN_DISCLOSURE } from '@/lib/auth/start-desktop-sign-in';

/** Keep the disclosure directly after its sign-in button. */
export function SignInDisclosure({ id }: { id: string }) {
  return <p id={id} style={{ marginTop: 8, marginBottom: 0, fontSize: 12, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>{O8_SIGN_IN_DISCLOSURE}</p>;
}
