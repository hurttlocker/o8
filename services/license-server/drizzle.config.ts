import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — powers `npm run db:push`, which pushes the schema in
 * src/db/schema.ts straight to the DATABASE_URL Postgres (no migration files).
 * For an initial Railway deploy this is the fastest path to a ready schema.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
