// Disposable session workload. Raw logs/snapshots stay in work/; receipts contain no paths.
// Production: npm run build, then node scripts/bench/session-memory.mjs
//   --standalone --sessions=96 --transcript-mib=4 --output=work/session-memory
// Add --snapshots for a separate diagnostic run; RSS is sampled before snapshots.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { freePort, healthy, launch, root, sleep, stop, writeJson } from '../speed/common.mjs';
import { inspector, postGc, summarizeHeap } from '../speed/memory.mjs';
import { retainedOwners } from './standalone-heap.mjs';

const mib = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function memory(usage) {
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']
    .map(key => [`${key}MiB`, mib(usage[key])]));
}

export async function bundleWs(outfile) {
  const require = createRequire(import.meta.url);
  // Same ESM format, native externals and server-only shim as the existing WS probe.
  await build({
    entryPoints: ['src/ws-server.ts'], outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { 'server-only': path.join(root, 'scripts/server-only-stub.js') },
    // The CI fixture can live outside the checkout. Resolve native externals
    // against the installed repository dependencies instead of its temp parent.
    plugins: [{ name: 'fixture-native-externals', setup(builder) {
      builder.onResolve({ filter: /^(node-pty|better-sqlite3|bindings)$/ }, args => (
        { path: require.resolve(args.path), external: true }
      ));
    } }],
    banner: { js: [
      'import {createRequire as __o8_require} from "node:module";',
      'import {fileURLToPath as __o8_path} from "node:url";',
      'import {dirname as __o8_dir} from "node:path";',
      `const require=__o8_require(${JSON.stringify(path.join(root, 'package.json'))});`,
      'const __filename=__o8_path(import.meta.url);const __dirname=__o8_dir(__filename);',
    ].join('') },
    logLevel: 'silent',
  });
}

