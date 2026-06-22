import { env } from './env.js';

/**
 * Best-effort Founding Operator welcome email via Resend's HTTP API.
 *
 * No-op (logs + returns) when RESEND_API_KEY is unset, so the founder flow runs
 * unchanged before email is wired. NEVER throws — a mail failure must not break
 * the license mint (Stripe already sends the payment receipt, and the license
 * is delivered by account-fetch on sign-in regardless of this mail).
 */
export async function sendFounderWelcome(input: {
  email: string | null;
  operatorNumber: number;
  licenseKey?: string;
}): Promise<void> {
  const { email, operatorNumber, licenseKey } = input;
  if (!email) return;
  if (!env.RESEND_API_KEY) {
    console.log(
      `[founding] welcome email skipped (no RESEND_API_KEY) — would greet ${email} as Founding Operator #${operatorNumber}`,
    );
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: email,
        subject: `You're Founding Operator #${operatorNumber}`,
        text: foundingWelcomeText(operatorNumber, licenseKey),
      }),
    });
    if (!res.ok) {
      console.error(
        '[founding] welcome email rejected:',
        res.status,
        await res.text().catch(() => ''),
      );
    }
  } catch (err) {
    console.error('[founding] welcome email failed:', err instanceof Error ? err.message : err);
  }
}

function foundingWelcomeText(operatorNumber: number, licenseKey?: string): string {
  const lines = [
    `You're in — Founding Operator #${operatorNumber}.`,
    '',
    'Open o8 and sign in with the same account; your founder status is already',
    'on it and unlocks automatically. The managed essentials — fast Brain,',
    'dictation polish, and premium speech-to-text — are included for life,',
    'within fair use. The app is free either way; this funds the build.',
  ];
  if (licenseKey) {
    lines.push(
      '',
      'If you ever need to activate manually, paste this license key in',
      'o8 → Settings → Account:',
      '',
      licenseKey,
    );
  }
  lines.push('', '— o8');
  return lines.join('\n');
}
