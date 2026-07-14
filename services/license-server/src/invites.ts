import { and, eq, ne } from 'drizzle-orm';

import { db } from './db/client.js';
import { invites } from './db/schema.js';

/**
 * Beta founding-invite logic (#beta-referral). The desktop generates + displays
 * codes locally, then registers each on share so it's redeemable cross-machine;
 * the o8.run/i/<code> landing resolves + redeems against this table.
 *
 *  - register: scoped-token guarded (the desktop). Idempotent for the same
 *    owner; rejects a code another owner already holds so the desktop regenerates.
 *  - resolve:  public. Powers the landing (owner + colorway + status).
 *  - redeem:   public, one-time. Captures the invitee email.
 */

// Keep legacy NNN-NNN codes redeemable, but every new desktop issues a 128-bit
// `o8_...` code so the public resolve endpoint is not a six-digit oracle.
const CODE_RE = /^(?:\d{3}-\d{3}|o8_[A-Za-z0-9_-]{22})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidCodeFormat(code: string): boolean {
  return CODE_RE.test(code);
}

export interface RegisterInput {
  code: string;
  owner: string;
  accent: string;
  position: number;
}

export async function registerInvite(input: RegisterInput): Promise<{ ok: boolean; reason?: string }> {
  const { code, owner, accent, position } = input;
  if (!isValidCodeFormat(code)) return { ok: false, reason: 'invalid_code' };

  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const row = rows[0];
  if (row) {
    // A different owner already holds this code → collision; the desktop should
    // regenerate. Same owner re-registering just refreshes display fields, and
    // a redeemed row is left untouched.
    if (row.owner !== owner) return { ok: false, reason: 'code_taken' };
    if (row.status === 'redeemed') return { ok: true };
    await db.update(invites).set({ owner, accent, position }).where(eq(invites.code, code));
    return { ok: true };
  }

  await db.insert(invites).values({ code, owner, accent, position, status: 'sent' });
  return { ok: true };
}

export interface ResolveResult {
  valid: boolean;
  owner?: string;
  accent?: string;
  position?: number;
  status?: string;
  reason?: string;
}

export async function resolveInvite(code: string): Promise<ResolveResult> {
  if (!isValidCodeFormat(code)) return { valid: false, reason: 'invalid_code' };
  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const row = rows[0];
  if (!row) return { valid: false, reason: 'not_found' };
  return { valid: true, owner: row.owner, accent: row.accent, position: row.position, status: row.status };
}

export async function redeemInvite(code: string, email: string): Promise<{ ok: boolean; reason?: string; owner?: string }> {
  if (!isValidCodeFormat(code)) return { ok: false, reason: 'invalid_code' };
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };

  const updated = await db
    .update(invites)
    .set({ status: 'redeemed', redeemedBy: email, redeemedAt: new Date() })
    .where(and(eq(invites.code, code), ne(invites.status, 'redeemed')))
    .returning({ owner: invites.owner });
  if (updated[0]) return { ok: true, owner: updated[0].owner };

  const rows = await db.select().from(invites).where(eq(invites.code, code)).limit(1);
  const row = rows[0];
  return row
    ? { ok: false, reason: 'already_redeemed', owner: row.owner }
    : { ok: false, reason: 'not_found' };
}
