#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokePackagedServer } from './lib/packaged-server-smoke.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = process.argv[2] ? resolve(process.argv[2]) : join(root, 'out', 'server');
try {
  const result = await smokePackagedServer(server, {
    supervised: process.env.O8_BUILD_SUPERVISED === '1',
  });
  console.log(`Packaged server identity OK (version ${result.version})`);
} catch (error) {
  console.error(`Packaged server smoke failed: ${error.message}`);
  process.exitCode = 1;
}
