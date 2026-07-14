import postgres from 'postgres';

import { env } from '../env.js';

/**
 * Idempotent startup migrations.
 *
 * Railway only *builds and starts* the service — it never runs `drizzle-kit
 * push`. So a column added to schema.ts (e.g. install_links.github_login) does
 * NOT reach the production database on deploy, and any query touching it fails
 * with "column ... does not exist" until someone pushes by hand (audit #3).
 *
 * This runs additive, `IF NOT EXISTS` DDL at boot so every deploy is
 * self-migrating. Keep entries ADDITIVE and idempotent only — never a
 * destructive or rewriting migration here; those belong in a reviewed,
 * versioned migration path, not an unconditional boot step.
 */
const ADDITIVE_STATEMENTS: string[] = [
  `alter table if exists install_links add column if not exists github_login text`,
];

export async function runStartupMigrations(): Promise<void> {
  // A dedicated short-lived connection: we don't want a failed DDL to wedge the
  // shared query pool, and boot is the only caller.
  const sql = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
  let applied = 0;
  let failed = 0;
  try {
    for (const statement of ADDITIVE_STATEMENTS) {
      try {
        await sql.unsafe(statement);
        applied += 1;
      } catch (err) {
        // Non-fatal: log loudly and keep booting. A missing additive column
        // degrades one feature (analytics labels); it must not take the whole
        // license server — inference, licensing, and webhooks stay up.
        failed += 1;
        console.error(
          `[migrate] statement FAILED (continuing): ${statement}\n  ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    // Report the truth — never claim success for statements that threw (audit #3).
    if (failed > 0) {
      console.error(
        `[migrate] ${applied} applied, ${failed} FAILED — schema readiness NOT guaranteed; features touching the failed columns will 500 until resolved`,
      );
    } else {
      console.log(`[migrate] ${applied} additive migration(s) applied`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