async function openAndCloseSession(wsPort, token, sessionKey) {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session bootstrap deadline exceeded')), 30_000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('open', () => socket.send(JSON.stringify({ type: 'realtime-subscribe',
        subscriptions: [{ stream: `session:${sessionKey}` }] })));
      socket.on('message', raw => {
        const frame = JSON.parse(String(raw));
        const events = frame.data?.events ?? [];
        const history = events.find(event => event.event === 'history.snapshot' && event.data?.sessionKey === sessionKey);
        if (!history) return;
        clearTimeout(timer);
        try {
          assert.equal(history.data.entries.length, 32, 'WS must deliver every fixture row');
          assert(history.data.entries.at(-1).text.startsWith('fixture-output-31:'), 'WS transcript payload missing');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    await new Promise(resolve => { socket.once('close', resolve); socket.close(); });
  } finally {
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.terminate();
  }
}

export async function measureSessionMemory({ output, sessions = 12, transcriptMiB = 4,
  standalone = false, snapshots = false, settleMs = 3000, wsBundle } = {}) {
  assert(Number.isSafeInteger(sessions) && sessions > 0 && sessions <= 500);
  assert(Number.isFinite(transcriptMiB) && transcriptMiB > 0 && transcriptMiB <= 16);
  fs.mkdirSync(output, { recursive: true });
  assert(!fs.existsSync(path.join(output, 'next.log')), 'Use a fresh evidence directory');
  fs.writeFileSync(path.join(output, '.gitignore'), '*\n');
  const fixture = fs.mkdtempSync(path.join(output, 'fixture-'));
  const data = path.join(fixture, 'data');
  const repo = path.join(fixture, 'repo');
  fs.mkdirSync(path.join(data, 'chat-history'), { recursive: true });
  fs.mkdirSync(repo);
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(data, 'ws-token'), token, { mode: 0o600 });
  const apiPort = await freePort(), wsPort = await freePort();
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: String(apiPort), O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_PACKAGED_APP: '1',
    O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'),
    CORTEX_IDE_REPO_ROOT: repo, CORTEX_IDE_REVIEW_REPO_ROOT: repo,
    CODEX_HOME: path.join(fixture, 'codex-profile'), CLAUDE_CONFIG_DIR: path.join(fixture, 'claude-profile'),
  };
  for (const key of ['CORTEX_IDE_OWNED_CODEX_ROOT', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
    'O8_OWNED_GEMINI_ROOT', 'O8_OWNED_OPENCODE_ROOT', 'O8_OWNED_CURSOR_ROOT', 'O8_OWNED_GROK_ROOT',
    'O8_OWNED_PI_ROOT', 'O8_OWNED_PI_BUILTIN_ROOT', 'O8_OWNED_PRIME_AGENT_ROOT',
    'O8_OWNED_DEEPSEEK_HARNESS_ROOT', 'O8_OWNED_HERMES_ROOT']) env[key] = path.join(data, key.toLowerCase());
  const wsEntry = wsBundle ?? path.join(fixture, 'ws-server.mjs');
  if (!wsBundle) await bundleWs(wsEntry);
  const nextArgs = standalone ? [path.join(root, '.next/standalone/server.js')]
    : ['--import', path.join(root, 'scripts/register-server-only-stub.mjs'), '--import', 'tsx',
      path.join(root, 'scripts/bench/session-memory-route-host.ts')];
  const processes = {}, clients = {};
  const origin = `http://127.0.0.1:${apiPort}`;
  const read = async route => {
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200, `HTTP fixture rejected ${route.split('?')[0]}`);
    return response.json();
  };
  try {
    processes.next = launch(['--inspect=127.0.0.1:0', ...nextArgs], env, path.join(output, 'next.log'));
    await healthy(`${origin}/api/mobile/orchestrator/threads`, processes.next, token);
    processes.ws = launch(['--inspect=127.0.0.1:0', wsEntry], env, path.join(output, 'ws.log'));
    await healthy(`http://127.0.0.1:${wsPort}/health`, processes.ws, token);
    for (const name of ['next', 'ws']) clients[name] = await inspector(processes[name]);
    // Warm the exact HTTP modules against an empty store before establishing baseline.
    await read('/api/mobile/orchestrator/threads');
    await read('/api/mobile/history?sessionKey=llm-chat:thoughts-empty');
    await sleep(settleMs);
    const idle = {};
    for (const name of ['next', 'ws']) idle[name] = memory(await postGc(clients[name]));
    const files = [];
    const transcriptDigest = createHash('sha256');
    let payloadUtf8Bytes = 0;
    for (let index = 0; index < sessions; index++) {
      const id = `thoughts-memory-${index}`;
      const messages = Array.from({ length: 32 }, (_, row) => {
        const pattern = `${index}-${row}-transcript `;
        const length = Math.floor(transcriptMiB * 1024 * 1024 / 32);
        const content = `fixture-output-${row}:` + pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
        payloadUtf8Bytes += Buffer.byteLength(content);
        return { id: `entry-${index}-${row}`, role: row % 2 ? 'assistant' : 'user', content,
          timestamp: 1790812800000 + row * 10_000 };
      });
      transcriptDigest.update(JSON.stringify(messages));
      const file = path.join(data, 'chat-history', `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ id, title: `Memory fixture ${index}`, messages,
        repoPath: repo, backend: 'claude', model: 'claude-code', savedAt: '2026-10-01T01:00:00.000Z',
        orchestratorVisible: true }));
      files.push({ id, file, hash: digest(file) });
    }
    const listed = await read(`/api/mobile/orchestrator/threads?limit=${sessions}`);
    assert.equal(listed.threads.length, sessions, 'Every persisted session must be discoverable');
    let completedSessions = 0;
    for (const { id } of files) {
      const history = await read(`/api/mobile/history?sessionKey=llm-chat:${id}&limit=200`);
      assert.equal(history.transcript.length, 32, 'HTTP must deliver every fixture row');
      assert(history.transcript.at(-1).text.startsWith('fixture-output-31:'), 'HTTP transcript payload missing');
      await openAndCloseSession(wsPort, token, `llm-chat:${id}`);
      completedSessions++;
    }
    await sleep(settleMs);
    const after = {};
    for (const name of ['next', 'ws']) after[name] = memory(await postGc(clients[name]));
    const receipt = { schema: 'o8/session-idle-memory/v1', node: process.version, platform: process.platform,
      entry: standalone ? 'Next standalone + ws-server bundle' : 'production route handlers + ws-server bundle',
      sessions, transcriptMiB, payloadUtf8Bytes, transcriptDigest: transcriptDigest.digest('hex'),
      completedSessions, settleMs, idle, after,
      persistedOutputUnchanged: files.every(({ file, hash }) => digest(file) === hash),
      budgets: { postActivityHeapMiBPerProcess: 96, retainedHeapGrowthMiBPerProcess: 24 },
    };
    // Finish both RSS checkpoints before either process takes a snapshot.
    if (snapshots) {
      receipt.heaps = {};
      for (const name of ['next', 'ws']) {
        const file = path.join(output, `${name}-after.heapsnapshot`);
        await clients[name].snapshot(file);
        receipt.heaps[name] = { shallow: summarizeHeap(file), retained: retainedOwners(file) };
      }
    }
    writeJson(path.join(output, 'receipt.json'), receipt);
    return receipt;
  } finally {
    for (const client of Object.values(clients)) client.close();
    for (const owned of Object.values(processes)) await stop(owned);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }));
  const receipt = await measureSessionMemory({ output: path.resolve(String(args.output ?? 'work/session-memory')),
    standalone: Boolean(args.standalone), snapshots: Boolean(args.snapshots),
    wsBundle: args['ws-bundle'] ? path.resolve(String(args['ws-bundle'])) : undefined,
    sessions: Number(args.sessions ?? 96), transcriptMiB: Number(args['transcript-mib'] ?? 4) });
  console.log(JSON.stringify(receipt));
  if (args.check) for (const name of ['next', 'ws']) {
    assert(receipt.after[name].heapUsedMiB < 96, `${name} post-activity idle heap exceeds 96 MiB`);
    assert(receipt.after[name].heapUsedMiB - receipt.idle[name].heapUsedMiB < 24,
      `${name} retained heap growth exceeds 24 MiB`);
  }
}
