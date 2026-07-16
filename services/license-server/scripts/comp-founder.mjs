#!/usr/bin/env node
/**
 * comp-founder — grant a comped Founding Operator seat (no Stripe purchase).
 *
 * Mirrors handleFoundingCheckout's insert exactly, minus the payment: a
 * founders row with status 'active', perks tier derived from the operator
 * number, and BOTH identities the server matches on — the exact
 * clerk_user_id (direct lookup) and the stable GitHub account id (the #1519
 * fallback), so the seat survives a duplicate Clerk user or instance
 * migration. --clerk is REQUIRED by design (the founder-#2 mis-bind);
 * --github-id is strongly recommended (Clerk dashboard → user → GitHub
 * external account `provider_user_id`, or the Clerk Backend API).
 *
 * Uses the service's own installed `postgres` driver — the original pg/
 * drizzle-node-postgres imports were never installed here, so the script
 * could not run at all (found 2026-07-15 while granting operator #3; the
 * missing grant WAS founder-sees-free, report QMVTM3).
 *
 * Usage (against prod — DATABASE_URL must be the PUBLIC proxy URL locally):
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *   node scripts/comp-founder.mjs \
 *     --operator 3 --name "Chris Loggins" \
 *     --clerk user_2... --github chrisloggins --github-id 12345678 --email chris@example.com
 *
 * Idempotent: refuses if the operator number is taken (unless the existing
 * row is the same comp id), never touches other rows. --dry-run prints the row.
 */

import postgres from 'postgres';

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const operatorNumber = Number.parseInt(arg('--operator') ?? '', 10);
const displayName = arg('--name');
const clerkUserId = arg('--clerk');
const githubLogin = arg('--github');
const githubAccountId = arg('--github-id');
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
    + 'The server matches founders by exact clerk_user_id first — a row\n'
    + 'without the real id will show the founder as free (the #2 mis-bind).',
  );
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('comp-founder: DATABASE_URL is required (use the PUBLIC proxy URL when running locally — the .railway.internal host only resolves inside Railway).');
  process.exit(1);
}

// Same tier derivation the webhook uses (T1 seats are positions 1-50).
function founderTier(position) {
  if (position <= 50) return { tier: 1, priceUsd: 150 };
  if (position <= 150) return { tier: 2, priceUsd: 250 };
  return { tier: 3, priceUsd: 500 };
}

const compId = `comp-founder-${operatorNumber}`;
const sql = postgres(process.env.DATABASE_URL, { ssl: 'require' });

const existing = await sql`SELECT id, status FROM founders WHERE operator_number = ${operatorNumber}`;
if (existing.length > 0 && existing[0].id !== compId) {
  console.error(`comp-founder: operator #${operatorNumber} is already taken by row id=${existing[0].id} (${existing[0].status}). Aborting.`);
  await sql.end();
  process.exit(1);
}

const perks = { ...founderTier(operatorNumber), displayName, comped: true };
const row = {
  id: compId,
  clerkUserId,
  githubAccountId: githubAccountId ?? null,
  githubLogin: githubLogin ?? null,
  email: email ?? null,
  operatorNumber,
  status: 'active',
  perksJson: perks,
};

if (dryRun) {
  console.log('[dry-run] would insert:', JSON.stringify(row, null, 2));
  await sql.end();
  process.exit(0);
}

await sql`
  INSERT INTO founders (id, clerk_user_id, github_account_id, github_login, email, operator_number, status, perks_json, license_minted_at, updated_at)
  VALUES (${compId}, ${clerkUserId}, ${githubAccountId ?? null}, ${githubLogin ?? null}, ${email ?? null}, ${operatorNumber}, 'active', ${sql.json(perks)}, now(), now())
  ON CONFLICT (id) DO NOTHING
`;
const check = await sql`SELECT operator_number, status, clerk_user_id, github_account_id, github_login, email FROM founders WHERE id = ${compId}`;
console.log('comp-founder: inserted →', JSON.stringify(check[0], null, 2));
await sql.end();
