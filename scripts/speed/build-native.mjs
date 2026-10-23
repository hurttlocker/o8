#!/usr/bin/env node
// Local, unsigned development artifact only. No app installation or launch.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { root, writeJson } from './common.mjs';
import { instrumentNativeLoader } from './native-paint.mjs';

if (!fs.existsSync(path.join(root, '.next/standalone/server.js'))) throw new Error('Build this worktree with npm run build first');
const evidence = path.join(root, 'tmp/speed-evidence');
fs.mkdirSync(evidence, { recursive: true });
const run = (command, args, env, file) => new Promise((resolve, reject) => {
  const fd = fs.openSync(path.join(evidence, file), 'w', 0o600);
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}; see private ${file}`)));
});
const started = performance.now();
if (!process.argv.includes('--reuse-export')) await run(process.execPath, ['scripts/tauri-export.mjs'], {
  ...process.env, O8_NATIVE_BUNDLE_CACHE_DIR: path.join(evidence, 'native-cache'), APPLE_SIGNING_IDENTITY: '-',
}, 'native-export.log');
instrumentNativeLoader(path.join(root, 'out/frontend/index.html'));
await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--features', 'tauri/custom-protocol,dev-mcp-plugin'], {
  ...process.env, TAURI_CONFIG: JSON.stringify({ identifier: 'ai.o8.speed-baseline', productName: 'o8 Speed Baseline', bundle: { externalBin: [] } }),
}, 'native-build.log');
const server = path.join(root, 'src-tauri/target/debug/server');
if (!fs.existsSync(server)) fs.symlinkSync(path.relative(path.dirname(server), path.join(root, 'out/server')), server, 'dir');
const receipt = { schema: 'o8/speed-native-build/v1', durationMs: performance.now() - started,
  binary: 'src-tauri/target/debug/o8', profile: 'debug custom protocol', optionalSpeechHelpers: false, signing: 'ad hoc dependency signatures only', installed: false };
receipt.identifier = 'ai.o8.speed-baseline';
receipt.paintProbe = true;
receipt.sha256 = createHash('sha256').update(fs.readFileSync(path.join(root, receipt.binary))).digest('hex');
writeJson(path.join(evidence, 'native-build.json'), receipt);
process.stdout.write(JSON.stringify(receipt) + '\n');
