import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '../env.js';
import * as schema from './schema.js';

/**
 * Postgres connection + Drizzle client. A single shared pool for the process.
 *
 * `prepare: false` is the safe default for poolers (Railway's Postgres works
 * fine either way, but this keeps it compatible if a PgBouncer-style pooler is
 * put in front later).
 */
const queryClient = postgres(env.DATABASE_URL, { prepare: false });

export const db = drizzle(queryClient, { schema });

export { schema };
