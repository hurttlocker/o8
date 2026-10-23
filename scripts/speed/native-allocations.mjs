#!/usr/bin/env node
// Separate diagnostic launch. Allocation logging never touches an installed app.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root, freePort, launch, sleep, stop, writeJson } from './common.mjs';
import { fixture } from './stack.mjs';
import { allocationSummary } from './allocation-summary.mjs';

const evidence = path.join(root, `tmp/speed-evidence/alloc-${Date.now()}`);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const seeded = fixture(evidence, 1);
const binary = path.join(root, 'src-tauri/target/debug/o8');
const build = JSON.parse(fs.readFileSync(path.join(root, 'tmp/speed-evidence/native-build.json'), 'utf8'));
if (build.identifier !== 'ai.o8.speed-baseline' || build.sha256 !== createHash('sha256').update(fs.readFileSync(binary)).digest('hex')) throw new Error('Use the attested development native build');
const apiPort = await freePort();
let wsPort = await freePort();
while (apiPort === wsPort) wsPort = await freePort();
const env = { ...process.env, O8_PRESHIP_GATE: '1', O8_FORCE_BUNDLED_SERVERS: '1', O8_BOOT_TRACE: '1',
  O8_DATA_DIR: seeded.dataDir, CORTEX_IDE_DATA_DIR: seeded.dataDir,
  CORTEX_IDE_REPO_ROOT: seeded.repoDir, CORTEX_IDE_REVIEW_REPO_ROOT: seeded.repoDir,
  O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort), O8_TAURI_MCP_SOCKET: path.join(evidence, 'a.sock'),
  O8_NODE_BIN: process.execPath, MallocStackLogging: 'lite', MallocStackLoggingDirectory: evidence };
for (const key of ['NODE_OPTIONS', 'O8_BOOT_ID', 'O8_INSTANCE_ID', 'CORTEX_IDE_DB_PATH', 'O8_DEV_FRONTEND_URL', 'CORTEX_IDE_OWNED_CODEX_ROOT', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT']) delete env[key];
const app = launch([], env, path.join(evidence, 'native.log'), binary);
const receipt = { schema: 'o8/speed-native-allocations/v1', measurement: 'Separate boot with malloc stack logging; excluded from latency and soak comparisons', failures: [] };
try {
  while (performance.now() - app.started < 180000) {
    if (app.child.exitCode !== null) throw new Error('Diagnostic native launch exited');
    if (fs.readFileSync(app.logPath, 'utf8').includes('main window created')) break;
    await sleep(200);
  }
  for (const [command, args, file] of [
    ['vmmap', ['-summary', String(app.child.pid)], 'vmmap.private.txt'],
    ['malloc_history', [String(app.child.pid), '-allBySize'], 'malloc-history.private.txt'],
  ]) {
    const tool = launch(args, process.env, path.join(evidence, file), command);
    while (tool.child.exitCode === null && tool.child.signalCode === null && performance.now() - tool.started < 300000) await sleep(200);
    if (tool.child.exitCode !== 0) { await stop(tool); throw new Error(`${command} unavailable or exceeded 300 seconds`); }
  }
  receipt.allocations = await allocationSummary(path.join(evidence, 'malloc-history.private.txt'));
  receipt.captured = true;
} catch (error) { receipt.failures.push(error.message); }
finally { await stop(app); }
writeJson(path.join(root, 'tmp/speed-evidence/native-allocations.json'), receipt);
process.stdout.write(JSON.stringify(receipt) + '\n');
