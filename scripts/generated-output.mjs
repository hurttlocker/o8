#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const child = spawn(process.execPath, [
  '--import', fileURLToPath(new URL('./register-server-only-stub.mjs', import.meta.url)),
  '--import', require.resolve('tsx'),
  fileURLToPath(new URL('./generated-output.ts', import.meta.url)), ...process.argv.slice(2),
], { cwd: process.cwd(), stdio: 'inherit', env: { ...process.env,
  TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url)),
} });
const interrupt = () => child.kill('SIGINT');
const terminate = () => child.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.once('close', code => {
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  process.exitCode = code ?? 1;
});
