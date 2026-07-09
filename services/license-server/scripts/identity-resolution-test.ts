/**
 * IDENTITY RESOLUTION TEST (#1519) — the GitHub-account fallback + one-way
 * clerkUserId migration.
 *
 * Exercises `resolveAndMigrateByGithub` (the pure core in src/identity-core.ts)
 * against in-memory fakes. The Clerk Backend API client wrapper is the single
 * mock boundary — a fake `ClerkBackendClient` returns a canned GitHub account,
 * so no env / DB / network is needed (same self-contained shape as
 * scripts/contract-test.ts).
 *
 * Run:  npm run identity-test   (or: tsx scripts/identity-resolution-test.ts)
 */
import type { ClerkBackendClient, GithubExternalAccount } from '../src/clerk-backend.js';
import {
  resolveAndMigrateByGithub,
  type EntitlementRowRef,
  type IdentityStore,
} from '../src/identity-core.js';

let failed = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) {
    console.log(`  PASS: ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}

/** Fake Clerk client — resolves the given map of clerkUserId → GitHub account. */
function fakeClerk(map: Record<string, GithubExternalAccount | null>): ClerkBackendClient {
  return {
    async resolveGithubAccount(clerkUserId: string) {
      return map[clerkUserId] ?? null;
    },
  };
}

/** In-memory IdentityStore over a small row set; records migrate() calls. */
function memStore(rows: {
  subscriptions?: Array<{ id: string; githubAccountId: string; clerkUserId: string | null }>;
  founders?: Array<{ id: string; githubAccountId: string; clerkUserId: string | null }>;
}) {
  const subs = rows.subscriptions ?? [];
  const founders = rows.founders ?? [];
  const migrations: Array<{ ref: EntitlementRowRef; newClerkUserId: string }> = [];
  const store: IdentityStore = {
    async findSubscriptionByGithubAccountId(githubAccountId) {
      const r = subs.find((s) => s.githubAccountId === githubAccountId);
      return r ? { kind: 'subscription', id: r.id, clerkUserId: r.clerkUserId } : null;
    },
    async findFounderByGithubAccountId(githubAccountId) {
      const r = founders.find((f) => f.githubAccountId === githubAccountId);
      return r ? { kind: 'founder', id: r.id, clerkUserId: r.clerkUserId } : null;
    },
    async migrateClerkUserId(ref, newClerkUserId) {
      migrations.push({ ref, newClerkUserId });
      const pool = ref.kind === 'subscription' ? subs : founders;
      const row = pool.find((x) => x.id === ref.id);
      if (row) row.clerkUserId = newClerkUserId; // reflect the write like the DB would
    },
  };
  return { store, migrations, subs, founders };
}

const gh = (id: string, login: string | null = null): GithubExternalAccount => ({
  githubAccountId: id,
  githubLogin: login,
});

async function main() {
  console.log('\n[identity-test] GitHub-account fallback + clerkUserId migration\n');

  // 1) Founder stranded on a duplicate Clerk user — the core case.
  {
    const { store, migrations, founders } = memStore({
      founders: [{ id: 'cs_1', githubAccountId: '583231', clerkUserId: 'user_OLD' }],
    });
    const clerk = fakeClerk({ user_NEW: gh('583231', 'octocat') });
    const result = await resolveAndMigrateByGithub('user_NEW', clerk, store);
    assert(result?.kind === 'founder', 'founder match resolved via GitHub id');
    assert(result?.migrated === true, 'migration performed');
    assert(result?.oldClerkUserId === 'user_OLD', 'old clerkUserId reported for the audit log');
    assert(migrations.length === 1 && migrations[0]!.newClerkUserId === 'user_NEW', 'migrate called with the caller id');
    assert(founders[0]!.clerkUserId === 'user_NEW', 'row clerkUserId rewritten to the caller (one-way)');
  }

  // 2) Subscription wins over founder when both key on the same GitHub id.
  {
    const { store, migrations } = memStore({
      subscriptions: [{ id: 'sub_1', githubAccountId: '999', clerkUserId: 'user_OLD_SUB' }],
      founders: [{ id: 'cs_2', githubAccountId: '999', clerkUserId: 'user_OLD_F' }],
    });
    const clerk = fakeClerk({ user_NEW: gh('999') });
    const result = await resolveAndMigrateByGithub('user_NEW', clerk, store);
    assert(result?.kind === 'subscription', 'subscription takes priority over founder');
    assert(migrations[0]?.ref.kind === 'subscription', 'the subscription row is the one migrated');
  }

  // 3) No GitHub account resolves (e.g. CLERK_SECRET_KEY unset → wrapper returns null).
  {
    const { store, migrations } = memStore({
      founders: [{ id: 'cs_3', githubAccountId: '583231', clerkUserId: 'user_OLD' }],
    });
    const clerk = fakeClerk({}); // caller has no resolvable GitHub account
    const result = await resolveAndMigrateByGithub('user_NEW', clerk, store);
    assert(result === null, 'no GitHub account → no match, no migration (safe no-op)');
    assert(migrations.length === 0, 'migrate never called when GitHub is unresolved');
  }

  // 4) GitHub resolves but no row matches → null, no migration.
  {
    const { store, migrations } = memStore({
      founders: [{ id: 'cs_4', githubAccountId: '111', clerkUserId: 'user_OLD' }],
    });
    const clerk = fakeClerk({ user_NEW: gh('222') }); // different account
    const result = await resolveAndMigrateByGithub('user_NEW', clerk, store);
    assert(result === null, 'GitHub resolved but no matching row → null');
    assert(migrations.length === 0, 'no migration when nothing matches');
  }

  // 5) Row already on the caller's id (idempotent re-entry) → honored, no rewrite.
  {
    const { store, migrations } = memStore({
      founders: [{ id: 'cs_5', githubAccountId: '583231', clerkUserId: 'user_NEW' }],
    });
    const clerk = fakeClerk({ user_NEW: gh('583231') });
    const result = await resolveAndMigrateByGithub('user_NEW', clerk, store);
    assert(result?.kind === 'founder' && result.migrated === false, 'already-caller id honored without a redundant write');
    assert(migrations.length === 0, 'no migrate call when the id already matches');
  }

  if (failed > 0) {
    console.error(`\n[identity-test] ${failed} assertion(s) FAILED\n`);
    process.exit(1);
  }
  console.log('\n[identity-test] OK — GitHub fallback resolution + migration verified.\n');
}

main().catch((err) => {
  console.error('[identity-test] ERROR:', err);
  process.exit(1);
});
