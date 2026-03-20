import { defineConfig } from 'drizzle-kit';
import os from 'node:os';
import path from 'node:path';

const dataDir = process.env.CORTEX_IDE_DATA_DIR || path.join(os.homedir(), '.cortex-ide');

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.CORTEX_IDE_DB_PATH || path.join(dataDir, 'cortex-ide.db'),
  },
});
