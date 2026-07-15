#!/usr/bin/env node
/**
 * comp-founder — grant a comped Founding Operator seat (no Stripe purchase).
 *
 * Mirrors handleFoundingCheckout's insert exactly, minus the payment: a
 * founders row with status 'active', perks tier derived from the operator
 * number, and the identity the deployed server matches on. The PROD server
 * (pre-#1519 build) resolves founders by EXACT clerk_user_id — a comp row
 * without the real Clerk id is the founder-#2 mis-bind all over again, so
 * --clerk is REQUIRED here by design.
 *
 * Usage (against prod via Railway):
 *   railway run node scripts/comp-founder.mjs \
 *     --operator 3 --name "Chris Loggins" \
 *     --clerk user_2... --github chrisloggins --email chris@example.com
 *
 * Idempotent: refuses if the operator number is taken (unless the existing
 * row is the same comp id), never touches other rows.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { founders } from '../src/db/schema.js';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const operatorNumber = Number.parseInt(arg('--operator') ?? '', 10);
const displayName = arg('--name');
const clerkUserId = arg('--clerk');
const githubLogin = arg('--github');
const email = arg('--email');
const dryRun = process.argv.includes('--dry-run');

if (!Number.isInteger(operatorNumber) || operatorNumber < 1) {
  console.error('comp-founder: --operator <N> is required');
  process.exit(1);
}
if (!displayName) {
  console.error('comp-founder: --name "<display name>" is required');
  process.exit(1);
}
if (!clerkUserId?.startsWith('user_')) {
  console.error(
    'comp-founder: --clerk <clerk user id> is required (starts with user_).\n'
    + 'The deployed server matches founders by exact clerk_user_id only — a row\n'
    + 'without the real id will show the founder as free (the #2 mis-bind).',
  );
  process.exit(1);
}

// Same tier derivation the webhook uses (T1 seats are positions 1-50).
function founderTier(position) {
  if (position <= 50) return { tier: 1, priceUsd: 150 };
  if (position <= 150) return { tier: 2, priceUsd: 250 };
  return { tier: 3, priceUsd: 500 };
}

const compId = `comp-founder-${operatorNumber}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const existing = await db.select().from(founders).where(eq(founders.operatorNumber, operatorNumber));
if (existing.length > 0 && existing[0].id !== compId) {
  console.error(`comp-founder: operator #${operatorNumber} is already taken by row id=${existing[0].id} (${existing[0].status}). Aborting.`);
  await pool.end();
  process.exit(1);
}

const row = {
  id: compId,
  stripeCustomerId: null,
  clerkUserId,
  githubLogin: githubLogin ?? null,
  email: email ?? null,
  operatorNumber,
  status: 'active',
  perksJson: { ...founderTier(operatorNumber), displayName, comped: true },
  licenseMintedAt: new Date(),
  updatedAt: new Date(),
};

if (dryRun) {
  console.log('[dry-run] would insert:', JSON.stringify(row, null, 2));
  await pool.end();
  process.exit(0);
}

await db.insert(founders).values(row).onConflictDoNothing({ target: founders.id });
const check = await db.select().from(founders).where(eq(founders.id, compId));
console.log('comp-founder: inserted →', JSON.stringify(check[0], null, 2));
await pool.end();
