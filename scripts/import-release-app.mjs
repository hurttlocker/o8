#!/usr/bin/env node
import { importRemoteReleaseApp } from './lib/remote-release-app.mjs';

try {
  if (process.argv.length !== 2) throw new Error('import-release-app accepts only O8_RELEASE_APP_HANDOFF');
  const manifestPath = process.env.O8_RELEASE_APP_HANDOFF?.trim();
  if (!manifestPath) throw new Error('O8_RELEASE_APP_HANDOFF is required');
  const result = importRemoteReleaseApp({ root: process.cwd(), manifestPath });
  console.log(`[release-app-import] verified ${result.receipt.bundleSha256}`);
  console.log(`[release-app-import] receipt ${result.receiptPath}`);
} catch (error) {
  console.error(`[release-app-import] refused: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
