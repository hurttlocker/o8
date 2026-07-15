/**
 * Beta founding-invite store (#beta-referral).
 *
 * The operator gets a fixed set of N share-able "founding passes" — each a
 * unique code with a stable colorway + serial position. This module is the
 * LOCAL generation + sent/redeemed ledger (SQLite, `beta_invites`). It's the
 * "desktop real now" half of the build: codes are real, persisted, and
 * tracked. Cross-machine redemption + the public o8.run/i/<code> landing are
 * the central phase — see docs/beta-invites.md. `redeemInvite` is a local stub
 * that only resolves codes generated on THIS install.
 */

import { and, asc, desc, eq, ne } from 'drizzle-orm';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db';
import { betaInvites, githubInstallations } from '@/lib/db/schema';

export type InviteRow = typeof betaInvites.$inferSelect;

/** Editorial colorways, assigned by position — the "collectible set" look. */
const ACCENTS = ['#E2643B', '#5B6CB8', '#3E8E7E', '#8A5A86', '#B08534'];
const FOUNDING_COUNT = 5;

function db() {
  const d = getDb();
  if (!d) throw new Error('[invites] SQLite database unavailable');
  return d;
}

/** A 128-bit URL-safe bearer code, avoiding any already-issued one. */
function genCode(taken: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const code = `o8_${randomBytes(16).toString('base64url')}`;
    if (!taken.has(code)) return code;
  }
  return `o8_${randomBytes(16).toString('base64url')}`;
}

/**
 * The operator's display handle for the "via @handle" line — the most recent
 * GitHub installation login, falling back to the OS username, then 'operator'.
 */
export function resolveOwner(): string {
  try {
    const row = db().select().from(githubInstallations).orderBy(desc(githubInstallations.createdAt)).get();
    if (row?.accountLogin) return row.accountLogin;
  } catch { /* no installation / table — fall through */ }
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch { /* no os identity — fall through */ }
  return 'operator';
}

export function listInvites(owner: string): InviteRow[] {
  return db().select().from(betaInvites).where(eq(betaInvites.owner, owner)).orderBy(asc(betaInvites.position)).all();
}

/**
 * Return the operator's founding set, generating any missing passes up to
 * FOUNDING_COUNT. Idempotent — first call seeds the set, later calls return it.
 */
export function ensureFoundingInvites(owner: string): InviteRow[] {
  const d = db();
  const existing = listInvites(owner);
  if (existing.length >= FOUNDING_COUNT) return existing;

  // Avoid colliding with ANY issued code, not just this owner's.
  const taken = new Set(d.select({ code: betaInvites.code }).from(betaInvites).all().map((r) => r.code));
  for (let position = existing.length + 1; position <= FOUNDING_COUNT; position++) {
    const code = genCode(taken);
    taken.add(code);
    d.insert(betaInvites)
      .values({ code, owner, accent: ACCENTS[(position - 1) % ACCENTS.length], position, status: 'available' })
      .run();
  }
  return listInvites(owner);
}

/** Mark a pass as handed out (only from `available` — never un-redeem). */
export function markSent(code: string): InviteRow | null {
  const d = db();
  const row = d.select().from(betaInvites).where(eq(betaInvites.code, code)).get();
  if (!row) return null;
  if (row.status === 'available') {
    d.update(betaInvites).set({ status: 'sent', sentAt: new Date().toISOString() }).where(eq(betaInvites.code, code)).run();
  }
  return d.select().from(betaInvites).where(eq(betaInvites.code, code)).get() ?? null;
}

/**
 * LOCAL-ONLY redeem stub (central phase pending — docs/beta-invites.md). A real
 * referral validates on a central service: the inviter generates a code on THIS
 * machine; the invitee redeems on theirs, where this row doesn't exist. Until
 * then this only resolves codes minted on the same install — enough to wire +
 * test the contract, not a true cross-user claim.
 */
export function redeemInvite(code: string, redeemedBy: string): { ok: boolean; reason?: string; invite?: InviteRow } {
  const d = db();
  const row = d.select().from(betaInvites).where(eq(betaInvites.code, code)).get();
  if (!row) return { ok: false, reason: 'unknown_code' };
  if (row.status === 'redeemed') return { ok: false, reason: 'already_redeemed', invite: row };
  const updated = d.update(betaInvites)
    .set({ status: 'redeemed', redeemedAt: new Date().toISOString(), redeemedBy: redeemedBy || null })
    .where(and(eq(betaInvites.code, code), ne(betaInvites.status, 'redeemed')))
    .run();
  if (updated.changes !== 1) return { ok: false, reason: 'already_redeemed', invite: row };
  return { ok: true, invite: d.select().from(betaInvites).where(eq(betaInvites.code, code)).get() ?? undefined };
}

/**
 * Central sync (#beta-referral central phase — docs/beta-invites.md). When the
 * operator's build sets O8_INVITE_SERVICE_URL + O8_INVITE_REGISTER_TOKEN, a
 * shared code is registered with the central service on send so it's redeemable
 * cross-machine. No-op (local-only) when unconfigured.
 */
function centralConfig(): { url: string; token: string } | null {
  const url = process.env.O8_INVITE_SERVICE_URL?.trim();
  const token = process.env.O8_INVITE_REGISTER_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export function centralEnabled(): boolean {
  return centralConfig() !== null;
}

/** Fire-and-forget register of a shared code with the central service. Best-
 *  effort: failures are logged, never thrown (the local ledger is the UX truth). */
export async function registerWithCentral(invite: { code: string; owner: string; accent: string; position: number }): Promise<void> {
  const cfg = centralConfig();
  if (!cfg) return;
  try {
    const res = await fetch(`${cfg.url}/invites/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(invite),
    });
    if (!res.ok) console.error('[invites] central register rejected', res.status);
  } catch (error) {
    console.error('[invites] central register failed', error instanceof Error ? error.message : error);
  }
}
