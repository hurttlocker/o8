export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getDb, getDbPath } from '@/lib/db/index';
import { users, usageLogs, apiKeys, subscriptions, sessions, teams, teamMembers, waitlist } from '@/lib/db/schema';
import { sql } from 'drizzle-orm';

/**
 * GET /api/v2/db/status
 *
 * Database health check — verifies connection, tables, and counts.
 * This is a dev/admin endpoint (will be protected behind auth later).
 */
export async function GET() {
  try {
    const db = getDb();
    if (!db) {
      return NextResponse.json({ status: 'unavailable', message: 'Database module not loaded' });
    }

    // Count rows in each table
    const counts = {
      users: db.select({ count: sql<number>`COUNT(*)` }).from(users).get()?.count ?? 0,
      apiKeys: db.select({ count: sql<number>`COUNT(*)` }).from(apiKeys).get()?.count ?? 0,
      usageLogs: db.select({ count: sql<number>`COUNT(*)` }).from(usageLogs).get()?.count ?? 0,
      subscriptions: db.select({ count: sql<number>`COUNT(*)` }).from(subscriptions).get()?.count ?? 0,
      sessions: db.select({ count: sql<number>`COUNT(*)` }).from(sessions).get()?.count ?? 0,
      teams: db.select({ count: sql<number>`COUNT(*)` }).from(teams).get()?.count ?? 0,
      teamMembers: db.select({ count: sql<number>`COUNT(*)` }).from(teamMembers).get()?.count ?? 0,
      waitlist: db.select({ count: sql<number>`COUNT(*)` }).from(waitlist).get()?.count ?? 0,
    };

    return NextResponse.json({
      ok: true,
      dbPath: getDbPath(),
      tables: counts,
      totalTables: Object.keys(counts).length,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Database connection failed' },
      { status: 500 },
    );
  }
}
